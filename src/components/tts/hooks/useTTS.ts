import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { IBookRenderer } from '../../../services/formats/types';
import type { TTSState } from '../../../services/tts/types';
import { TTSSession } from '../../../services/tts/TTSSession';
import type { ITTSClient } from '../../../services/tts/TTSClient';
import { NativeTTSClient } from '../../../services/tts/NativeTTSClient';
import type {
  IBackendSessionDriver,
  TTSContentProvider,
} from '../../../services/tts/providers/TTSContentProvider';
import { log, logError, getReaderSettings, saveReaderSettings } from '../../../services';
import { coverService } from '../../../services/cover';
import { ensureNotificationPermission } from '../../../utils/notificationPermission';
import { isAndroid } from '../../../utils/platform';
import { TTS_RATE_DEFAULT } from '../../../constants/tts';
import { createTTSClient, type TTSFailReason } from './createTTSClient';

/** 通知文案更新的最小间隔（毫秒）：避免逐句 notify 过于频繁 */
const NOTIFICATION_TEXT_MIN_INTERVAL_MS = 2000;
/** 通知正文最大长度：超出部分截断，避免系统截断位置不可控 */
const NOTIFICATION_TEXT_MAX_LENGTH = 120;

/** 非阻塞警告（由 Reader 层转成 toast） */
export type TTSWarningKey = 'listenBackgroundServiceFailed';

/** 操作锁状态 */
type ToggleLock = 'idle' | 'stopping' | 'starting';

type SessionDriverClient = ITTSClient & {
  createSessionDriver: () => IBackendSessionDriver;
};

interface PlayResult {
  success: boolean;
  failReason?: TTSFailReason;
  action?: 'stop';
  /** 通知权限被拒绝（仅提示用，不影响朗读） */
  notificationPermissionDenied?: boolean;
}

interface UseTTSOptions {
  rendererRef: React.MutableRefObject<IBookRenderer | null>;
  listenSupported: boolean;
  onReadingActivity?: () => void;
  /** 通知标题（书名），仅 Android 原生媒体通知使用 */
  notificationTitle?: string;
  /** 通知副标题（章节名） */
  notificationSubtitle?: string;
  /** 书籍 id，用于解析封面作为通知大图标 */
  notificationBookId?: number;
  /** 非阻塞警告回调（例如后台保活服务启动失败） */
  onWarning?: (key: TTSWarningKey) => void;
}

interface UseTTSReturn {
  state: TTSState;
  isPlaying: boolean;
  isActive: boolean;
  toggle: () => Promise<PlayResult | void>;
  stop: () => Promise<void>;
  /** 先回写朗读位置再停止（供模式切换等场景保持进度连续） */
  stopAndRestorePosition: () => Promise<void>;
  notifyDocumentUpdated: () => Promise<void>;
}

/** 构造合适的 driver：NativeTTSClient / WebSpeechClient 等支持会话协议的 client */
function buildDriver(client: ITTSClient): IBackendSessionDriver | null {
  const maybeClient = client as Partial<SessionDriverClient>;
  if (typeof maybeClient.createSessionDriver !== 'function') return null;
  return maybeClient.createSessionDriver();
}

/**
 * TTS 状态管理 Hook
 * 基于 TTSSession + Provider，所有格式以统一会话协议工作
 */
export const useTTS = ({
  rendererRef,
  listenSupported,
  onReadingActivity,
  notificationTitle,
  notificationSubtitle,
  notificationBookId,
  onWarning,
}: UseTTSOptions): UseTTSReturn => {
  const [state, setState] = useState<TTSState>('stopped');
  const sessionRef = useRef<TTSSession | null>(null);
  const clientRef = useRef<ITTSClient | null>(null);
  const lockRef = useRef<ToggleLock>('idle');
  /** 启动过程中收到停止请求时置为 true，启动完成后自动 shutdown */
  const pendingStopRef = useRef(false);

  // ---- 媒体通知相关状态（仅 Android native 模式使用） ----
  const stateRef = useRef<TTSState>('stopped');
  const notificationTitleRef = useRef(notificationTitle ?? '');
  const notificationSubtitleRef = useRef(notificationSubtitle ?? '');
  const notificationBookIdRef = useRef<number | undefined>(notificationBookId);
  /** 当前朗读句文本（来自会话高亮 Range） */
  const narrationTextRef = useRef('');
  /** 封面路径（本地路径或 data URL），仅用于通知大图标 */
  const coverPathRef = useRef<string | undefined>(undefined);
  /** 封面是否需要随下一次通知更新一起下发 */
  const coverDirtyRef = useRef(false);
  const lastNotificationPushRef = useRef(0);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWarningRef = useRef(onWarning);

  const isActive = state !== 'stopped';

  useEffect(() => {
    notificationTitleRef.current = notificationTitle ?? '';
  }, [notificationTitle]);

  useEffect(() => {
    notificationSubtitleRef.current = notificationSubtitle ?? '';
  }, [notificationSubtitle]);

  useEffect(() => {
    notificationBookIdRef.current = notificationBookId;
  }, [notificationBookId]);

  useEffect(() => {
    onWarningRef.current = onWarning;
  }, [onWarning]);

  /** 清理通知节流定时器（卸载时） */
  useEffect(() => {
    return () => {
      if (notificationTimerRef.current !== null) {
        clearTimeout(notificationTimerRef.current);
        notificationTimerRef.current = null;
      }
    };
  }, []);

  const releaseActiveTTS = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    const client = clientRef.current;
    sessionRef.current = null;
    clientRef.current = null;

    // 清理待发送的通知更新，避免停止后还向已释放的 client 推送
    if (notificationTimerRef.current !== null) {
      clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }

    if (session) {
      await session.shutdown().catch(() => {});
    }
    if (client) {
      await client.shutdown().catch(() => {});
    }
    stateRef.current = 'stopped';
    setState('stopped');
  }, []);

  /** 组装通知正文：章节名 · 当前句（超长截断） */
  const buildNotificationText = useCallback((): string | undefined => {
    const subtitle = notificationSubtitleRef.current.trim();
    const sentence = narrationTextRef.current.trim();
    const base = subtitle && sentence ? `${subtitle} · ${sentence}` : sentence || subtitle;
    if (!base) return undefined;
    return base.length > NOTIFICATION_TEXT_MAX_LENGTH
      ? `${base.slice(0, NOTIFICATION_TEXT_MAX_LENGTH)}…`
      : base;
  }, []);

  /** 把当前播放态/文案/封面推送到原生媒体通知（封面只随变更下发一次） */
  const pushPlaybackState = useCallback((next: TTSState) => {
    const client = clientRef.current;
    if (!(client instanceof NativeTTSClient)) return;
    const largeIconPath = coverDirtyRef.current ? coverPathRef.current : undefined;
    coverDirtyRef.current = false;
    void client.setPlaybackState(
      next,
      notificationTitleRef.current || undefined,
      buildNotificationText(),
      largeIconPath,
    );
  }, [buildNotificationText]);

  /** 逐句更新做节流：最多每 2s 刷新一次通知，并在尾随补发最新句 */
  const scheduleNotificationPush = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastNotificationPushRef.current;
    if (elapsed >= NOTIFICATION_TEXT_MIN_INTERVAL_MS) {
      lastNotificationPushRef.current = now;
      pushPlaybackState(stateRef.current);
      return;
    }
    if (notificationTimerRef.current !== null) return;
    notificationTimerRef.current = setTimeout(() => {
      notificationTimerRef.current = null;
      lastNotificationPushRef.current = Date.now();
      pushPlaybackState(stateRef.current);
    }, NOTIFICATION_TEXT_MIN_INTERVAL_MS - elapsed);
  }, [pushPlaybackState]);

  /** 解析封面作为通知大图标（仅一次；失败不影响朗读） */
  const resolveNotificationCover = useCallback(async () => {
    const bookId = notificationBookIdRef.current;
    if (bookId == null) return;
    try {
      const url = await coverService.getCoverUrl(bookId);
      if (!url) return;
      coverPathRef.current = url;
      coverDirtyRef.current = true;
      // 封面解好时补一次推送，不必等下一句
      scheduleNotificationPush();
    } catch (e) {
      logError('[TTS] 解析封面失败', e);
    }
  }, [scheduleNotificationPush]);

  /** 当前朗读句变化（来自会话高亮），用于媒体通知动态文案 */
  const handleNarration = useCallback((text: string) => {
    narrationTextRef.current = text;
    if (stateRef.current !== 'playing') return;
    scheduleNotificationPush();
  }, [scheduleNotificationPush]);

  /**
   * 会话状态变化：更新 React 状态，并同步到原生媒体通知（仅 native 插件模式）。
   * 以会话状态为唯一数据源，Service 只负责渲染，避免通知按钮与实际朗读状态不一致。
   */
  const handleSessionState = useCallback((next: TTSState) => {
    setState(next);
    stateRef.current = next;
    // 状态变化立即推送（丢弃节流中的待发送，避免旧状态覆盖新状态）
    if (notificationTimerRef.current !== null) {
      clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
    lastNotificationPushRef.current = Date.now();
    pushPlaybackState(next);
  }, [pushPlaybackState]);

  // 通知权限刚被授予时重发一次状态：补上此前被系统丢弃的通知
  useEffect(() => {
    const handlePermissionResult = (event: Event) => {
      const granted = (event as CustomEvent<{ granted?: boolean }>).detail?.granted;
      if (!granted) return;
      pushPlaybackState(stateRef.current);
    };
    window.addEventListener('notificationPermissionResult', handlePermissionResult);
    return () => window.removeEventListener('notificationPermissionResult', handlePermissionResult);
  }, [pushPlaybackState]);

  useEffect(() => {
    return () => {
      void releaseActiveTTS();
    };
  }, [releaseActiveTTS]);

  const toggle = useCallback(async (): Promise<PlayResult | void> => {
    if (lockRef.current === 'stopping') {
      log('[TTS] toggle 被拦截：正在停止中', 'warn');
      return;
    }

    if (lockRef.current === 'starting') {
      pendingStopRef.current = true;
      await releaseActiveTTS();
      return;
    }

    const session = sessionRef.current;
    if (session) {
      lockRef.current = 'stopping';
      try {
        await releaseActiveTTS();
      } finally {
        lockRef.current = 'idle';
      }
      return { success: true, action: 'stop' as const };
    }

    if (!listenSupported || !rendererRef.current) {
      return { success: false, failReason: 'listenFailedNoContent' };
    }
    const renderer = rendererRef.current;
    if (typeof renderer.createTTSContentProvider !== 'function') {
      return { success: false, failReason: 'listenFailedNoContent' };
    }
    const provider: TTSContentProvider | null = renderer.createTTSContentProvider();
    if (!provider) {
      return { success: false, failReason: 'listenFailedNoContent' };
    }

    lockRef.current = 'starting';
    pendingStopRef.current = false;
    log('[TTS] toggle → 开启听书', 'info');
    try {
      // 通知权限：Android 13+ 的前台服务通知依赖该权限；仅做“尽力申请”，
      // 被拒绝时继续朗读，由上层给出非阻塞提示
      const notificationPermissionGranted = await ensureNotificationPermission();
      let readerSettings = getReaderSettings();
      const { client, failReason } = await createTTSClient(readerSettings.ttsPreferredEngine);

      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        if (client) await client.shutdown();
        setState('stopped');
        return { success: true, action: 'stop' as const };
      }

      if (!client) {
        log(`[TTS] 无可用TTS客户端 failReason=${failReason}`, 'warn');
        return { success: false, failReason };
      }
      clientRef.current = client;

      if (client instanceof NativeTTSClient) {
        // 新会话：重置逐句文案与封面下发标记
        narrationTextRef.current = '';
        coverDirtyRef.current = false;
        if (isAndroid()) void resolveNotificationCover();
        const info = client.getInitInfo();
        if (info.defaultEngine) {
          const prevEngine = readerSettings.ttsNativeDefaultEngine;
          if (prevEngine && prevEngine !== info.defaultEngine) {
            log(
              `[TTS] 系统默认 TTS 引擎已变更: ${prevEngine} -> ${info.defaultEngine}`,
              'warn',
            );
            const nextVoiceByEngine = {
              ...(readerSettings.ttsVoiceByEngine || {}),
              'native-tts': 'default',
            };
            readerSettings = saveReaderSettings({
              ttsNativeDefaultEngine: info.defaultEngine,
              ttsVoiceByEngine: nextVoiceByEngine,
            });
            client.setVoice('default');
          } else if (!prevEngine) {
            readerSettings = saveReaderSettings({ ttsNativeDefaultEngine: info.defaultEngine });
          }
        }
      }

      const ttsRate = readerSettings.ttsRate ?? TTS_RATE_DEFAULT;
      client.setRate(ttsRate);
      const voiceId = readerSettings.ttsVoiceByEngine?.[client.name];
      if (voiceId) client.setVoice(voiceId);
      const effectiveVoiceId = client.getVoiceId();
      log(
        `[TTS] 启动参数 engine=${client.name} voiceId=${voiceId ?? ''} effectiveVoiceId=${effectiveVoiceId || 'default'} rate=${ttsRate}`,
        'info',
      );
      if (voiceId && voiceId !== 'default') {
        const exists = (client.getVoices() || []).some((v) => v.id === voiceId);
        if (!exists) {
          log(`[TTS] voiceId=${voiceId} 不存在，回退默认`, 'warn');
          client.setVoice('default');
          saveReaderSettings({
            ttsVoiceByEngine: {
              ...(readerSettings.ttsVoiceByEngine || {}),
              [client.name]: 'default',
            },
          });
        }
      }

      const driver = buildDriver(client);
      if (!driver) {
        log('[TTS] 当前 client 无可用 session driver', 'warn');
        await releaseActiveTTS();
        return { success: false, failReason: 'listenFailedUnknown' };
      }

      const newSession = new TTSSession(
        provider,
        driver,
        handleSessionState,
        onReadingActivity,
        () => {
          if (sessionRef.current !== newSession) return;
          void releaseActiveTTS();
        },
        {
          onNarration: handleNarration,
          // 后台保活失败不影响朗读，只提示用户“后台可能没有通知”
          onBackgroundServiceError: () => onWarningRef.current?.('listenBackgroundServiceFailed'),
        },
      );
      sessionRef.current = newSession;

      const success = await newSession.start({
        rate: ttsRate,
        voiceId: effectiveVoiceId || undefined,
      });

      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        await releaseActiveTTS();
        return { success: true, action: 'stop' as const };
      }

      if (!success) {
        await releaseActiveTTS();
        return { success: false, failReason: 'listenFailedNoContent' };
      }
      return { success: true, notificationPermissionDenied: !notificationPermissionGranted };
    } catch (error) {
      const errMsg = error instanceof Error
        ? `${error.name}: ${error.message}`
        : JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}));
      logError(`[TTS] toggle play 异常: ${errMsg}`, error);
      await releaseActiveTTS();
      return { success: false, failReason: 'listenFailedUnknown' };
    } finally {
      pendingStopRef.current = false;
      lockRef.current = 'idle';
    }
  }, [
    listenSupported,
    rendererRef,
    onReadingActivity,
    releaseActiveTTS,
    handleSessionState,
    handleNarration,
    resolveNotificationCover,
  ]);

  const stop = useCallback(async (): Promise<void> => {
    if (lockRef.current === 'starting' || sessionRef.current || clientRef.current) {
      await toggle();
    }
  }, [toggle]);

  /** 模式切换等场景：先把最后朗读位置写回阅读器，再停止会话 */
  const stopAndRestorePosition = useCallback(async (): Promise<void> => {
    if (lockRef.current === 'starting' || sessionRef.current || clientRef.current) {
      try {
        await sessionRef.current?.restoreReadingPosition();
      } catch (e) {
        logError('[TTS] restoreReadingPosition 失败', e);
      }
      await toggle();
    }
  }, [toggle]);

  const notifyDocumentUpdated = useCallback(async (): Promise<void> => {
    sessionRef.current?.notifyDocumentUpdated();
  }, []);

  const isPlaying = state === 'playing';
  return useMemo(() => ({
    state,
    isPlaying,
    isActive,
    toggle,
    stop,
    stopAndRestorePosition,
    notifyDocumentUpdated,
  }), [state, isPlaying, isActive, toggle, stop, stopAndRestorePosition, notifyDocumentUpdated]);
};

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { IBookRenderer } from '../../../services/formats/types';
import type { ITTSClient } from '../../../services/tts/TTSClient';
import type { TTSState } from '../../../services/tts/types';
import { TTSController } from '../../../services/tts/TTSController';
import { WebSpeechClient } from '../../../services/tts/WebSpeechClient';
import { NativeTTSClient } from '../../../services/tts/NativeTTSClient';
import { log, logError, getReaderSettings, saveReaderSettings } from '../../../services';
import { TTS_RATE_DEFAULT } from '../../../constants/tts';

/** 操作锁状态：idle-空闲 / stopping-关闭中 / starting-开启中 */
type ToggleLock = 'idle' | 'stopping' | 'starting';

/** 听书启动失败的原因 key（对应 i18n） */
export type TTSFailReason =
  | 'listenFailedNoVoice'        // Web Speech 无可用语音
  | 'listenFailedNativeBridge'   // 原生 TTS 桥接不可用（非 Android 或桥接未注册）
  | 'listenFailedNativeInit'     // 原生 TTS 引擎初始化失败（设备无 TTS 引擎）
  | 'listenFailedNoContent'      // 当前页面无可朗读内容
  | 'listenFailedUnknown';       // 未知错误

interface PlayResult {
  success: boolean;
  failReason?: TTSFailReason;
  action?: 'stop';
}

interface UseTTSOptions {
  /** 渲染器引用 */
  rendererRef: React.MutableRefObject<IBookRenderer | null>;
  /** 是否支持听书 */
  listenSupported: boolean;
  onReadingActivity?: () => void;
  onMark?: (mark: string) => void | Promise<void>;
}

interface UseTTSReturn {
  /** 当前 TTS 状态 */
  state: TTSState;
  /** 是否正在播放 */
  isPlaying: boolean;
  /** TTS 是否已激活（正在朗读或暂停中） */
  isActive: boolean;
  /** 切换听书开关，返回结果和失败原因 */
  toggle: () => Promise<PlayResult | void>;
  stop: () => Promise<void>;
  notifyDocumentUpdated: () => Promise<void>;
}

/** 尝试创建并初始化 TTS 客户端，支持优先选择指定引擎 */
async function createTTSClient(
  preferredEngine?: string,
): Promise<{ client: ITTSClient | null; failReason: TTSFailReason }> {
  log(`[TTS] createTTSClient: 开始创建客户端 preferredEngine=${preferredEngine ?? ''}`, 'info');

  const isAndroid = /android/i.test(navigator.userAgent || '');

  const tryWebSpeech = async (allowRemoteVoices: boolean): Promise<ITTSClient | null> => {
    const web = new WebSpeechClient({ allowRemoteVoices });
    const ok = await web.init();
    log(
      `[TTS] WebSpeech(${allowRemoteVoices ? 'any' : 'localOnly'}) init 结果: ${ok}，语音数: ${web.getVoices().length}`,
      'info',
    );
    if (ok) return web;
    await web.shutdown().catch(() => {});
    return null;
  };

  const tryNative = async (): Promise<NativeTTSClient | null> => {
    const native = new NativeTTSClient();
    const ok = await native.init();
    const info = native.getInitInfo();
    log(
      `[TTS] Native init: inited=${ok} mode=${info.mode} status=${info.status} offlineReady=${info.offlineReady}`,
      'info',
    );
    if (ok) return native;
    await native.shutdown().catch(() => {});
    return null;
  };

  if (isAndroid) {
    if (preferredEngine === 'web-speech') {
      const web = await tryWebSpeech(true);
      if (web) return { client: web, failReason: 'listenFailedUnknown' };
    }
    if (preferredEngine === 'native-tts') {
      const native = await tryNative();
      const info = native?.getInitInfo();
      if (native && info?.offlineReady) return { client: native, failReason: 'listenFailedUnknown' };
      await native?.shutdown().catch(() => {});
    }

    const nativeTTS = await tryNative();
    const nativeInfo = nativeTTS?.getInitInfo();
    if (nativeTTS && nativeInfo?.offlineReady) {
      return { client: nativeTTS, failReason: 'listenFailedUnknown' };
    }

    const webSpeechLocal = await tryWebSpeech(false);
    if (webSpeechLocal) {
      await nativeTTS?.shutdown().catch(() => {});
      return { client: webSpeechLocal, failReason: 'listenFailedUnknown' };
    }

    if (
      nativeTTS
      && nativeInfo
      && (nativeInfo.status === 'missing_data' || nativeInfo.status === 'lang_not_supported')
    ) {
      return { client: nativeTTS, failReason: 'listenFailedUnknown' };
    }

    const webSpeechAny = await tryWebSpeech(true);
    if (webSpeechAny) {
      await nativeTTS?.shutdown().catch(() => {});
      return { client: webSpeechAny, failReason: 'listenFailedUnknown' };
    }

    const w = window as any;
    const tauriInvoke = w?.__TAURI__?.core?.invoke || w?.__TAURI__?.invoke;
    if (!NativeTTSClient.isAvailable() && typeof tauriInvoke !== 'function') {
      return { client: null, failReason: 'listenFailedNativeBridge' };
    }

    return { client: null, failReason: 'listenFailedNativeInit' };
  }

  if (preferredEngine === 'native-tts') {
    const native = await tryNative();
    if (native) return { client: native, failReason: 'listenFailedUnknown' };
  }
  if (preferredEngine === 'web-speech') {
    const web = await tryWebSpeech(true);
    if (web) return { client: web, failReason: 'listenFailedUnknown' };
  }

  const webSpeech = await tryWebSpeech(true);
  if (webSpeech) {
    return { client: webSpeech, failReason: 'listenFailedUnknown' };
  }
  log('[TTS] WebSpeech 初始化失败，尝试 NativeTTS...', 'warn');

  // 回落到 Android Native TTS
  if (!NativeTTSClient.isAvailable()) {
        log('[TTS] NativeTTS 桥接不可用', 'warn');
    // 区分平台：Android 上桥接不可用提示"不支持原生语音"，其他平台提示"无可用语音引擎"
    const reason: TTSFailReason = isAndroid ? 'listenFailedNativeBridge' : 'listenFailedNoVoice';
    return { client: null, failReason: reason };
  }

  const nativeTTS = await tryNative();
  if (nativeTTS) return { client: nativeTTS, failReason: 'listenFailedUnknown' };

        log('[TTS] NativeTTS 初始化失败', 'warn');
  return { client: null, failReason: 'listenFailedNativeInit' };
}

/**
 * TTS 状态管理 Hook
 * 连接 UI 层和 TTSController，管理 TTS 生命周期
 */
export const useTTS = ({ rendererRef, listenSupported, onReadingActivity, onMark }: UseTTSOptions): UseTTSReturn => {
  const [state, setState] = useState<TTSState>('stopped');
  const controllerRef = useRef<TTSController | null>(null);
  const lockRef = useRef<ToggleLock>('idle');
  /** 启动过程中收到停止请求时置为 true，启动完成后自动 shutdown */
  const pendingStopRef = useRef(false);

  // 派生状态：只要 state 不是 stopped 就视为激活
  const isActive = state !== 'stopped';

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      controllerRef.current?.shutdown();
      controllerRef.current = null;
    };
  }, []);

  /** 切换听书开关：通过三状态锁（idle/stopping/starting）彻底防重入 */
  const toggle = useCallback(async (): Promise<PlayResult | void> => {
    // 正在停止中，忽略重复请求
    if (lockRef.current === 'stopping') {
      log('[TTS] toggle 被拦截：正在停止中', 'warn');
      return;
    }

    // 正在启动中：标记 pendingStop，如果 controller 已创建则直接中断
    if (lockRef.current === 'starting') {
      pendingStopRef.current = true;
      const ctrl = controllerRef.current;
      if (ctrl) {
        log('[TTS] toggle：启动中收到停止请求，controller 已存在，直接 shutdown', 'info');
        controllerRef.current = null;
        ctrl.shutdown();
      } else {
        log('[TTS] toggle：启动中收到停止请求，标记 pendingStop 等待 client 创建完成', 'info');
      }
      return;
    }

    // ── 关闭分支 ──
    const ctrl = controllerRef.current;
    if (ctrl) {
      lockRef.current = 'stopping';
      controllerRef.current = null;
      log('[TTS] toggle → 关闭听书', 'info');
      try {
        await ctrl.shutdown();
      } finally {
        lockRef.current = 'idle';
      }
      return { success: true, action: 'stop' as const };
    }

    // ── 开启分支 ──
    if (!listenSupported || !rendererRef.current) {
      return { success: false, failReason: 'listenFailedNoContent' };
    }

    lockRef.current = 'starting';
    pendingStopRef.current = false;
    log('[TTS] toggle → 开启听书', 'info');
    try {
      let readerSettings = getReaderSettings();
      const { client, failReason } = await createTTSClient(readerSettings.ttsPreferredEngine);

      // 启动过程中用户请求了停止
      if (pendingStopRef.current) {
        log('[TTS] 客户端创建完成但 pendingStop=true，直接清理', 'info');
        pendingStopRef.current = false;
        if (client) await client.shutdown();
        setState('stopped');
        return { success: true, action: 'stop' as const };
      }

      if (!client) {
        log(`[TTS] 无可用TTS客户端，failReason=${failReason}`, 'warn');
        return { success: false, failReason };
      }

      if (client instanceof NativeTTSClient) {
        const info = client.getInitInfo();
        log(
          `[TTS] Native 客户端就绪: mode=${info.mode} status=${info.status} offlineReady=${info.offlineReady} defaultEngine=${info.defaultEngine ?? ''}`,
          'info',
        );
        if (info.defaultEngine) {
          const prevEngine = readerSettings.ttsNativeDefaultEngine;
          if (prevEngine && prevEngine !== info.defaultEngine) {
            log(
              `[TTS] 系统默认 TTS 引擎已变更: ${prevEngine} -> ${info.defaultEngine}，清理 native-tts 语音选择`,
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

      log(`[TTS] 客户端创建成功: ${client.name}，开始朗读`, 'info');
      const controller = new TTSController(client, rendererRef.current!, setState, onReadingActivity, onMark);
      controllerRef.current = controller;

      const ttsRate = readerSettings.ttsRate ?? TTS_RATE_DEFAULT;
      controller.setRate(ttsRate);

      const voiceId = readerSettings.ttsVoiceByEngine?.[client.name];
      if (voiceId) {
        client.setVoice(voiceId);
      }
      const effectiveVoiceId = client.getVoiceId();
      log(
        `[TTS] 启动参数: engine=${client.name} voiceId=${voiceId ?? ''} effectiveVoiceId=${effectiveVoiceId || 'default'} rate=${ttsRate}`,
        'info',
      );
      if (voiceId && voiceId !== 'default') {
        const exists = (client.getVoices() || []).some((v) => v.id === voiceId);
        if (!exists) {
          log(
            `[TTS] 选择的 voiceId 不存在于当前 voices: engine=${client.name} voiceId=${voiceId}，回退系统默认`,
            'warn',
          );
          client.setVoice('default');
          saveReaderSettings({
            ttsVoiceByEngine: {
              ...(readerSettings.ttsVoiceByEngine || {}),
              [client.name]: 'default',
            },
          });
        }
      }

      const success = await controller.start();
      log(`[TTS] controller.start() 结果: ${success}`, 'info');

      // start() 之后再次检查 pendingStop（controller 可能已被外部 shutdown 中断）
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        if (controllerRef.current === controller) {
          log('[TTS] start() 完成但 pendingStop=true，立即 shutdown', 'info');
          controllerRef.current = null;
          await controller.shutdown();
        } else {
          log('[TTS] start() 完成，controller 已被外部中断', 'info');
        }
        setState('stopped');
        return { success: true, action: 'stop' as const };
      }

      if (!success) {
        controllerRef.current = null;
        setState('stopped');
        return { success: false, failReason: 'listenFailedNoContent' };
      }
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error
        ? `${error.name}: ${error.message}`
        : JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}));
      logError(`[TTS] toggle play 异常: ${errMsg}`, error);
      controllerRef.current = null;
      setState('stopped');
      return { success: false, failReason: 'listenFailedUnknown' };
    } finally {
      pendingStopRef.current = false;
      lockRef.current = 'idle';
    }
  }, [listenSupported, rendererRef, onReadingActivity, onMark]);

  const stop = useCallback(async () => {
    if (lockRef.current === 'starting' || controllerRef.current) {
      await toggle();
    }
  }, [toggle]);

  const notifyDocumentUpdated = useCallback(async (): Promise<void> => {
    await controllerRef.current?.notifyDocumentUpdated();
  }, []);

  // 用 useMemo 保持返回对象引用稳定，避免 handleToggleListen 不必要的重建
  const isPlaying = state === 'playing';
  return useMemo(() => ({
    state,
    isPlaying,
    isActive,
    toggle,
    stop,
    notifyDocumentUpdated,
  }), [state, isPlaying, isActive, toggle, stop, notifyDocumentUpdated]);
};

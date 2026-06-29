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
import { TTS_RATE_DEFAULT } from '../../../constants/tts';
import { createTTSClient, type TTSFailReason } from './createTTSClient';

/** 操作锁状态 */
type ToggleLock = 'idle' | 'stopping' | 'starting';

type SessionDriverClient = ITTSClient & {
  createSessionDriver: () => IBackendSessionDriver;
};

interface PlayResult {
  success: boolean;
  failReason?: TTSFailReason;
  action?: 'stop';
}

interface UseTTSOptions {
  rendererRef: React.MutableRefObject<IBookRenderer | null>;
  listenSupported: boolean;
  onReadingActivity?: () => void;
}

interface UseTTSReturn {
  state: TTSState;
  isPlaying: boolean;
  isActive: boolean;
  toggle: () => Promise<PlayResult | void>;
  stop: () => Promise<void>;
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
}: UseTTSOptions): UseTTSReturn => {
  const [state, setState] = useState<TTSState>('stopped');
  const sessionRef = useRef<TTSSession | null>(null);
  const clientRef = useRef<ITTSClient | null>(null);
  const lockRef = useRef<ToggleLock>('idle');
  /** 启动过程中收到停止请求时置为 true，启动完成后自动 shutdown */
  const pendingStopRef = useRef(false);

  const isActive = state !== 'stopped';

  const releaseActiveTTS = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    const client = clientRef.current;
    sessionRef.current = null;
    clientRef.current = null;

    if (session) {
      await session.shutdown().catch(() => {});
    }
    if (client) {
      await client.shutdown().catch(() => {});
    }
    setState('stopped');
  }, []);

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
        setState,
        onReadingActivity,
        () => {
          if (sessionRef.current !== newSession) return;
          void releaseActiveTTS();
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
      return { success: true };
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
  }, [listenSupported, rendererRef, onReadingActivity, releaseActiveTTS]);

  const stop = useCallback(async (): Promise<void> => {
    if (lockRef.current === 'starting' || sessionRef.current || clientRef.current) {
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
    notifyDocumentUpdated,
  }), [state, isPlaying, isActive, toggle, stop, notifyDocumentUpdated]);
};

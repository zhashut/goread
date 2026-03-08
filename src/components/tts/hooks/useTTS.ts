import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { IBookRenderer } from '../../../services/formats/types';
import type { ITTSClient } from '../../../services/tts/TTSClient';
import type { TTSState } from '../../../services/tts/types';
import { TTSController } from '../../../services/tts/TTSController';
import { WebSpeechClient } from '../../../services/tts/WebSpeechClient';
import { NativeTTSClient } from '../../../services/tts/NativeTTSClient';
import { log, logError, getReaderSettings } from '../../../services';
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

/** 尝试创建并初始化 TTS 客户端，Android 优先原生 TTS，其他平台 Web Speech 优先 */
async function createTTSClient(): Promise<{ client: ITTSClient | null; failReason: TTSFailReason }> {
  log('[TTS] createTTSClient: 开始创建客户端', 'info');

  const isAndroid = /android/i.test(navigator.userAgent || '');

  if (isAndroid) {
    const nativeTTS = new NativeTTSClient();
    const nativeInited = await nativeTTS.init();
    const nativeInfo = nativeTTS.getInitInfo();
    log(
      `[TTS] Native init: inited=${nativeInited} mode=${nativeInfo.mode} status=${nativeInfo.status} offlineReady=${nativeInfo.offlineReady}`,
      'info',
    );
    if (nativeInited && nativeInfo.offlineReady) {
      return { client: nativeTTS, failReason: 'listenFailedUnknown' };
    }

    const webSpeechLocal = new WebSpeechClient({ allowRemoteVoices: false });
    const webLocalInited = await webSpeechLocal.init();
    log(`[TTS] WebSpeech(localOnly) init 结果: ${webLocalInited}，语音数: ${webSpeechLocal.getVoices().length}`, 'info');
    if (webLocalInited) {
      return { client: webSpeechLocal, failReason: 'listenFailedUnknown' };
    }

    if (
      nativeInited
      && (nativeInfo.status === 'missing_data' || nativeInfo.status === 'lang_not_supported')
    ) {
      return { client: nativeTTS, failReason: 'listenFailedUnknown' };
    }

    const webSpeechAny = new WebSpeechClient({ allowRemoteVoices: true });
    const webAnyInited = await webSpeechAny.init();
    log(`[TTS] WebSpeech(any) init 结果: ${webAnyInited}，语音数: ${webSpeechAny.getVoices().length}`, 'info');
    if (webAnyInited) {
      return { client: webSpeechAny, failReason: 'listenFailedUnknown' };
    }

    const w = window as any;
    const tauriInvoke = w?.__TAURI__?.core?.invoke || w?.__TAURI__?.invoke;
    if (!NativeTTSClient.isAvailable() && typeof tauriInvoke !== 'function') {
      return { client: null, failReason: 'listenFailedNativeBridge' };
    }

    return { client: null, failReason: 'listenFailedNativeInit' };
  }

  const webSpeech = new WebSpeechClient();
  const webInited = await webSpeech.init();
  log(`[TTS] WebSpeech init 结果: ${webInited}，语音数: ${webSpeech.getVoices().length}`, 'info');
  if (webInited) {
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

  const nativeTTS = new NativeTTSClient();
  const nativeInited = await nativeTTS.init();
  if (nativeInited) {
    return { client: nativeTTS, failReason: 'listenFailedUnknown' };
  }

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
      const { client, failReason } = await createTTSClient();

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

      log(`[TTS] 客户端创建成功: ${client.name}，开始朗读`, 'info');
      const controller = new TTSController(client, rendererRef.current!, setState, onReadingActivity, onMark);
      controllerRef.current = controller;

      // 从持久化设置读取语速并应用到 TTS 引擎
      const ttsRate = getReaderSettings().ttsRate ?? TTS_RATE_DEFAULT;
      controller.setRate(ttsRate);

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

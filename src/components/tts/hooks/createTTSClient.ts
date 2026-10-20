import type { ITTSClient } from '../../../services/tts/TTSClient';
import { WebSpeechClient } from '../../../services/tts/WebSpeechClient';
import { NativeTTSClient } from '../../../services/tts/NativeTTSClient';
import { log } from '../../../services';

/** 听书启动失败的原因 key（对应 i18n） */
export type TTSFailReason =
  | 'listenFailedNoVoice'
  | 'listenFailedNativeBridge'
  | 'listenFailedNativeInit'
  | 'listenFailedNoContent'
  | 'listenFailedUnknown';

/** 创建客户端结果 */
export interface CreateTTSClientResult {
  client: ITTSClient | null;
  /** 成功时为空；仅 client 为 null 时提供失败原因 */
  failReason?: TTSFailReason;
}

/** 优先级（用户偏好引擎） */
export type TTSEnginePreference = 'native-tts' | 'web-speech' | undefined;

const tryWebSpeech = async (allowRemoteVoices: boolean): Promise<ITTSClient | null> => {
  const web = new WebSpeechClient({ allowRemoteVoices });
  const ok = await web.init();
  log(
    `[TTS] WebSpeech(${allowRemoteVoices ? 'any' : 'localOnly'}) init=${ok} voices=${web.getVoices().length}`,
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
    `[TTS] Native init: ok=${ok} mode=${info.mode} status=${info.status} offlineReady=${info.offlineReady}`,
    'info',
  );
  if (ok) return native;
  await native.shutdown().catch(() => {});
  return null;
};

const isAndroid = (): boolean => /android/i.test(navigator.userAgent || '');

const isIOS = (): boolean => {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iphone|ipad|ipod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

/** Android 平台尝试链 */
async function pickClientOnAndroid(
  preferred: TTSEnginePreference,
): Promise<CreateTTSClientResult> {
  if (preferred === 'web-speech') {
    const web = await tryWebSpeech(true);
    if (web) return { client: web };
  }

  // 用户指定 native 时只尝试一次；失败后保留实例用于后续 missing_data 兜底，
  // 不再像旧逻辑那样 shutdown 后立刻重复 init 同一个引擎。
  let native: NativeTTSClient | null = null;
  let nativeInfo: ReturnType<NativeTTSClient['getInitInfo']> | undefined;
  if (preferred === 'native-tts') {
    native = await tryNative();
    nativeInfo = native?.getInitInfo();
    if (native && nativeInfo?.offlineReady) return { client: native };
  }

  if (!native) {
    native = await tryNative();
    nativeInfo = native?.getInitInfo();
    if (native && nativeInfo?.offlineReady) return { client: native };
  }

  const webLocal = await tryWebSpeech(false);
  if (webLocal) {
    await native?.shutdown().catch(() => {});
    return { client: webLocal };
  }

  if (
    native
    && nativeInfo
    && (nativeInfo.status === 'missing_data' || nativeInfo.status === 'lang_not_supported')
  ) {
    return { client: native };
  }

  const webAny = await tryWebSpeech(true);
  if (webAny) {
    await native?.shutdown().catch(() => {});
    return { client: webAny };
  }

  const w = window as any;
  const tauriInvoke = w?.__TAURI__?.core?.invoke || w?.__TAURI__?.invoke;
  if (!NativeTTSClient.isAvailable() && typeof tauriInvoke !== 'function') {
    return { client: null, failReason: 'listenFailedNativeBridge' };
  }
  return { client: null, failReason: 'listenFailedNativeInit' };
}

/** iOS 平台尝试链 */
async function pickClientOnIOS(
  preferred: TTSEnginePreference,
): Promise<CreateTTSClientResult> {
  if (preferred === 'web-speech') {
    const web = await tryWebSpeech(true);
    if (web) return { client: web, failReason: 'listenFailedUnknown' };
  }
  if (preferred === 'native-tts') {
    const native = await tryNative();
    if (native) return { client: native, failReason: 'listenFailedUnknown' };
  }

  // 中文注释：iOS 优先走原生插件，保证后台朗读和会话事件链路与 Android 尽量一致。
  const native = await tryNative();
  if (native) return { client: native, failReason: 'listenFailedUnknown' };

  const web = await tryWebSpeech(true);
  if (web) return { client: web, failReason: 'listenFailedUnknown' };

  return {
    client: null,
    failReason: NativeTTSClient.isAvailable()
      ? 'listenFailedNativeInit'
      : 'listenFailedNoVoice',
  };
}

/** 桌面 / iOS 平台尝试链 */
async function pickClientOnDesktop(
  preferred: TTSEnginePreference,
): Promise<CreateTTSClientResult> {
  if (preferred === 'native-tts') {
    const native = await tryNative();
    if (native) return { client: native };
  }

  // preferred=web-speech 时这里就是首选；否则作为 native 失败后的兜底。
  // 旧逻辑在 preferred=web-speech 时会连续 tryWebSpeech(true) 两次。
  const web = await tryWebSpeech(true);
  if (web) return { client: web };

  if (!NativeTTSClient.isAvailable()) {
    return { client: null, failReason: 'listenFailedNoVoice' };
  }
  if (preferred !== 'native-tts') {
    const native = await tryNative();
    if (native) return { client: native };
  }
  return { client: null, failReason: 'listenFailedNativeInit' };
}

/** 创建并初始化最合适的 TTS 客户端 */
export async function createTTSClient(
  preferred: string | undefined,
): Promise<CreateTTSClientResult> {
  const normalized: TTSEnginePreference =
    preferred === 'native-tts' || preferred === 'web-speech' ? preferred : undefined;
  log(`[TTS] createTTSClient: 开始创建客户端 preferred=${normalized ?? ''}`, 'info');
  if (isAndroid()) return pickClientOnAndroid(normalized);
  if (isIOS()) return pickClientOnIOS(normalized);
  return pickClientOnDesktop(normalized);
}


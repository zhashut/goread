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
  failReason: TTSFailReason;
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

/** Android 平台尝试链 */
async function pickClientOnAndroid(
  preferred: TTSEnginePreference,
): Promise<CreateTTSClientResult> {
  if (preferred === 'web-speech') {
    const web = await tryWebSpeech(true);
    if (web) return { client: web, failReason: 'listenFailedUnknown' };
  }
  if (preferred === 'native-tts') {
    const native = await tryNative();
    const info = native?.getInitInfo();
    if (native && info?.offlineReady) return { client: native, failReason: 'listenFailedUnknown' };
    await native?.shutdown().catch(() => {});
  }

  const native = await tryNative();
  const nativeInfo = native?.getInitInfo();
  if (native && nativeInfo?.offlineReady) {
    return { client: native, failReason: 'listenFailedUnknown' };
  }

  const webLocal = await tryWebSpeech(false);
  if (webLocal) {
    await native?.shutdown().catch(() => {});
    return { client: webLocal, failReason: 'listenFailedUnknown' };
  }

  if (
    native
    && nativeInfo
    && (nativeInfo.status === 'missing_data' || nativeInfo.status === 'lang_not_supported')
  ) {
    return { client: native, failReason: 'listenFailedUnknown' };
  }

  const webAny = await tryWebSpeech(true);
  if (webAny) {
    await native?.shutdown().catch(() => {});
    return { client: webAny, failReason: 'listenFailedUnknown' };
  }

  const w = window as any;
  const tauriInvoke = w?.__TAURI__?.core?.invoke || w?.__TAURI__?.invoke;
  if (!NativeTTSClient.isAvailable() && typeof tauriInvoke !== 'function') {
    return { client: null, failReason: 'listenFailedNativeBridge' };
  }
  return { client: null, failReason: 'listenFailedNativeInit' };
}

/** 桌面 / iOS 平台尝试链 */
async function pickClientOnDesktop(
  preferred: TTSEnginePreference,
): Promise<CreateTTSClientResult> {
  if (preferred === 'native-tts') {
    const native = await tryNative();
    if (native) return { client: native, failReason: 'listenFailedUnknown' };
  }
  if (preferred === 'web-speech') {
    const web = await tryWebSpeech(true);
    if (web) return { client: web, failReason: 'listenFailedUnknown' };
  }

  const web = await tryWebSpeech(true);
  if (web) return { client: web, failReason: 'listenFailedUnknown' };

  if (!NativeTTSClient.isAvailable()) {
    return { client: null, failReason: 'listenFailedNoVoice' };
  }
  const native = await tryNative();
  if (native) return { client: native, failReason: 'listenFailedUnknown' };
  return { client: null, failReason: 'listenFailedNativeInit' };
}

/** 创建并初始化最合适的 TTS 客户端 */
export async function createTTSClient(
  preferred: string | undefined,
): Promise<CreateTTSClientResult> {
  const normalized: TTSEnginePreference =
    preferred === 'native-tts' || preferred === 'web-speech' ? preferred : undefined;
  log(`[TTS] createTTSClient: 开始创建客户端 preferred=${normalized ?? ''}`, 'info');
  return isAndroid() ? pickClientOnAndroid(normalized) : pickClientOnDesktop(normalized);
}


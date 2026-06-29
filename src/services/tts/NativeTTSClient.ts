import type { ITTSClient } from './TTSClient';
import type { TTSVoice } from './types';
import { TTS_RATE_DEFAULT } from '../../constants/tts';
import { loadTauriCore } from './core/tauriCore';
import { NativeSessionDriver } from './drivers/NativeSessionDriver';
import { log, logError } from '../index';

declare global {
  interface Window {
    __TTS_BRIDGE_READY__?: boolean;
    __onTTSInit__?: (success: boolean, voices: TTSVoice[], status?: string) => void;
    TTSBridge?: {
      init(): void;
      stop(): void;
      pause(): boolean;
      isAvailable(): boolean;
      getVoices(): string;
      setRate(rate: number): void;
      shutdown(): void;
    };
  }
}

/** 原生 TTS 插件 init 响应 */
type PluginInitResponse = {
  success: boolean;
  status: string;
  defaultEngine?: string;
  langCheck?: { requested: string; result: string };
  voices?: (TTSVoice & { displayZh?: string; displayEn?: string })[];
};

/** 客户端可对外暴露的初始化信息 */
export type NativeTTSInitInfo = {
  mode: 'plugin' | 'bridge' | 'none';
  status: string;
  offlineReady: boolean;
  defaultEngine?: string;
  langCheck?: { requested: string; result: string };
};

/** 前台服务参数 */
type SetMediaSessionActivePayload = {
  active: boolean;
  keepAppInForeground: boolean;
  notificationTitle?: string;
  notificationText?: string;
  foregroundServiceTitle?: string;
  foregroundServiceText?: string;
};

/**
 * 原生 TTS 客户端
 * 仅负责：引擎初始化 / 语音查询与配置 / 前台服务保活 / 关闭
 * 实际朗读统一由 createSessionDriver() 返回的 NativeSessionDriver 经会话协议驱动
 * 该 driver 自行订阅 native-tts 的 tts_events，无需 client 转发
 */
export class NativeTTSClient implements ITTSClient {
  readonly name = 'native-tts';
  initialized = false;

  #voices: TTSVoice[] = [];
  #primaryLang = 'zh';
  #currentVoiceId = '';
  #rate = TTS_RATE_DEFAULT;

  #mode: 'plugin' | 'bridge' | 'none' = 'none';
  #initInfo: NativeTTSInitInfo = {
    mode: 'none',
    status: 'unknown',
    offlineReady: false,
  };
  #backgroundPlaybackActive = false;
  #sessionDriver: NativeSessionDriver | null = null;

  static isAvailable(): boolean {
    return typeof window.TTSBridge !== 'undefined';
  }

  getInitInfo(): NativeTTSInitInfo {
    return { ...this.#initInfo };
  }

  async init(): Promise<boolean> {
    this.#mode = 'none';
    this.#initInfo = { mode: 'none', status: 'unknown', offlineReady: false };
    const pluginOk = await this.#initPlugin();
    if (pluginOk) return true;
    return await this.#initBridge();
  }

  /** 创建（或复用）一个会话驱动 */
  createSessionDriver(): NativeSessionDriver {
    if (!this.#sessionDriver) {
      this.#sessionDriver = new NativeSessionDriver({
        isPluginMode: () => this.#mode === 'plugin',
        toBCP47: (lang) => this.#toBCP47(lang),
        getPrimaryLang: () => this.#primaryLang,
        getRate: () => this.#rate,
        getVoiceId: () => this.#currentVoiceId,
      });
    }
    return this.#sessionDriver;
  }

  getVoices(lang?: string): TTSVoice[] {
    if (this.initialized && this.#voices.length === 0) {
      return [this.#defaultVoice(lang)];
    }
    if (!lang) return this.#voices;
    const prefix = lang.substring(0, 2).toLowerCase();
    return this.#voices.filter((v) => v.lang.substring(0, 2).toLowerCase() === prefix);
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  setVoice(voiceId: string): void {
    if (!voiceId || voiceId === 'default') {
      this.#currentVoiceId = '';
      if (this.#mode === 'plugin') {
        loadTauriCore()
          .then((core) => core?.invoke('native_tts_set_voice', { payload: { voice: '' } }))
          .catch(() => {});
      }
      return;
    }
    const found = this.#voices.find((v) => v.id === voiceId);
    if (found) this.#currentVoiceId = found.id;
    if (this.#mode === 'plugin') {
      loadTauriCore()
        .then((core) => core?.invoke('native_tts_set_voice', { payload: { voice: voiceId } }))
        .catch(() => {});
    }
  }

  setRate(rate: number): void {
    this.#rate = rate;
    if (this.#mode === 'plugin') {
      loadTauriCore()
        .then((core) => core?.invoke('native_tts_set_rate', { payload: { rate } }))
        .catch(() => {});
      return;
    }
    window.TTSBridge?.setRate(rate);
  }

  getRate(): number {
    return this.#rate;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.#voices = [];

    if (this.#sessionDriver) {
      try {
        await this.#sessionDriver.detach();
      } catch {}
      this.#sessionDriver = null;
    }

    if (this.#mode === 'plugin') {
      await this.#setBackgroundPlaybackActive(false);
      const core = await loadTauriCore();
      await core?.invoke('native_tts_shutdown').catch(() => {});
      this.#mode = 'none';
      return;
    }
    window.TTSBridge?.shutdown();
    this.#mode = 'none';
  }

  #defaultVoice(lang?: string): TTSVoice {
    return {
      id: 'default',
      name: '系统默认',
      lang: lang || this.#primaryLang,
    };
  }

  #toBCP47(lang: string): string {
    const p = lang.substring(0, 2).toLowerCase();
    if (p === 'zh') return 'zh-CN';
    if (p === 'en') return 'en-US';
    return lang;
  }

  async #initPlugin(): Promise<boolean> {
    const core = await loadTauriCore();
    if (!core?.invoke) return false;
    if (!core?.addPluginListener) {
      log('[TTS][Native] 插件可用但缺少 addPluginListener，跳过 plugin 模式', 'warn');
      return false;
    }
    try {
      const res = await core.invoke('native_tts_init', {
        payload: { lang: this.#toBCP47(this.#primaryLang) },
      }) as PluginInitResponse;
      if (!res || typeof res.success !== 'boolean') return false;

      this.initialized = res.success;
      if (!res.success) return false;

      this.#mode = 'plugin';
      this.#initInfo = {
        mode: 'plugin',
        status: res.status || 'unknown',
        offlineReady: res.status === 'success',
        defaultEngine: res.defaultEngine,
        langCheck: res.langCheck,
      };
      const normalized = this.#normalizeVoices(res.voices);
      this.#voices = normalized.length > 0 ? normalized : [this.#defaultVoice()];
      await this.#setBackgroundPlaybackActive(true);
      log(
        `[TTS][Native] plugin init ok status=${this.#initInfo.status} defaultEngine=${this.#initInfo.defaultEngine ?? ''} voices=${this.#voices.length}`,
        'info',
      );
      return true;
    } catch (e) {
      logError('[TTS][Native] plugin 初始化异常', e);
      return false;
    }
  }

  async #initBridge(): Promise<boolean> {
    if (!NativeTTSClient.isAvailable()) {
      this.initialized = false;
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      window.__onTTSInit__ = (success: boolean, voices: TTSVoice[], status?: string) => {
        if (resolved) return;
        resolved = true;
        this.initialized = success;
        if (success) {
          this.#mode = 'bridge';
          const s = status || 'success';
          this.#initInfo = { mode: 'bridge', status: s, offlineReady: s === 'success' };
          const normalized = this.#normalizeVoices(voices);
          this.#voices = normalized.length > 0 ? normalized : this.#tryReadVoicesFromBridge();
          log(`[TTS][Native] bridge init ok status=${s} voices=${this.#voices.length}`, 'info');
        } else {
          this.#initInfo = { mode: 'none', status: status || 'init_error', offlineReady: false };
          log(`[TTS][Native] bridge init failed status=${status || 'init_error'}`, 'warn');
        }
        resolve(success);
      };

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.initialized = false;
          window.__onTTSInit__ = undefined;
          resolve(false);
        }
      }, 5000);

      window.TTSBridge!.init();
    });
  }

  #normalizeVoices(input: unknown): TTSVoice[] {
    if (!Array.isArray(input)) return [];
    const out: TTSVoice[] = [];
    for (const v of input) {
      if (!v || typeof v !== 'object') continue;
      const maybe = v as Partial<TTSVoice> & { displayZh?: unknown; displayEn?: unknown };
      if (
        typeof maybe.id === 'string' &&
        typeof maybe.name === 'string' &&
        typeof maybe.lang === 'string'
      ) {
        const displayZh = typeof maybe.displayZh === 'string' ? maybe.displayZh : undefined;
        const displayEn = typeof maybe.displayEn === 'string' ? maybe.displayEn : undefined;
        out.push({
          id: maybe.id,
          name: maybe.name,
          lang: maybe.lang,
          display: displayZh || displayEn ? { zh: displayZh, en: displayEn } : undefined,
        });
      }
    }
    return out;
  }

  #tryReadVoicesFromBridge(): TTSVoice[] {
    try {
      const raw = window.TTSBridge?.getVoices?.();
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return this.#normalizeVoices(parsed);
    } catch {
      return [];
    }
  }

  async #setBackgroundPlaybackActive(active: boolean): Promise<void> {
    if (this.#backgroundPlaybackActive === active) return;
    const core = await loadTauriCore();
    if (!core?.invoke) return;

    const payload: SetMediaSessionActivePayload = active
      ? {
          active: true,
          keepAppInForeground: true,
          notificationTitle: 'GoRead TTS',
          notificationText: 'Reading in background',
          foregroundServiceTitle: 'GoRead TTS',
          foregroundServiceText: 'Reading in background',
        }
      : {
          active: false,
          keepAppInForeground: false,
        };

    try {
      await core.invoke('native_tts_set_media_session_active', { payload });
      this.#backgroundPlaybackActive = active;
      log(`[TTS][Native] 后台保活已${active ? '开启' : '关闭'}`, 'info');
    } catch (e) {
      logError(`[TTS][Native] 后台保活${active ? '开启' : '关闭'}失败`, e);
    }
  }
}


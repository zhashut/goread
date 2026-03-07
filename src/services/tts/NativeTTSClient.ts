import type { ITTSClient } from './TTSClient';
import type { TTSMessageEvent, TTSVoice } from './types';
import { parseSSMLMarks } from './ssmlParser';
import { TTS_RATE_DEFAULT } from '../../constants/tts';

declare global {
  interface Window {
    __TTS_BRIDGE_READY__?: boolean;
    __onTTSInit__?: (success: boolean, voices: TTSVoice[]) => void;
    __onTTSEvent__?: (code: string, utteranceId: string, error: string) => void;
    TTSBridge?: {
      init(): void;
      speak(text: string, lang: string, rate: number, utteranceId: string): void;
      stop(): void;
      pause(): boolean;
      isAvailable(): boolean;
      getVoices(): string;
      setRate(rate: number): void;
      shutdown(): void;
    };
  }
}

type PluginInitResponse = {
  success: boolean;
  status: string;
  defaultEngine?: string;
  langCheck?: { requested: string; result: string };
  voices?: TTSVoice[];
};

type TTSEventPayload = {
  utteranceId: string;
  code: string;
  message?: string;
  mark?: string;
};

async function loadTauriCore(): Promise<{
  invoke: (cmd: string, args?: any) => Promise<any>;
  addPluginListener?: (
    plugin: string,
    event: string,
    handler: (payload: any) => void,
  ) => Promise<any>;
} | null> {
  try {
    const coreMod = await import('@tauri-apps/api/core').catch(() => null as any);
    const invoke = (coreMod as any)?.invoke;
    if (typeof invoke !== 'function') return null;
    const addPluginListener = (coreMod as any)?.addPluginListener;
    return { invoke, addPluginListener };
  } catch {
    return null;
  }
}

export class NativeTTSClient implements ITTSClient {
  readonly name = 'native-tts';
  initialized = false;

  #voices: TTSVoice[] = [];
  #primaryLang = 'zh';
  #currentVoiceId = '';
  #rate = TTS_RATE_DEFAULT;

  #mode: 'plugin' | 'bridge' | 'none' = 'none';
  #pluginListener: any = null;
  #activeUtterances = new Map<string, { resolve: (ev: TTSMessageEvent) => void }>();

  static isAvailable(): boolean {
    return typeof window.TTSBridge !== 'undefined';
  }

  async init(): Promise<boolean> {
    const pluginOk = await this.#initPlugin();
    if (pluginOk) return true;
    return await this.#initBridge();
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
    if (!core?.addPluginListener) return false;

    try {
      const res = await core.invoke('plugin:native-tts|init', {
        payload: { lang: this.#toBCP47(this.#primaryLang) },
      }) as PluginInitResponse;

      if (!res || typeof res.success !== 'boolean') return false;

      this.initialized = res.success;
      if (!res.success) return false;

      this.#mode = 'plugin';
      const normalized = this.#normalizeVoices(res.voices);
      this.#voices = normalized.length > 0 ? normalized : [this.#defaultVoice()];
      await this.#setupPluginListener(core.addPluginListener);
      return true;
    } catch {
      return false;
    }
  }

  async #setupPluginListener(
    addPluginListener: (
      plugin: string,
      event: string,
      handler: (payload: any) => void,
    ) => Promise<any>,
  ): Promise<void> {
    if (this.#pluginListener) return;
    this.#pluginListener = await addPluginListener(
      'native-tts',
      'tts_events',
      (event: TTSEventPayload) => {
        const utteranceId = (event as any)?.utteranceId;
        if (!utteranceId) return;
        const data = this.#activeUtterances.get(utteranceId);
        if (!data) return;
        const code = (event as any)?.code;
        if (code !== 'end' && code !== 'error') return;
        const message = (event as any)?.message;
        const ev: TTSMessageEvent =
          code === 'error'
            ? { code: 'error', error: message || 'Native TTS error' }
            : { code: 'end' };
        this.#activeUtterances.delete(utteranceId);
        data.resolve(ev);
      },
    );
  }

  async #initBridge(): Promise<boolean> {
    if (!NativeTTSClient.isAvailable()) {
      this.initialized = false;
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      window.__onTTSInit__ = (success: boolean, voices: TTSVoice[]) => {
        if (resolved) return;
        resolved = true;
        this.initialized = success;
        if (success) {
          this.#mode = 'bridge';
          const normalized = this.#normalizeVoices(voices);
          this.#voices =
            normalized.length > 0 ? normalized : this.#tryReadVoicesFromBridge();
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
      const maybe = v as Partial<TTSVoice>;
      if (
        typeof maybe.id === 'string' &&
        typeof maybe.name === 'string' &&
        typeof maybe.lang === 'string'
      ) {
        out.push({ id: maybe.id, name: maybe.name, lang: maybe.lang });
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

  async *speak(ssml: string, signal: AbortSignal): AsyncGenerator<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    for (let i = 0; i < marks.length; i++) {
      if (signal.aborted) return;

      const mark = marks[i]!;
      yield { code: 'boundary', mark: mark.name };

      const result =
        this.#mode === 'plugin'
          ? await this.#speakAndWaitPlugin(mark.text, mark.language, signal)
          : await this.#speakAndWaitBridge(mark.text, mark.language, mark.name, signal);

      if (signal.aborted) return;

      if (result.code === 'error') {
        yield result;
        break;
      }

      yield result;
    }
  }

  #speakAndWaitBridge(
    text: string,
    lang: string,
    markName: string,
    signal: AbortSignal,
  ): Promise<TTSMessageEvent> {
    return new Promise<TTSMessageEvent>((resolve) => {
      if (signal.aborted) {
        resolve({ code: 'end' });
        return;
      }

      const safeName = String(markName).replace(/[^a-zA-Z0-9_]/g, '');
      const utteranceId = `mark_${safeName}_${Date.now()}`;

      const cleanup = () => {
        window.__onTTSEvent__ = undefined;
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        window.TTSBridge?.stop();
        resolve({ code: 'end' });
      };

      signal.addEventListener('abort', onAbort, { once: true });

      window.__onTTSEvent__ = (code: string, id: string, error: string) => {
        if (id !== utteranceId) return;

        if (code === 'end') {
          cleanup();
          resolve({ code: 'end' });
        } else if (code === 'error') {
          cleanup();
          resolve({ code: 'error', error: error || 'Native TTS error' });
        }
      };

      window.TTSBridge!.speak(text, lang, this.#rate, utteranceId);
    });
  }

  async #speakAndWaitPlugin(
    text: string,
    lang: string,
    signal: AbortSignal,
  ): Promise<TTSMessageEvent> {
    const core = await loadTauriCore();
    if (!core) return { code: 'error', error: 'Native TTS unavailable' };
    if (signal.aborted) return { code: 'end' };

    const result = await core.invoke('plugin:native-tts|speak', {
      payload: { text, lang: this.#toBCP47(lang) },
    }) as { utteranceId?: string };

    const utteranceId = result?.utteranceId;
    if (!utteranceId) return { code: 'error', error: 'Native TTS speak failed' };

    return new Promise<TTSMessageEvent>((resolve) => {
      const cleanup = () => {
        this.#activeUtterances.delete(utteranceId);
        signal.removeEventListener('abort', onAbort);
        clearTimeout(timeoutId);
      };

      const onAbort = () => {
        cleanup();
        this.stop();
        resolve({ code: 'end' });
      };

      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve({ code: 'error', error: 'Native TTS timeout' });
      }, 30000);

      signal.addEventListener('abort', onAbort, { once: true });
      this.#activeUtterances.set(utteranceId, {
        resolve: (ev) => {
          cleanup();
          resolve(ev);
        },
      });
    });
  }

  async pause(): Promise<boolean> {
    if (this.#mode === 'plugin') {
      const core = await loadTauriCore();
      await core?.invoke('plugin:native-tts|pause').catch(() => {});
      return true;
    }
    window.TTSBridge?.pause();
    return true;
  }

  async resume(): Promise<boolean> {
    return false;
  }

  async stop(): Promise<void> {
    for (const [, v] of this.#activeUtterances) {
      v.resolve({ code: 'end' });
    }
    this.#activeUtterances.clear();

    if (this.#mode === 'plugin') {
      const core = await loadTauriCore();
      await core?.invoke('plugin:native-tts|stop').catch(() => {});
      return;
    }
    window.TTSBridge?.stop();
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
      return;
    }
    const found = this.#voices.find((v) => v.id === voiceId);
    if (found) this.#currentVoiceId = found.id;
    if (this.#mode === 'plugin') {
      loadTauriCore()
        .then((core) => core?.invoke('plugin:native-tts|set_voice', { payload: { voice: voiceId } }))
        .catch(() => {});
    }
  }

  setRate(rate: number): void {
    this.#rate = rate;
    if (this.#mode === 'plugin') {
      loadTauriCore()
        .then((core) => core?.invoke('plugin:native-tts|set_rate', { payload: { rate } }))
        .catch(() => {});
      return;
    }
    window.TTSBridge?.setRate(rate);
  }

  getRate(): number {
    return this.#rate;
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.initialized = false;
    this.#voices = [];

    if (this.#pluginListener) {
      try {
        const l = this.#pluginListener;
        if (typeof l === 'function') l();
        else if (typeof l?.unlisten === 'function') l.unlisten();
        else if (typeof l?.unregister === 'function') l.unregister();
      } catch {}
      this.#pluginListener = null;
    }

    if (this.#mode === 'plugin') {
      const core = await loadTauriCore();
      await core?.invoke('plugin:native-tts|shutdown').catch(() => {});
      this.#mode = 'none';
      return;
    }

    window.TTSBridge?.shutdown();
    this.#mode = 'none';
  }
}

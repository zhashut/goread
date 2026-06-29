import { loadTauriCore } from '../core/tauriCore';
import type { TTSReadingAnchor, TTSSegment } from '../types';
import type { BackendTTSRequest } from './TTSContentProvider';

/** 对应 Rust 端 TtsGetSegmentsResponse 字段 */
export interface BackendTTSResponse {
  segments: TTSSegment[];
  cursor: string | null;
  hasMore: boolean;
}

/** Rust 端原始返回的 anchor 字段（仅 quote 必填） */
type RawAnchor = {
  quote: string;
  prefix?: string;
  suffix?: string;
};

/** Rust 端原始返回的 segment 字段，按 camelCase 序列化 */
type RawSegment = {
  id: string;
  text: string;
  lang?: string;
  sectionIndex: number;
  chunkIndex: number;
  cursor: string;
  anchor?: RawAnchor | null;
};

type RawResponse = {
  segments: RawSegment[];
  cursor?: string | null;
  hasMore: boolean;
};

/** 调用 Rust 端 tts_get_segments 命令 */
export const invokeTTSGetSegments = async (
  request: BackendTTSRequest,
): Promise<BackendTTSResponse> => {
  const core = await loadTauriCore();
  if (!core?.invoke) {
    throw new Error('Tauri core invoke unavailable');
  }
  const raw = (await core.invoke('tts_get_segments', { request })) as RawResponse;
  return {
    segments: raw.segments.map(toSegment),
    cursor: raw.cursor ?? null,
    hasMore: raw.hasMore,
  };
};

export const invokeTTSManagedSessionStart = async (payload: {
  request: BackendTTSRequest;
  rate: number;
  voiceId?: string;
  lang?: string;
  lowWatermarkSeconds?: number;
}): Promise<void> => {
  const core = await loadTauriCore();
  if (!core?.invoke) {
    throw new Error('Tauri core invoke unavailable');
  }
  await core.invoke('tts_managed_session_start', {
    payload: {
      ...payload.request,
      rate: payload.rate,
      voiceId: payload.voiceId,
      lang: payload.lang,
      lowWatermarkSeconds: payload.lowWatermarkSeconds,
    },
  });
};

export const invokeTTSManagedSessionStop = async (): Promise<void> => {
  const core = await loadTauriCore();
  if (!core?.invoke) return;
  await core.invoke('tts_managed_session_stop').catch(() => {});
};

export const invokeTTSManagedSessionPause = async (): Promise<void> => {
  const core = await loadTauriCore();
  if (!core?.invoke) return;
  await core.invoke('tts_managed_session_pause').catch(() => {});
};

export const invokeTTSManagedSessionResume = async (): Promise<void> => {
  const core = await loadTauriCore();
  if (!core?.invoke) return;
  await core.invoke('tts_managed_session_resume').catch(() => {});
};

export const invokeTTSManagedSessionSetRate = async (rate: number): Promise<void> => {
  const core = await loadTauriCore();
  if (!core?.invoke) return;
  await core.invoke('tts_managed_session_set_rate', { payload: { rate } }).catch(() => {});
};

export const invokeTTSManagedSessionSetVoice = async (voiceId: string): Promise<void> => {
  const core = await loadTauriCore();
  if (!core?.invoke) return;
  await core.invoke('tts_managed_session_set_voice', { payload: { voiceId } }).catch(() => {});
};

/** 把 Rust 端原始 segment 转成前端 TTSSegment */
const toSegment = (raw: RawSegment): TTSSegment => ({
  id: raw.id,
  text: raw.text,
  lang: raw.lang,
  sectionIndex: raw.sectionIndex,
  chunkIndex: raw.chunkIndex,
  cursor: raw.cursor,
  anchor: toAnchor(raw.anchor ?? null),
});

/** 把 Rust 端原始 anchor 转成前端 TTSReadingAnchor */
const toAnchor = (raw: RawAnchor | null): TTSReadingAnchor | null => {
  if (!raw) return null;
  return {
    quote: raw.quote,
    prefix: raw.prefix,
    suffix: raw.suffix,
  };
};


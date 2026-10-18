// TTS 语速控制参数
export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 10.0;
export const TTS_RATE_DEFAULT = 1.0;
export const TTS_RATE_STEP = 0.1;

/**
 * 估算“听书时长”用的语言先验（字符/秒，rate = 1.0）。
 *
 * 参考同类产品公开值（Readox 等）：
 * zh≈4.5、en≈15、ja/ko≈7、fr≈17、es/de≈18。
 * 仅作为初始种子；实际会按“引擎+语音+语言”在播放中学习并持久化。
 */
export const TTS_CHARS_PER_SECOND_PRIORS: Record<string, number> = {
  zh: 4.5,
  en: 15,
  ja: 7,
  ko: 7,
  fr: 17,
  es: 18,
  de: 18,
};

/**
 * 语速采样/历史值的合理区间（相对语言先验）。
 * 引擎跳句、进度事件抖动、后台缓冲都会产生异常采样，超出区间直接丢弃，
 * 避免语速被带偏后章节时长短于实际播放时间（表现为进度条提前满格）。
 */
export const TTS_SPEED_PRIOR_MIN_FACTOR = 0.4;
export const TTS_SPEED_PRIOR_MAX_FACTOR = 2.5;

/** 未知语言的保守回退（中文应用默认按中文先验） */
export const getTtsDefaultCharsPerSecond = (sample?: string): number => {
  const text = (sample ?? '').trim();
  if (!text) return TTS_CHARS_PER_SECOND_PRIORS.zh;
  if (/[\u4e00-\u9fff]/.test(text)) return TTS_CHARS_PER_SECOND_PRIORS.zh;
  return TTS_CHARS_PER_SECOND_PRIORS.en;
};

// Web Speech API 黑名单语音（系统内置特效音色）
export const WEB_SPEECH_BLACKLISTED_VOICES = [
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles',
  'Cellos', 'Eddy', 'Flo', 'Fred', 'Good News', 'Grandma',
  'Grandpa', 'Jester', 'Junior', 'Kathy', 'Organ', 'Ralph',
  'Reed', 'Rocko', 'Sandy', 'Shelley', 'Superstar', 'Trinoids',
  'Whisper', 'Wobble', 'Zarvox',
];

// 语音列表加载相关参数
export const TTS_VOICE_LOAD_TIMEOUT = 3000;    // getVoices 超时时间（毫秒）
export const TTS_VOICE_RETRY_DELAY = 500;      // 重试间隔（毫秒）
export const TTS_VOICE_MAX_RETRIES = 2;        // 最大重试次数

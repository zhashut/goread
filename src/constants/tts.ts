// TTS 语速控制参数
export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 5.0;
export const TTS_RATE_DEFAULT = 1.0;
export const TTS_RATE_STEP = 0.1;

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

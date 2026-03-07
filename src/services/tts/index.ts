export type { TTSState, TTSMark, TTSEventCode, TTSMessageEvent, TTSVoice } from './types';
export type { ITTSClient } from './TTSClient';
export type { TTSDocumentData, TTSStateChangeCallback } from './TTSController';
export { WebSpeechClient } from './WebSpeechClient';
export { NativeTTSClient } from './NativeTTSClient';
export { TTSController } from './TTSController';
export { parseSSMLMarks, parseSSMLLang, preprocessSSML, textToSSML } from './ssmlParser';

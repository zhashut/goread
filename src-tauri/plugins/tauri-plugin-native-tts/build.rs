const COMMANDS: &[&str] = &[
  "init",
  "speak",
  "stop",
  "pause",
  "resume",
  "set_rate",
  "set_voice",
  "get_all_voices",
  "set_media_session_active",
  "open_tts_settings",
  "install_tts_data",
  "shutdown",
  "tts_session_start",
  "tts_session_push",
  "tts_session_stop",
  "tts_session_pause",
  "tts_session_resume",
  "tts_session_set_rate",
  "tts_session_set_voice",
  "tts_session_set_end_of_book",
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).build();
}

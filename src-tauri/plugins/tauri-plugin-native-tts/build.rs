const COMMANDS: &[&str] = &[
  "init",
  "speak",
  "stop",
  "pause",
  "resume",
  "set_rate",
  "set_voice",
  "get_all_voices",
  "open_tts_settings",
  "install_tts_data",
  "shutdown",
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).build();
}

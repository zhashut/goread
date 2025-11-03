// main.rs

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 这里是关键改动
    tauri::Builder::default()
        // 使用 .plugin() 方法来初始化和注册你添加的插件
        // 每一个插件都需要在这里注册
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init()) // 你也安装了 opener 插件，所以一并注册
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

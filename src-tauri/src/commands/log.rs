use tauri::State;
use std::sync::Arc;
use tokio::sync::Mutex;
use sqlx::SqlitePool;

#[tauri::command]
pub async fn frontend_log(level: String, message: String, context: Option<String>, _db: State<'_, Arc<Mutex<SqlitePool>>>) -> Result<(), String> {
    match level.as_str() {
        "error" => {
            if let Some(ctx) = context {
                eprintln!("[frontend][error] {} :: {}", message, ctx);
            } else {
                eprintln!("[frontend][error] {}", message);
            }
        }
        "warn" => {
            if let Some(ctx) = context {
                println!("[frontend][warn] {} :: {}", message, ctx);
            } else {
                println!("[frontend][warn] {}", message);
            }
        }
        _ => {
            if let Some(ctx) = context {
                println!("[frontend][info] {} :: {}", message, ctx);
            } else {
                println!("[frontend][info] {}", message);
            }
        }
    }
    Ok(())
}
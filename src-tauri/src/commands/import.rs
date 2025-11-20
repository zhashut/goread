use crate::models::Book;
use crate::commands::book::DbState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize, Deserialize)]
pub struct PdfMetadata {
    pub path: String,
    pub title: String,
    pub total_pages: u32,
    pub cover_base64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchImportProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

/// 批量读取PDF文件字节数据（并行）
#[tauri::command]
pub async fn batch_read_files(paths: Vec<String>) -> Result<Vec<(String, Vec<u8>)>, String> {
    use tokio::task::JoinSet;
    
    let mut tasks = JoinSet::new();
    
    for path in paths {
        tasks.spawn(async move {
            let file_path = PathBuf::from(&path);
            if !file_path.exists() || !file_path.is_file() {
                return Err(format!("文件不存在或不是文件: {}", path));
            }
            
            match tokio::fs::read(&file_path).await {
                Ok(data) => Ok((path, data)),
                Err(e) => Err(format!("读取文件失败 {}: {}", path, e)),
            }
        });
    }
    
    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(data)) => results.push(data),
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("任务执行失败: {}", e)),
        }
    }
    
    Ok(results)
}

/// 批量导入书籍到数据库（使用事务）
#[tauri::command]
pub async fn batch_import_books(
    books: Vec<PdfMetadata>,
    group_id: Option<i64>,
    db: DbState<'_>,
) -> Result<Vec<Book>, String> {
    let pool = db.lock().await;
    let mut tx = pool.begin().await.map_err(|e| format!("开始事务失败: {}", e))?;
    
    let mut imported_books = Vec::new();
    
    for book_meta in books {
        // 插入书籍
        let result = sqlx::query(
            "INSERT OR IGNORE INTO books (title, file_path, cover_image, total_pages, group_id) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(&book_meta.title)
        .bind(&book_meta.path)
        .bind(&book_meta.cover_base64)
        .bind(book_meta.total_pages as i64)
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("插入书籍失败: {}", e))?;
        
        let book = if result.rows_affected() == 0 {
            // 已存在，查询现有记录
            sqlx::query_as::<_, Book>("SELECT * FROM books WHERE file_path = ?")
                .bind(&book_meta.path)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| format!("查询书籍失败: {}", e))?
        } else {
            // 新插入，获取记录
            let book_id = result.last_insert_rowid();
            sqlx::query_as::<_, Book>("SELECT * FROM books WHERE id = ?")
                .bind(book_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| format!("查询书籍失败: {}", e))?
        };
        
        imported_books.push(book);
    }
    
    // 更新分组书籍计数
    if let Some(gid) = group_id {
        sqlx::query(
            "UPDATE groups SET book_count = (SELECT COUNT(*) FROM books WHERE group_id = ?) WHERE id = ?"
        )
        .bind(gid)
        .bind(gid)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("更新分组计数失败: {}", e))?;
    }
    
    tx.commit().await.map_err(|e| format!("提交事务失败: {}", e))?;
    
    Ok(imported_books)
}

/// 批量处理PDF元数据（前端调用此命令获取元数据，然后在前端生成封面）
/// 这样可以利用前端的PDF.js和Canvas API
#[tauri::command]
pub async fn batch_get_pdf_info(paths: Vec<String>) -> Result<Vec<(String, u64)>, String> {
    use tokio::task::JoinSet;
    
    let mut tasks = JoinSet::new();
    
    for path in paths {
        tasks.spawn(async move {
            let file_path = PathBuf::from(&path);
            if !file_path.exists() || !file_path.is_file() {
                return Err(format!("文件不存在: {}", path));
            }
            
            match tokio::fs::metadata(&file_path).await {
                Ok(metadata) => Ok((path, metadata.len())),
                Err(e) => Err(format!("获取文件信息失败 {}: {}", path, e)),
            }
        });
    }
    
    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(data)) => results.push(data),
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("任务执行失败: {}", e)),
        }
    }
    
    Ok(results)
}

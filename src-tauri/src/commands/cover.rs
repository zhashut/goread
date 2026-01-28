//! 封面存储相关命令

use crate::cover;
use crate::models::Book;
use super::book::{DbState, Error};
use tauri::AppHandle;

/// 获取封面文件的可访问 URL
/// 如果封面是路径格式，返回转换后的完整路径
/// 如果封面是 Base64 格式，返回原始数据（兼容旧数据）
#[tauri::command]
pub async fn get_cover_url(
    app_handle: AppHandle,
    book_id: i64,
    db: DbState<'_>,
) -> Result<Option<String>, Error> {
    let pool = db.lock().await;
    
    let cover_image: Option<String> = sqlx::query_scalar(
        "SELECT cover_image FROM books WHERE id = ?"
    )
    .bind(book_id)
    .fetch_optional(&*pool)
    .await?
    .flatten();
    
    match cover_image {
        None => Ok(None),
        Some(ref data) if data.is_empty() => Ok(None),
        Some(ref data) => {
            if cover::is_file_path(data) {
                // 返回完整路径
                let full_path = cover::get_cover_full_path(&app_handle, data);
                Ok(Some(full_path.to_string_lossy().to_string()))
            } else {
                // Base64 或 data URL，返回原样
                Ok(Some(data.clone()))
            }
        }
    }
}

/// 迁移单本书的封面（Base64 -> 文件）
/// 返回新的相对路径
#[tauri::command]
pub async fn migrate_book_cover(
    app_handle: AppHandle,
    book_id: i64,
    db: DbState<'_>,
) -> Result<Option<String>, Error> {
    println!("[migrate_book_cover] Starting migration for book_id: {}", book_id);
    
    let pool = db.lock().await;
    
    // 获取书籍信息
    let book: Option<Book> = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE id = ?"
    )
    .bind(book_id)
    .fetch_optional(&*pool)
    .await?;
    
    let book = match book {
        Some(b) => b,
        None => {
            println!("[migrate_book_cover] Book not found: {}", book_id);
            return Err(Error::Message("Book not found".to_string()));
        }
    };
    
    let cover_image = match book.cover_image {
        Some(ref c) if !c.is_empty() => c.clone(),
        _ => {
            println!("[migrate_book_cover] Book {} has no cover, skipping", book_id);
            return Ok(None);
        }
    };
    
    // 如果已经是路径格式，不需要迁移
    if cover::is_file_path(&cover_image) {
        println!("[migrate_book_cover] Book {} cover is already file path: {}", book_id, &cover_image);
        return Ok(Some(cover_image));
    }
    
    println!("[migrate_book_cover] Book {} has Base64 cover (len={}), migrating...", book_id, cover_image.len());
    
    // 保存为文件
    let relative_path = cover::save_cover_from_base64(
        &app_handle,
        &book.file_path,
        &cover_image,
    ).await.map_err(|e| {
        println!("[migrate_book_cover] Failed to save cover for book {}: {}", book_id, e);
        Error::Message(e)
    })?;
    
    println!("[migrate_book_cover] Saved cover file: {}", &relative_path);
    
    // 更新数据库
    sqlx::query("UPDATE books SET cover_image = ? WHERE id = ?")
        .bind(&relative_path)
        .bind(book_id)
        .execute(&*pool)
        .await?;
    
    println!("[migrate_book_cover] Successfully migrated book {} cover to: {}", book_id, &relative_path);
    
    Ok(Some(relative_path))
}

/// 获取封面根目录路径
#[tauri::command]
pub async fn get_cover_root_path(app_handle: AppHandle) -> Result<String, Error> {
    let root = cover::cover_root(&app_handle);
    Ok(root.to_string_lossy().to_string())
}

/// 批量检查并返回需要重建封面的书籍列表
/// 用于备份导入后的批量封面重建
/// 返回值：需要重建封面的书籍 ID 和格式列表
#[tauri::command]
pub async fn get_books_needing_cover_rebuild(
    app_handle: AppHandle,
    db: DbState<'_>,
) -> Result<Vec<serde_json::Value>, Error> {
    let pool = db.lock().await;
    
    // 获取所有有封面记录的书籍
    let books: Vec<Book> = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE cover_image IS NOT NULL AND cover_image != ''"
    )
    .fetch_all(&*pool)
    .await?;
    
    let mut needs_rebuild = Vec::new();
    
    for book in books {
        if let Some(ref cover_image) = book.cover_image {
            // 只处理路径格式的封面（Base64 封面由懒迁移处理）
            if cover::is_file_path(cover_image) {
                // 检查文件是否存在
                let exists = cover::cover_file_exists(&app_handle, cover_image).await;
                if !exists {
                    // 获取书籍格式
                    let format = cover::get_book_format(&book.file_path);
                    // 只有支持封面重建的格式才加入列表
                    if cover::can_rebuild_cover(&book.file_path) {
                        needs_rebuild.push(serde_json::json!({
                            "id": book.id,
                            "file_path": book.file_path,
                            "format": format,
                            "title": book.title
                        }));
                    } else {
                        // 不支持重建的格式，清空封面字段
                        if let Some(book_id) = book.id {
                            sqlx::query("UPDATE books SET cover_image = NULL WHERE id = ?")
                                .bind(book_id)
                                .execute(&*pool)
                                .await?;
                        }
                    }
                }
            }
        }
    }
    
    Ok(needs_rebuild)
}

/// 获取封面为空但文件存在的 EPUB 书籍列表
/// 用于备份导入后为这些书籍生成封面
#[tauri::command]
pub async fn get_epub_books_without_cover(
    db: DbState<'_>,
) -> Result<Vec<serde_json::Value>, Error> {
    let pool = db.lock().await;
    
    // 查找封面为空的 EPUB 书籍
    let books: Vec<Book> = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE (cover_image IS NULL OR cover_image = '') AND LOWER(file_path) LIKE '%.epub'"
    )
    .fetch_all(&*pool)
    .await?;
    
    let mut result = Vec::new();
    
    for book in books {
        // 检查书籍文件是否存在
        let file_exists = std::path::Path::new(&book.file_path).exists();
        if file_exists {
            result.push(serde_json::json!({
                "id": book.id,
                "file_path": book.file_path,
                "format": "epub",
                "title": book.title
            }));
        }
    }
    
    Ok(result)
}

/// 为 PDF 书籍重建封面
/// 调用 pdf_render_page_base64 渲染首页并保存为文件
#[tauri::command]
pub async fn rebuild_pdf_cover(
    app_handle: AppHandle,
    book_id: i64,
    cover_data: String,
    db: DbState<'_>,
) -> Result<Option<String>, Error> {
    let pool = db.lock().await;
    
    // 获取书籍信息
    let book: Option<Book> = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE id = ?"
    )
    .bind(book_id)
    .fetch_optional(&*pool)
    .await?;
    
    let book = match book {
        Some(b) => b,
        None => return Err(Error::Message("Book not found".to_string())),
    };
    
    // 保存封面到文件
    let relative_path = cover::save_cover_from_base64(
        &app_handle,
        &book.file_path,
        &cover_data,
    ).await.map_err(Error::Message)?;
    
    // 更新数据库
    sqlx::query("UPDATE books SET cover_image = ? WHERE id = ?")
        .bind(&relative_path)
        .bind(book_id)
        .execute(&*pool)
        .await?;
    
    Ok(Some(relative_path))
}

/// 为 EPUB 书籍重建封面
#[tauri::command]
pub async fn rebuild_epub_cover(
    app_handle: AppHandle,
    book_id: i64,
    cover_data: String,
    db: DbState<'_>,
) -> Result<Option<String>, Error> {
    let pool = db.lock().await;

    let book: Option<Book> = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE id = ?"
    )
    .bind(book_id)
    .fetch_optional(&*pool)
    .await?;

    let book = match book {
        Some(b) => b,
        None => return Err(Error::Message("Book not found".to_string())),
    };

    let format = cover::get_book_format(&book.file_path);
    if format != "epub" {
        return Err(Error::Message("Not an EPUB book".to_string()));
    }

    let relative_path = cover::save_cover_from_base64(
        &app_handle,
        &book.file_path,
        &cover_data,
    ).await.map_err(Error::Message)?;

    sqlx::query("UPDATE books SET cover_image = ? WHERE id = ?")
        .bind(&relative_path)
        .bind(book_id)
        .execute(&*pool)
        .await?;

    Ok(Some(relative_path))
}

/// 清空书籍的封面字段（用于重建失败时）
#[tauri::command]
pub async fn clear_book_cover(
    book_id: i64,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;
    
    sqlx::query("UPDATE books SET cover_image = NULL WHERE id = ?")
        .bind(book_id)
        .execute(&*pool)
        .await?;
    
    Ok(())
}

/// 为 MOBI 书籍重建封面
#[tauri::command]
pub async fn rebuild_mobi_cover(
    app_handle: AppHandle,
    book_id: i64,
    cover_data: String,
    db: DbState<'_>,
) -> Result<Option<String>, Error> {
    let pool = db.lock().await;

    let book: Option<Book> = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE id = ?"
    )
    .bind(book_id)
    .fetch_optional(&*pool)
    .await?;

    let book = match book {
        Some(b) => b,
        None => return Err(Error::Message("Book not found".to_string())),
    };

    let format = cover::get_book_format(&book.file_path);
    if format != "mobi" {
        return Err(Error::Message("Not a MOBI book".to_string()));
    }

    let relative_path = cover::save_cover_from_base64(
        &app_handle,
        &book.file_path,
        &cover_data,
    ).await.map_err(Error::Message)?;

    sqlx::query("UPDATE books SET cover_image = ? WHERE id = ?")
        .bind(&relative_path)
        .bind(book_id)
        .execute(&*pool)
        .await?;

    Ok(Some(relative_path))
}

/// 获取封面为空但文件存在的 MOBI 书籍列表
/// 用于备份导入后为这些书籍生成封面
#[tauri::command]
pub async fn get_mobi_books_without_cover(
    db: DbState<'_>,
) -> Result<Vec<serde_json::Value>, Error> {
    let pool = db.lock().await;
    
    // 查找封面为空的 MOBI 书籍（支持 .mobi, .azw3, .azw 扩展名）
    let books: Vec<Book> = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE (cover_image IS NULL OR cover_image = '') AND (LOWER(file_path) LIKE '%.mobi' OR LOWER(file_path) LIKE '%.azw3' OR LOWER(file_path) LIKE '%.azw')"
    )
    .fetch_all(&*pool)
    .await?;
    
    let mut result = Vec::new();
    
    for book in books {
        // 检查书籍文件是否存在
        let file_exists = std::path::Path::new(&book.file_path).exists();
        if file_exists {
            result.push(serde_json::json!({
                "id": book.id,
                "file_path": book.file_path,
                "format": "mobi",
                "title": book.title
            }));
        }
    }
    
    Ok(result)
}

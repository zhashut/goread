use crate::models::{Book, Group};
use crate::commands::book::{DbState, Error};
use crate::cover;
use sqlx::SqlitePool;
use tauri::AppHandle;
use futures::future::join_all;

#[tauri::command]
pub async fn add_group(name: String, db: DbState<'_>) -> Result<Group, Error> {
    let pool = db.lock().await;

    // 获取当前最大 sort_order
    let max_order: Option<i64> =
        sqlx::query_scalar("SELECT MAX(sort_order) FROM groups WHERE book_count > 0")
            .fetch_one(&*pool)
            .await?;
    let next_order = max_order.unwrap_or(0) + 1;

    let result = sqlx::query("INSERT INTO groups (name, sort_order) VALUES (?, ?)")
        .bind(&name)
        .bind(next_order)
        .execute(&*pool)
        .await?;

    let group_id = result.last_insert_rowid();

    let group = sqlx::query_as::<_, Group>("SELECT * FROM groups WHERE id = ?")
        .bind(group_id)
        .fetch_one(&*pool)
        .await?;

    Ok(group)
}

#[tauri::command]
pub async fn get_all_groups(db: DbState<'_>) -> Result<Vec<Group>, Error> {
    let pool = db.lock().await;

    let groups = sqlx::query_as::<_, Group>(
        "SELECT * FROM groups WHERE book_count > 0 ORDER BY sort_order DESC, created_at DESC",
    )
    .fetch_all(&*pool)
    .await?;

    Ok(groups)
}

#[tauri::command]
pub async fn update_group(group_id: i64, name: String, db: DbState<'_>) -> Result<(), Error> {
    if name.trim().is_empty() {
        return Err(Error::from("分组名称不能为空".to_string()));
    }

    let pool = db.lock().await;

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM groups WHERE name = ? AND id != ?")
        .bind(&name)
        .bind(group_id)
        .fetch_one(&*pool)
        .await?;

    if count > 0 {
        return Err(Error::from("分组名称已存在".to_string()));
    }

    sqlx::query("UPDATE groups SET name = ? WHERE id = ?")
        .bind(&name)
        .bind(group_id)
        .execute(&*pool)
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn delete_group(app_handle: AppHandle, group_id: i64, delete_local: bool, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    // 获取分组内所有书籍的文件路径和封面路径
    let books: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT file_path, cover_image FROM books WHERE group_id = ?")
            .bind(group_id)
            .fetch_all(&*pool)
            .await?;

    // 删除本地书籍文件（如果需要）
    if delete_local {
        for (file_path, _) in &books {
            match tokio::fs::remove_file(file_path).await {
                Ok(_) => {
                    println!("[delete_group] Successfully deleted local file: {}", file_path);
                }
                Err(e) => {
                    eprintln!("[delete_group] Failed to delete local file {}: {}", file_path, e);
                }
            }
        }
    }

    // 批量并发删除封面图片文件
    let cover_delete_futures: Vec<_> = books
        .iter()
        .filter_map(|(_, cover_image)| {
            cover_image.as_ref().and_then(|cover_path| {
                // 只删除文件路径格式的封面（非 base64/data URL）
                if !cover_path.is_empty() && !cover_path.starts_with("data:") {
                    Some((app_handle.clone(), cover_path.clone()))
                } else {
                    None
                }
            })
        })
        .map(|(handle, cover_path)| async move {
            match cover::delete_cover_file(&handle, &cover_path).await {
                Ok(_) => println!("[delete_group] Successfully deleted cover: {}", cover_path),
                Err(e) => eprintln!("[delete_group] Failed to delete cover {}: {}", cover_path, e),
            }
        })
        .collect();
    
    join_all(cover_delete_futures).await;

    let mut tx = (&*pool).begin().await?;
    sqlx::query("DELETE FROM books WHERE group_id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM groups WHERE id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn get_books_by_group(group_id: i64, db: DbState<'_>) -> Result<Vec<Book>, Error> {
    let pool = db.lock().await;

    let books = sqlx::query_as::<_, Book>(
        "SELECT * FROM books WHERE group_id = ? ORDER BY position_in_group IS NULL, position_in_group DESC, created_at DESC"
    )
    .bind(group_id)
    .fetch_all(&*pool).await?;

    Ok(books)
}

#[tauri::command]
pub async fn move_book_to_group(
    book_id: i64,
    group_id: Option<i64>,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;
    let prev_group: Option<i64> = sqlx::query_scalar("SELECT group_id FROM books WHERE id = ?")
        .bind(book_id)
        .fetch_one(&*pool)
        .await?;

    if let Some(gid) = group_id {
        let max_pos: Option<i64> =
            sqlx::query_scalar("SELECT MAX(position_in_group) FROM books WHERE group_id = ?")
                .bind(gid)
                .fetch_one(&*pool)
                .await?;
        let next_pos = max_pos.unwrap_or(0) + 1;
        sqlx::query("UPDATE books SET group_id = ?, position_in_group = ? WHERE id = ?")
            .bind(gid)
            .bind(next_pos)
            .bind(book_id)
            .execute(&*pool)
            .await?;
    } else {
        sqlx::query("UPDATE books SET group_id = NULL, position_in_group = NULL WHERE id = ?")
            .bind(book_id)
            .execute(&*pool)
            .await?;
    }
    
    if let Some(pg) = prev_group {
        sqlx::query(
            "UPDATE groups SET book_count = (SELECT COUNT(*) FROM books WHERE group_id = ?) WHERE id = ?"
        )
        .bind(pg)
        .bind(pg)
        .execute(&*pool).await?;
        sqlx::query("DELETE FROM groups WHERE id = ? AND book_count = 0")
            .bind(pg)
            .execute(&*pool)
            .await?;
    }
    if let Some(ng) = group_id {
        sqlx::query(
            "UPDATE groups SET book_count = (SELECT COUNT(*) FROM books WHERE group_id = ?) WHERE id = ?"
        )
        .bind(ng)
        .bind(ng)
        .execute(&*pool).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn reorder_group_books(
    group_id: i64,
    ordered_ids: Vec<i64>,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;
    let mut tx = (&*pool).begin().await?;
    let total = ordered_ids.len() as i64;
    for (idx, bid) in ordered_ids.iter().enumerate() {
        let pos_desc = total - (idx as i64); // 让列表前面的书具有更大的 position 值
        sqlx::query("UPDATE books SET position_in_group = ? WHERE id = ? AND group_id = ?")
            .bind(pos_desc)
            .bind(bid)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 重排分组顺序
#[tauri::command]
pub async fn reorder_groups(
    ordered_ids: Vec<i64>,
    db: DbState<'_>,
) -> Result<(), Error> {
    let pool = db.lock().await;

    // 获取当前全局最大 sort_order 作为基准
    // 确保拖拽后的分组顺序值都高于未参与拖拽的分组
    let max_order: Option<i64> =
        sqlx::query_scalar("SELECT MAX(sort_order) FROM groups WHERE book_count > 0")
            .fetch_one(&*pool)
            .await?;

    let base = max_order.unwrap_or(0);
    let total = ordered_ids.len() as i64;

    let mut tx = (&*pool).begin().await?;
    for (idx, gid) in ordered_ids.iter().enumerate() {
        // 第一个分组获得最高值 (base + total)，最后一个获得 (base + 1)
        let order_val = base + total - (idx as i64);
        sqlx::query("UPDATE groups SET sort_order = ? WHERE id = ?")
            .bind(order_val)
            .bind(gid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

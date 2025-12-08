use crate::models::{Book, Group};
use crate::commands::book::{DbState, Error};
use sqlx::SqlitePool;

#[tauri::command]
pub async fn add_group(name: String, db: DbState<'_>) -> Result<Group, Error> {
    let pool = db.lock().await;

    let result = sqlx::query("INSERT INTO groups (name) VALUES (?)")
        .bind(&name)
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
        "SELECT * FROM groups WHERE book_count > 0 ORDER BY created_at desc",
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
pub async fn delete_group(group_id: i64, delete_local: bool, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    if delete_local {
        let paths: Vec<(String,)> =
            sqlx::query_as("SELECT file_path FROM books WHERE group_id = ?")
                .bind(group_id)
                .fetch_all(&*pool)
                .await?;

        for (p,) in paths {
            match tokio::fs::remove_file(&p).await {
                Ok(_) => {
                    println!("[delete_group] Successfully deleted local file: {}", p);
                }
                Err(e) => {
                    eprintln!("[delete_group] Failed to delete local file {}: {}", p, e);
                }
            }
        }
    }

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

use crate::models::Bookmark;
use crate::commands::book::{DbState, Error};

#[tauri::command]
pub async fn add_bookmark(
    book_id: i64,
    page_number: u32,
    title: String,
    db: DbState<'_>,
) -> Result<Bookmark, Error> {
    let pool = db.lock().await;

    let result =
        sqlx::query("INSERT INTO bookmarks (book_id, page_number, title) VALUES (?, ?, ?)")
            .bind(book_id)
            .bind(page_number as i64)
            .bind(&title)
            .execute(&*pool)
            .await?;

    let bookmark_id = result.last_insert_rowid();

    let bookmark = sqlx::query_as::<_, Bookmark>("SELECT * FROM bookmarks WHERE id = ?")
        .bind(bookmark_id)
        .fetch_one(&*pool)
        .await?;

    Ok(bookmark)
}

#[tauri::command]
pub async fn get_bookmarks(book_id: i64, db: DbState<'_>) -> Result<Vec<Bookmark>, Error> {
    let pool = db.lock().await;

    let bookmarks = sqlx::query_as::<_, Bookmark>(
        "SELECT * FROM bookmarks WHERE book_id = ? ORDER BY page_number",
    )
    .bind(book_id)
    .fetch_all(&*pool)
    .await?;

    Ok(bookmarks)
}

#[tauri::command]
pub async fn delete_bookmark(id: i64, db: DbState<'_>) -> Result<(), Error> {
    let pool = db.lock().await;

    sqlx::query("DELETE FROM bookmarks WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await?;
    Ok(())
}

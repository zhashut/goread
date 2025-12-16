use crate::models::{BookReadingStats, DailyStats, RangeStats, ReadingSession, StatsSummary};
use chrono::{Datelike, Local, TimeZone, Timelike};
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

pub type DbState<'a> = State<'a, Arc<Mutex<SqlitePool>>>;

/// 保存阅读会话记录
#[tauri::command]
pub async fn save_reading_session(
    book_id: i64,
    duration: i64,
    start_time: i64,
    read_date: String,
    pages_read_count: Option<i64>,
    db: DbState<'_>,
) -> Result<(), String> {
    let pool = db.lock().await;

    sqlx::query(
        "INSERT INTO reading_sessions (book_id, start_time, duration, read_date, pages_read_count) 
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(book_id)
    .bind(start_time)
    .bind(duration)
    .bind(&read_date)
    .bind(pages_read_count)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 获取统计概览数据
#[tauri::command]
pub async fn get_stats_summary(db: DbState<'_>) -> Result<StatsSummary, String> {
    let pool = db.lock().await;

    // 总阅读时长
    let total_time: (i64,) = sqlx::query_as("SELECT COALESCE(SUM(duration), 0) FROM reading_sessions")
        .fetch_one(&*pool)
        .await
        .map_err(|e| e.to_string())?;

    // 已读完书籍数：status=1（手动标记）或 进度达到100%（current_page >= total_pages 且 total_pages > 1）
    // 注：total_pages = 1 的书籍（如 Markdown/HTML）使用虚拟页，仅依赖 status 字段判断
    let finished_count: (i64,) =
    sqlx::query_as("SELECT COUNT(*) FROM books WHERE status = 1 OR (total_pages > 1 AND current_page >= total_pages)")            .fetch_one(&*pool)
            .await
            .map_err(|e| e.to_string())?;

    // 连续阅读天数计算
    let dates: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT read_date FROM reading_sessions ORDER BY read_date DESC",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    let streak_days = calculate_streak_days(&dates.iter().map(|d| d.0.as_str()).collect::<Vec<_>>());

    Ok(StatsSummary {
        total_time_seconds: total_time.0,
        streak_days,
        finished_books: finished_count.0,
    })
}

/// 计算连续阅读天数
fn calculate_streak_days(dates: &[&str]) -> i64 {
    if dates.is_empty() {
        return 0;
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();

    // 从今天或昨天开始计算连续天数
    let start_idx = if dates.first() == Some(&&today[..]) {
        0
    } else if dates.first() == Some(&&yesterday[..]) {
        0
    } else {
        return 0; // 最近没有阅读记录
    };

    let mut streak = 1i64;
    for i in start_idx..dates.len() - 1 {
        let current = chrono::NaiveDate::parse_from_str(dates[i], "%Y-%m-%d");
        let next = chrono::NaiveDate::parse_from_str(dates[i + 1], "%Y-%m-%d");

        if let (Ok(curr), Ok(nxt)) = (current, next) {
            if curr - nxt == chrono::Duration::days(1) {
                streak += 1;
            } else {
                break;
            }
        }
    }

    streak
}

/// 获取每日统计数据（热力图用）
#[tauri::command]
pub async fn get_daily_stats(days: i64, db: DbState<'_>) -> Result<Vec<DailyStats>, String> {
    let pool = db.lock().await;

    let start_date = (chrono::Local::now() - chrono::Duration::days(days - 1))
        .format("%Y-%m-%d")
        .to_string();

    let stats: Vec<DailyStats> = sqlx::query_as(
        "SELECT read_date as date, SUM(duration) as total_seconds 
         FROM reading_sessions 
         WHERE read_date >= ? 
         GROUP BY read_date 
         ORDER BY read_date",
    )
    .bind(&start_date)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(stats)
}

/// 获取时间范围内的统计数据（柱状图用）
#[tauri::command]
pub async fn get_reading_stats_by_range(
    range_type: String,
    offset: i64,
    db: DbState<'_>,
) -> Result<RangeStats, String> {
    let pool = db.lock().await;
    let now = chrono::Local::now();

    let (start_date, end_date, labels, prev_start, prev_end) = match range_type.as_str() {
        "day" => {
            // 当日按时段分（0-6, 6-12, 12-18, 18-24）
            let date = (now - chrono::Duration::days(offset)).format("%Y-%m-%d").to_string();
            let prev_date = (now - chrono::Duration::days(offset + 1)).format("%Y-%m-%d").to_string();
            (
                date.clone(),
                date,
                vec!["0-6点".to_string(), "6-12点".to_string(), "12-18点".to_string(), "18-24点".to_string()],
                prev_date.clone(),
                prev_date,
            )
        }
        "week" => {
            // 本周按周一到周日
            let start_of_week = now - chrono::Duration::days(now.weekday().num_days_from_monday() as i64 + offset * 7);
            let end_of_week = start_of_week + chrono::Duration::days(6);
            let prev_start_of_week = start_of_week - chrono::Duration::days(7);
            let prev_end_of_week = end_of_week - chrono::Duration::days(7);
            (
                start_of_week.format("%Y-%m-%d").to_string(),
                end_of_week.format("%Y-%m-%d").to_string(),
                vec!["周一".to_string(), "周二".to_string(), "周三".to_string(), "周四".to_string(), "周五".to_string(), "周六".to_string(), "周日".to_string()],
                prev_start_of_week.format("%Y-%m-%d").to_string(),
                prev_end_of_week.format("%Y-%m-%d").to_string(),
            )
        }
        "month" => {
            // 本月按周分
            let month_start = now - chrono::Duration::days(now.day() as i64 - 1 + offset * 30);
            let month_end = month_start + chrono::Duration::days(29);
            let prev_month_start = month_start - chrono::Duration::days(30);
            let prev_month_end = month_end - chrono::Duration::days(30);
            (
                month_start.format("%Y-%m-%d").to_string(),
                month_end.format("%Y-%m-%d").to_string(),
                vec!["第一周".to_string(), "第二周".to_string(), "第三周".to_string(), "第四周".to_string()],
                prev_month_start.format("%Y-%m-%d").to_string(),
                prev_month_end.format("%Y-%m-%d").to_string(),
            )
        }
        "year" => {
            // 本年按月分
            let year = now.year() - offset as i32;
            let start = format!("{}-01-01", year);
            let end = format!("{}-12-31", year);
            let prev_start = format!("{}-01-01", year - 1);
            let prev_end = format!("{}-12-31", year - 1);
            (
                start,
                end,
                (1..=12).map(|m| format!("{}月", m)).collect(),
                prev_start,
                prev_end,
            )
        }
        _ => return Err("Invalid range_type".to_string()),
    };

    // 查询当前周期数据
    let current_data: Vec<(String, i64)> = sqlx::query_as(
        "SELECT read_date, SUM(duration) as total 
         FROM reading_sessions 
         WHERE read_date BETWEEN ? AND ? 
         GROUP BY read_date",
    )
    .bind(&start_date)
    .bind(&end_date)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    // 查询上一周期总时长
    let prev_total: (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(duration), 0) FROM reading_sessions WHERE read_date BETWEEN ? AND ?",
    )
    .bind(&prev_start)
    .bind(&prev_end)
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    // 根据类型聚合数据
    let values = aggregate_by_range(&range_type, &start_date, &current_data, labels.len());
    let total_seconds: i64 = values.iter().sum();

    Ok(RangeStats {
        labels,
        values,
        start_date,
        end_date,
        total_seconds,
        previous_total_seconds: prev_total.0,
    })
}

/// 根据范围类型聚合数据
fn aggregate_by_range(
    range_type: &str,
    start_date: &str,
    data: &[(String, i64)],
    bucket_count: usize,
) -> Vec<i64> {
    let mut values = vec![0i64; bucket_count];

    for (date_str, duration) in data {
        if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
            let idx = match range_type {
                "day" => {
                    // 日视图：已经在查询时按时段聚合，这里简单处理
                    continue;
                }
                "week" => {
                    // 周视图：按星期几
                    date.weekday().num_days_from_monday() as usize
                }
                "month" => {
                    // 月视图：按周数
                    ((date.day() - 1) / 7) as usize
                }
                "year" => {
                    // 年视图：按月份
                    (date.month() - 1) as usize
                }
                _ => continue,
            };

            if idx < bucket_count {
                values[idx] += duration;
            }
        }
    }

    values
}

/// 获取日视图的分时段数据
#[tauri::command]
pub async fn get_day_stats_by_hour(
    date: String,
    db: DbState<'_>,
) -> Result<Vec<i64>, String> {
    let pool = db.lock().await;

    // 查询该日期所有记录
    let sessions: Vec<ReadingSession> = sqlx::query_as(
        "SELECT * FROM reading_sessions WHERE read_date = ?",
    )
    .bind(&date)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    // 按时段分组（0-6, 6-12, 12-18, 18-24），使用本地时区
    let mut values = vec![0i64; 4];
    for session in sessions {
        let hour = Local
            .timestamp_opt(session.start_time, 0)
            .single()
            .map(|dt| dt.hour())
            .unwrap_or(0);
        let idx = (hour / 6) as usize;
        if idx < 4 {
            values[idx] += session.duration;
        }
    }

    Ok(values)
}

/// 获取时间段内阅读的书籍列表
#[tauri::command]
pub async fn get_books_by_date_range(
    start_date: String,
    end_date: String,
    db: DbState<'_>,
) -> Result<Vec<BookReadingStats>, String> {
    let pool = db.lock().await;

    // last_read 返回最后一次阅读的时间戳（秒），方便前端格式化显示
    let books: Vec<BookReadingStats> = sqlx::query_as(
        "SELECT 
            b.id as book_id, 
            b.title, 
            b.cover_image, 
            COALESCE(SUM(rs.duration), 0) as total_duration,
            CASE 
                WHEN b.total_pages > 0 THEN CAST(ROUND(b.current_page * 100.0 / b.total_pages) AS TEXT) || '%'
                ELSE '0%'
            END as progress,
            CAST(COALESCE(MAX(rs.start_time), 0) AS TEXT) as last_read
         FROM reading_sessions rs
         JOIN books b ON rs.book_id = b.id
         WHERE rs.read_date BETWEEN ? AND ?
         GROUP BY rs.book_id
         ORDER BY MAX(rs.start_time) DESC",
    )
    .bind(&start_date)
    .bind(&end_date)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(books)
}

/// 标记书籍为已读完
#[tauri::command]
pub async fn mark_book_finished(book_id: i64, db: DbState<'_>) -> Result<(), String> {
    let pool = db.lock().await;

    let now = chrono::Local::now().timestamp();
    
    sqlx::query("UPDATE books SET status = 1, finished_at = ? WHERE id = ?")
        .bind(now)
        .bind(book_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 取消书籍已读完状态
#[tauri::command]
pub async fn unmark_book_finished(book_id: i64, db: DbState<'_>) -> Result<(), String> {
    let pool = db.lock().await;

    sqlx::query("UPDATE books SET status = 0, finished_at = NULL WHERE id = ?")
        .bind(book_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 检查书籍是否有阅读记录
#[tauri::command]
pub async fn has_reading_sessions(book_id: i64, db: DbState<'_>) -> Result<bool, String> {
    let pool = db.lock().await;

    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM reading_sessions WHERE book_id = ?",
    )
    .bind(book_id)
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(count.0 > 0)
}

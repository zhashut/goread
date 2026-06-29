use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};
use tauri_plugin_native_tts::NativeTtsExt;
use tokio::sync::{watch, Mutex};

use crate::tts::dispatcher;
use crate::tts::types::{
    TtsAnchorDto, TtsGetSegmentsRequest, TtsManagedSessionStartRequest, TtsManagedSessionStatus,
    TtsManagedSessionSetRateRequest, TtsManagedSessionSetVoiceRequest, TtsSegmentDto,
};

const CHARS_PER_SECOND_AT_RATE_ONE: f64 = 5.5;
const DEFAULT_LOW_WATERMARK_SECONDS: f64 = 20.0;
const TICK_INTERVAL: Duration = Duration::from_millis(1000);
const URGENT_REMAINING_SECONDS: f64 = 15.0;
const CRITICAL_REMAINING_SECONDS: f64 = 6.0;
const URGENT_MULTIPLIER: u32 = 2;
const CRITICAL_MULTIPLIER: u32 = 3;

#[derive(Default)]
struct ManagedSessionRuntime {
    active: bool,
    paused: bool,
    end_of_book: bool,
    cursor: Option<String>,
    buffer_seconds: f64,
    low_watermark_seconds: f64,
    request: Option<TtsGetSegmentsRequest>,
    rate: f32,
    voice_id: Option<String>,
    lang: Option<String>,
    stop_tx: Option<watch::Sender<bool>>,
    join: Option<tokio::task::JoinHandle<()>>,
    last_tick: Option<Instant>,
}

pub struct ManagedTtsSessionState {
    inner: Mutex<ManagedSessionRuntime>,
}

impl ManagedTtsSessionState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ManagedSessionRuntime::default()),
        }
    }

    pub async fn status(&self) -> TtsManagedSessionStatus {
        let s = self.inner.lock().await;
        TtsManagedSessionStatus {
            active: s.active,
            paused: s.paused,
            end_of_book: s.end_of_book,
            cursor: s.cursor.clone(),
            buffer_seconds: s.buffer_seconds,
        }
    }

    pub async fn start<R: Runtime>(
        self: &Arc<Self>,
        app: AppHandle<R>,
        payload: TtsManagedSessionStartRequest,
    ) -> Result<(), String> {
        self.stop_internal(app.clone(), false).await.ok();
        let low = payload
            .low_watermark_seconds
            .unwrap_or(DEFAULT_LOW_WATERMARK_SECONDS)
            .max(1.0);

        let mut s = self.inner.lock().await;
        s.active = true;
        s.paused = false;
        s.end_of_book = false;
        s.cursor = payload.request.cursor.clone();
        s.buffer_seconds = 0.0;
        s.low_watermark_seconds = low;
        s.rate = payload.rate;
        s.voice_id = payload.voice_id.clone();
        s.lang = payload.lang.clone();
        s.request = Some(payload.request.clone());
        s.last_tick = Some(Instant::now());

        let (stop_tx, stop_rx) = watch::channel(false);
        s.stop_tx = Some(stop_tx);
        let state = Arc::clone(self);
        s.join = Some(tokio::spawn(async move {
            run_managed_loop(app, state, stop_rx).await;
        }));
        Ok(())
    }

    pub async fn stop<R: Runtime>(&self, app: AppHandle<R>) -> Result<(), String> {
        self.stop_internal(app, true).await
    }

    async fn stop_internal<R: Runtime>(
        &self,
        app: AppHandle<R>,
        emit_stopped_event: bool,
    ) -> Result<(), String> {
        let (tx, join) = {
            let mut s = self.inner.lock().await;
            s.active = false;
            s.paused = false;
            s.end_of_book = false;
            s.cursor = None;
            s.buffer_seconds = 0.0;
            s.request = None;
            s.last_tick = None;
            (s.stop_tx.take(), s.join.take())
        };
        if let Some(tx) = tx {
            let _ = tx.send(true);
        }
        if let Some(join) = join {
            let _ = join.await;
        }
        app.native_tts()
            .tts_session_stop_with_request(tauri_plugin_native_tts::TTSSessionStopRequest {
                emit_stopped_event,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn pause<R: Runtime>(&self, app: AppHandle<R>) -> Result<(), String> {
        {
            let mut s = self.inner.lock().await;
            if !s.active {
                return Ok(());
            }
            s.paused = true;
            s.last_tick = Some(Instant::now());
        }
        app.native_tts()
            .tts_session_pause()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn resume<R: Runtime>(&self, app: AppHandle<R>) -> Result<(), String> {
        {
            let mut s = self.inner.lock().await;
            if !s.active {
                return Ok(());
            }
            s.paused = false;
            s.last_tick = Some(Instant::now());
        }
        app.native_tts()
            .tts_session_resume()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn set_rate<R: Runtime>(
        &self,
        app: AppHandle<R>,
        payload: TtsManagedSessionSetRateRequest,
    ) -> Result<(), String> {
        {
            let mut s = self.inner.lock().await;
            s.rate = payload.rate;
        }
        app.native_tts()
            .tts_session_set_rate(tauri_plugin_native_tts::SetRateArgs {
                rate: payload.rate,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn set_voice<R: Runtime>(
        &self,
        app: AppHandle<R>,
        payload: TtsManagedSessionSetVoiceRequest,
    ) -> Result<(), String> {
        {
            let mut s = self.inner.lock().await;
            s.voice_id = Some(payload.voice_id.clone());
        }
        app.native_tts()
            .tts_session_set_voice(tauri_plugin_native_tts::SetVoiceArgs {
                voice: payload.voice_id,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

async fn run_managed_loop<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<ManagedTtsSessionState>,
    mut stop_rx: watch::Receiver<bool>,
) {
    if let Err(e) = start_native_session(&app, &state).await {
        println!("[TTS][Managed] start native session failed: {}", e);
        let _ = state.stop(app).await;
        return;
    }

    loop {
        if *stop_rx.borrow() {
            break;
        }

        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            _ = tokio::time::sleep(TICK_INTERVAL) => {
                tick_buffer(&state).await;
                if let Err(e) = maybe_refill(&app, &state).await {
                    println!("[TTS][Managed] refill error: {}", e);
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                }
                if should_auto_finish(&state).await {
                    break;
                }
            }
        }
    }

    {
        let mut s = state.inner.lock().await;
        s.active = false;
        s.paused = false;
    }
}

async fn start_native_session<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<ManagedTtsSessionState>,
) -> Result<(), String> {
    let (req, rate, voice_id, lang, low) = {
        let s = state.inner.lock().await;
        let req = s.request.clone().ok_or("session request missing")?;
        (req, s.rate, s.voice_id.clone(), s.lang.clone(), s.low_watermark_seconds)
    };
    println!(
        "[TTS][Managed] start: format={} rate={} voiceId={} lowWatermark={}",
        req.format,
        rate,
        voice_id.clone().unwrap_or_default(),
        low
    );
    let batch = get_segments(app, &req).await?;
    let segments = batch.segments;
    let end_of_book = !batch.has_more;

    {
        let mut s = state.inner.lock().await;
        s.cursor = batch.cursor.clone();
        s.end_of_book = end_of_book;
        s.low_watermark_seconds = low;
        s.buffer_seconds = estimate_segments_seconds(&segments, rate);
        s.last_tick = Some(Instant::now());
    }

    app.native_tts()
        .tts_session_start(tauri_plugin_native_tts::TTSSessionStartRequest {
            segments: segments.iter().map(map_to_native_segment).collect(),
            lang,
            rate,
            voice_id,
            end_of_book,
        })
        .map_err(|e| e.to_string())?;
    println!(
        "[TTS][Managed] started: segments={} bufferSeconds={:.2} endOfBook={}",
        segments.len(),
        estimate_segments_seconds(&segments, rate),
        end_of_book
    );

    if end_of_book {
        app.native_tts()
            .tts_session_set_end_of_book(tauri_plugin_native_tts::TTSSessionSetEndOfBookRequest {
                end_of_book: true,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn tick_buffer(state: &Arc<ManagedTtsSessionState>) {
    let mut s = state.inner.lock().await;
    if !s.active || s.paused {
        s.last_tick = Some(Instant::now());
        return;
    }
    let now = Instant::now();
    let last = s.last_tick.unwrap_or(now);
    s.last_tick = Some(now);
    let elapsed = now.saturating_duration_since(last).as_secs_f64();
    if elapsed <= 0.0 {
        return;
    }
    s.buffer_seconds = (s.buffer_seconds - elapsed).max(0.0);
}

async fn maybe_refill<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<ManagedTtsSessionState>,
) -> Result<(), String> {
    let (should_refill, req, cursor, max_segments, rate, end_of_book, buffer_seconds, low_watermark) = {
        let s = state.inner.lock().await;
        if !s.active || s.paused || s.end_of_book {
            return Ok(());
        }
        let req = s.request.clone().ok_or("session request missing")?;
        let base = req.max_segments.max(1);
        let max_segments = if s.buffer_seconds <= CRITICAL_REMAINING_SECONDS {
            base.saturating_mul(CRITICAL_MULTIPLIER)
        } else if s.buffer_seconds <= URGENT_REMAINING_SECONDS {
            base.saturating_mul(URGENT_MULTIPLIER)
        } else {
            base
        };
        let should = s.buffer_seconds <= s.low_watermark_seconds;
        (
            should,
            req,
            s.cursor.clone(),
            max_segments,
            s.rate,
            s.end_of_book,
            s.buffer_seconds,
            s.low_watermark_seconds,
        )
    };

    if end_of_book || !should_refill {
        return Ok(());
    }

    println!(
        "[TTS][Managed] refill check: bufferSeconds={:.2} lowWatermark={:.2} maxSegments={}",
        buffer_seconds,
        low_watermark,
        max_segments
    );

    let mut req2 = req;
    req2.cursor = cursor;
    req2.max_segments = max_segments;
    let batch = get_segments(app, &req2).await?;
    if batch.segments.is_empty() {
        {
            let mut s = state.inner.lock().await;
            s.cursor = batch.cursor.clone();
            if !batch.has_more {
                s.end_of_book = true;
            }
        }
        if !batch.has_more {
            app.native_tts()
                .tts_session_set_end_of_book(
                    tauri_plugin_native_tts::TTSSessionSetEndOfBookRequest { end_of_book: true },
                )
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    app.native_tts()
        .tts_session_push(tauri_plugin_native_tts::TTSSessionPushRequest {
            segments: batch.segments.iter().map(map_to_native_segment).collect(),
        })
        .map_err(|e| e.to_string())?;

    let added = estimate_segments_seconds(&batch.segments, rate);
    let end_of_book = !batch.has_more;
    {
        let mut s = state.inner.lock().await;
        s.cursor = batch.cursor.clone();
        s.buffer_seconds += added;
        if end_of_book {
            s.end_of_book = true;
        }
    }
    println!(
        "[TTS][Managed] push: segments={} addedSeconds={:.2} endOfBook={}",
        batch.segments.len(),
        added,
        end_of_book
    );
    if end_of_book {
        app.native_tts()
            .tts_session_set_end_of_book(tauri_plugin_native_tts::TTSSessionSetEndOfBookRequest {
                end_of_book: true,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn should_auto_finish(state: &Arc<ManagedTtsSessionState>) -> bool {
    let s = state.inner.lock().await;
    let done = s.active && !s.paused && s.end_of_book && s.buffer_seconds <= 0.0;
    if done {
        println!("[TTS][Managed] auto finish");
    }
    done
}

async fn get_segments<R: Runtime>(
    app: &AppHandle<R>,
    req: &TtsGetSegmentsRequest,
) -> Result<crate::tts::types::TtsGetSegmentsResponse, String> {
    match req.format.as_str() {
        "epub" => dispatcher::epub::get_segments(app, req).await,
        "mobi" => dispatcher::mobi::get_segments(app, req).await,
        "txt" => dispatcher::txt::get_segments(app, req).await,
        other => Err(format!("unsupported format: {}", other)),
    }
}

fn estimate_segments_seconds(segments: &[TtsSegmentDto], rate: f32) -> f64 {
    let safe_rate = if rate < 0.1 { 0.1 } else { rate as f64 };
    let total_chars: usize = segments.iter().map(|s| s.text.chars().count()).sum();
    (total_chars as f64) / CHARS_PER_SECOND_AT_RATE_ONE / safe_rate
}

fn map_to_native_segment(seg: &TtsSegmentDto) -> tauri_plugin_native_tts::TTSSessionSegment {
    tauri_plugin_native_tts::TTSSessionSegment {
        id: seg.id.clone(),
        text: seg.text.clone(),
        lang: seg.lang.clone(),
        section_index: seg.section_index,
        chunk_index: seg.chunk_index,
        cursor: Some(seg.cursor.clone()),
        anchor: seg.anchor.as_ref().map(map_anchor),
    }
}

fn map_anchor(anchor: &TtsAnchorDto) -> tauri_plugin_native_tts::TTSSessionAnchor {
    tauri_plugin_native_tts::TTSSessionAnchor {
        quote: anchor.quote.clone(),
        prefix: anchor.prefix.clone(),
        suffix: anchor.suffix.clone(),
    }
}

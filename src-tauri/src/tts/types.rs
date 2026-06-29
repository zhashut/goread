use serde::{Deserialize, Serialize};

/// 朗读定位锚点：与前端 TTSReadingAnchor 字段一致
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsAnchorDto {
    pub quote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
}

/// 单个朗读片段：与前端 TTSSegment 字段一致
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSegmentDto {
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub section_index: i32,
    pub chunk_index: i32,
    pub cursor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<TtsAnchorDto>,
}

/// 起播位置：用户当前阅读处
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStartPosition {
    pub section_index: i32,
    #[serde(default)]
    pub anchor: Option<TtsAnchorDto>,
}

/// 取片请求：与前端 TTSContentProviderGetSegmentsRequest 字段一致
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGetSegmentsRequest {
    pub book_id: String,
    pub file_path: String,
    pub format: String,
    #[serde(default)]
    pub cursor: Option<String>,
    pub max_segments: u32,
    #[serde(default)]
    pub start_position: Option<TtsStartPosition>,
    #[serde(default)]
    pub fallback_section_index: Option<i32>,
    #[serde(default)]
    pub total_sections: Option<i32>,
    /// EPUB 横纵向模式（仅 EPUB 用）
    #[serde(default)]
    pub reading_mode: Option<String>,
}

/// 取片响应：与前端 TTSContentProviderBatch 字段一致
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGetSegmentsResponse {
    pub segments: Vec<TtsSegmentDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsManagedSessionStartRequest {
    #[serde(flatten)]
    pub request: TtsGetSegmentsRequest,
    pub rate: f32,
    #[serde(default)]
    pub voice_id: Option<String>,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub low_watermark_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsManagedSessionSetRateRequest {
    pub rate: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsManagedSessionSetVoiceRequest {
    pub voice_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsManagedSessionStatus {
    pub active: bool,
    pub paused: bool,
    pub end_of_book: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub buffer_seconds: f64,
}


use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LangCheck {
    pub requested: String,
    pub result: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitArgs {
    pub lang: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResponse {
    pub success: bool,
    pub status: String,
    pub default_engine: Option<String>,
    pub lang_check: Option<LangCheck>,
    pub voices: Option<Vec<TTSVoice>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRateArgs {
    pub rate: f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVoiceArgs {
    pub voice: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMediaSessionActiveRequest {
    pub active: bool,
    pub keep_app_in_foreground: bool,
    pub notification_title: Option<String>,
    pub notification_text: Option<String>,
    pub foreground_service_title: Option<String>,
    pub foreground_service_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetVoicesResponse {
    pub voices: Vec<TTSVoice>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSSessionAnchor {
    pub quote: String,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSSessionSegment {
    pub id: String,
    pub text: String,
    pub lang: Option<String>,
    pub section_index: i32,
    #[serde(default)]
    pub chunk_index: i32,
    pub cursor: Option<String>,
    pub anchor: Option<TTSSessionAnchor>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSSessionStartRequest {
    pub segments: Vec<TTSSessionSegment>,
    pub lang: Option<String>,
    pub rate: f32,
    pub voice_id: Option<String>,
    #[serde(default)]
    pub end_of_book: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSSessionPushRequest {
    pub segments: Vec<TTSSessionSegment>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSSessionSetEndOfBookRequest {
    pub end_of_book: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSSessionStopRequest {
    #[serde(default = "default_emit_stopped_event")]
    pub emit_stopped_event: bool,
}

const fn default_emit_stopped_event() -> bool {
    true
}


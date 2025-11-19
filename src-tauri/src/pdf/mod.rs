pub mod cache;
pub mod engine;
pub mod font_manager;
pub mod performance;
pub mod preload_predictor;
pub mod renderer;
pub mod text_extractor;
pub mod types;

#[cfg(test)]
pub mod test_utils;

pub use cache::CacheManager;
pub use engine::{PdfEngine, PdfEngineManager, WarmupStrategy};
pub use font_manager::FontManager;
pub use performance::{
    PerformanceMetrics, PerformanceMonitor, PerformanceReport, PerformanceTimer,
};
pub use preload_predictor::{NavigationPattern, PreloadPredictor, ReadingSpeed};
pub use renderer::PdfRenderer;
pub use text_extractor::TextExtractor;
pub use types::*;

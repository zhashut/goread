use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// User behavior pattern for predicting page navigation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NavigationPattern {
    /// Sequential reading (forward)
    Sequential,
    /// Reverse reading (backward)
    Reverse,
    /// Random jumping
    Random,
    /// Mixed pattern
    Mixed,
}

/// Reading speed category
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ReadingSpeed {
    Slow,     // > 30 seconds per page
    Normal,   // 10-30 seconds per page
    Fast,     // 5-10 seconds per page
    Skimming, // < 5 seconds per page
}

/// User behavior record
#[derive(Debug, Clone)]
struct PageVisit {
    page_number: u32,
    timestamp: Instant,
    duration: Option<Duration>,
}

/// Intelligent preload predictor based on user behavior
pub struct PreloadPredictor {
    /// Recent page visit history
    visit_history: VecDeque<PageVisit>,
    /// Maximum history size
    max_history: usize,
    /// Detected navigation pattern
    current_pattern: NavigationPattern,
    /// Detected reading speed
    current_speed: ReadingSpeed,
    /// Pattern confidence (0.0 - 1.0)
    pattern_confidence: f32,
}

impl PreloadPredictor {
    /// Create a new predictor
    pub fn new() -> Self {
        Self {
            visit_history: VecDeque::new(),
            max_history: 20,
            current_pattern: NavigationPattern::Sequential,
            current_speed: ReadingSpeed::Normal,
            pattern_confidence: 0.5,
        }
    }

    /// Create with custom history size
    pub fn with_history_size(max_history: usize) -> Self {
        Self {
            visit_history: VecDeque::new(),
            max_history,
            current_pattern: NavigationPattern::Sequential,
            current_speed: ReadingSpeed::Normal,
            pattern_confidence: 0.5,
        }
    }

    /// Record a page visit
    pub fn record_visit(&mut self, page_number: u32) {
        // Update duration of previous visit
        if let Some(last_visit) = self.visit_history.back_mut() {
            if last_visit.duration.is_none() {
                last_visit.duration = Some(last_visit.timestamp.elapsed());
            }
        }

        // Add new visit
        let visit = PageVisit {
            page_number,
            timestamp: Instant::now(),
            duration: None,
        };

        self.visit_history.push_back(visit);

        // Maintain history size
        while self.visit_history.len() > self.max_history {
            self.visit_history.pop_front();
        }

        // Update patterns
        self.update_navigation_pattern();
        self.update_reading_speed();
    }

    /// Update navigation pattern based on history
    fn update_navigation_pattern(&mut self) {
        if self.visit_history.len() < 3 {
            return;
        }

        let pages: Vec<u32> = self.visit_history.iter().map(|v| v.page_number).collect();

        let mut forward_count = 0;
        let mut backward_count = 0;
        let mut jump_count = 0;

        for i in 1..pages.len() {
            let diff = pages[i] as i32 - pages[i - 1] as i32;

            if diff == 1 {
                forward_count += 1;
            } else if diff == -1 {
                backward_count += 1;
            } else if diff.abs() > 1 {
                jump_count += 1;
            }
        }

        let total = forward_count + backward_count + jump_count;
        if total == 0 {
            return;
        }

        // Calculate pattern confidence
        let max_count = forward_count.max(backward_count).max(jump_count);
        self.pattern_confidence = max_count as f32 / total as f32;

        // Determine pattern
        if forward_count > backward_count && forward_count > jump_count {
            if forward_count as f32 / total as f32 > 0.7 {
                self.current_pattern = NavigationPattern::Sequential;
            } else {
                self.current_pattern = NavigationPattern::Mixed;
            }
        } else if backward_count > forward_count && backward_count > jump_count {
            if backward_count as f32 / total as f32 > 0.7 {
                self.current_pattern = NavigationPattern::Reverse;
            } else {
                self.current_pattern = NavigationPattern::Mixed;
            }
        } else {
            self.current_pattern = NavigationPattern::Random;
        }
    }

    /// Update reading speed based on history
    fn update_reading_speed(&mut self) {
        let durations: Vec<Duration> = self
            .visit_history
            .iter()
            .filter_map(|v| v.duration)
            .collect();

        if durations.is_empty() {
            return;
        }

        // Calculate average duration
        let total_secs: f64 = durations.iter().map(|d| d.as_secs_f64()).sum();
        let avg_secs = total_secs / durations.len() as f64;

        // Categorize speed
        self.current_speed = if avg_secs > 30.0 {
            ReadingSpeed::Slow
        } else if avg_secs > 10.0 {
            ReadingSpeed::Normal
        } else if avg_secs > 5.0 {
            ReadingSpeed::Fast
        } else {
            ReadingSpeed::Skimming
        };
    }

    /// Predict next pages to preload
    /// Returns a vector of (page_number, priority) pairs
    /// Priority: 1.0 (highest) to 0.0 (lowest)
    pub fn predict_next_pages(&self, current_page: u32, total_pages: u32) -> Vec<(u32, f32)> {
        let mut predictions = Vec::new();

        match self.current_pattern {
            NavigationPattern::Sequential => {
                predictions.extend(self.predict_sequential(current_page, total_pages));
            }
            NavigationPattern::Reverse => {
                predictions.extend(self.predict_reverse(current_page, total_pages));
            }
            NavigationPattern::Random => {
                predictions.extend(self.predict_random(current_page, total_pages));
            }
            NavigationPattern::Mixed => {
                predictions.extend(self.predict_mixed(current_page, total_pages));
            }
        }

        // Adjust priorities based on confidence
        for (_, priority) in &mut predictions {
            *priority *= self.pattern_confidence;
        }

        // Sort by priority (descending)
        predictions.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        predictions
    }

    /// Predict for sequential pattern
    fn predict_sequential(&self, current_page: u32, total_pages: u32) -> Vec<(u32, f32)> {
        let mut predictions = Vec::new();
        let preload_count = self.get_preload_count();

        for i in 1..=preload_count {
            let page = current_page + i;
            if page <= total_pages {
                let priority = 1.0 - (i as f32 * 0.15);
                predictions.push((page, priority.max(0.1)));
            }
        }

        // Also preload 1 page behind
        if current_page > 1 {
            predictions.push((current_page - 1, 0.3));
        }

        predictions
    }

    /// Predict for reverse pattern
    fn predict_reverse(&self, current_page: u32, _total_pages: u32) -> Vec<(u32, f32)> {
        let mut predictions = Vec::new();
        let preload_count = self.get_preload_count();

        for i in 1..=preload_count {
            if current_page > i {
                let page = current_page - i;
                let priority = 1.0 - (i as f32 * 0.15);
                predictions.push((page, priority.max(0.1)));
            }
        }

        // Also preload 1 page ahead
        predictions.push((current_page + 1, 0.3));

        predictions
    }

    /// Predict for random pattern
    fn predict_random(&self, current_page: u32, total_pages: u32) -> Vec<(u32, f32)> {
        let mut predictions = Vec::new();

        // Preload nearby pages with equal priority
        for offset in [-2, -1, 1, 2] {
            let page = (current_page as i32 + offset) as u32;
            if page >= 1 && page <= total_pages {
                predictions.push((page, 0.5));
            }
        }

        // Analyze jump patterns
        if let Some(jump_target) = self.detect_jump_pattern(current_page) {
            if jump_target >= 1 && jump_target <= total_pages {
                predictions.push((jump_target, 0.7));
            }
        }

        predictions
    }

    /// Predict for mixed pattern
    fn predict_mixed(&self, current_page: u32, total_pages: u32) -> Vec<(u32, f32)> {
        let mut predictions = Vec::new();

        // Combine sequential and reverse predictions
        let preload_count = self.get_preload_count() / 2;

        // Forward
        for i in 1..=preload_count {
            let page = current_page + i;
            if page <= total_pages {
                predictions.push((page, 0.6 - (i as f32 * 0.1)));
            }
        }

        // Backward
        for i in 1..=preload_count {
            if current_page > i {
                let page = current_page - i;
                predictions.push((page, 0.6 - (i as f32 * 0.1)));
            }
        }

        predictions
    }

    /// Detect jump pattern (e.g., jumping to specific sections)
    fn detect_jump_pattern(&self, _current_page: u32) -> Option<u32> {
        if self.visit_history.len() < 5 {
            return None;
        }

        // Look for repeated jump targets
        let pages: Vec<u32> = self.visit_history.iter().map(|v| v.page_number).collect();

        // Find most common jump target
        let mut jump_counts: std::collections::HashMap<u32, usize> =
            std::collections::HashMap::new();

        for i in 1..pages.len() {
            let diff = (pages[i] as i32 - pages[i - 1] as i32).abs();
            if diff > 5 {
                *jump_counts.entry(pages[i]).or_insert(0) += 1;
            }
        }

        jump_counts
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .filter(|(_, count)| *count >= 2)
            .map(|(page, _)| page)
    }

    /// Get preload count based on reading speed
    fn get_preload_count(&self) -> u32 {
        match self.current_speed {
            ReadingSpeed::Slow => 2,
            ReadingSpeed::Normal => 3,
            ReadingSpeed::Fast => 5,
            ReadingSpeed::Skimming => 7,
        }
    }

    /// Get current navigation pattern
    pub fn get_pattern(&self) -> &NavigationPattern {
        &self.current_pattern
    }

    /// Get current reading speed
    pub fn get_speed(&self) -> &ReadingSpeed {
        &self.current_speed
    }

    /// Get pattern confidence
    pub fn get_confidence(&self) -> f32 {
        self.pattern_confidence
    }

    /// Get visit history size
    pub fn history_size(&self) -> usize {
        self.visit_history.len()
    }

    /// Clear history
    pub fn clear_history(&mut self) {
        self.visit_history.clear();
        self.current_pattern = NavigationPattern::Sequential;
        self.current_speed = ReadingSpeed::Normal;
        self.pattern_confidence = 0.5;
    }

    /// Get statistics
    pub fn get_statistics(&self) -> PredictorStatistics {
        let avg_duration = if !self.visit_history.is_empty() {
            let durations: Vec<Duration> = self
                .visit_history
                .iter()
                .filter_map(|v| v.duration)
                .collect();

            if !durations.is_empty() {
                let total: Duration = durations.iter().sum();
                Some(total / durations.len() as u32)
            } else {
                None
            }
        } else {
            None
        };

        PredictorStatistics {
            pattern: self.current_pattern.clone(),
            speed: self.current_speed.clone(),
            confidence: self.pattern_confidence,
            history_size: self.visit_history.len(),
            avg_page_duration: avg_duration,
        }
    }
}

impl Default for PreloadPredictor {
    fn default() -> Self {
        Self::new()
    }
}

/// Statistics about the predictor
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictorStatistics {
    pub pattern: NavigationPattern,
    pub speed: ReadingSpeed,
    pub confidence: f32,
    pub history_size: usize,
    pub avg_page_duration: Option<Duration>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_predictor_creation() {
        let predictor = PreloadPredictor::new();
        assert_eq!(predictor.history_size(), 0);
        assert!(predictor.get_confidence() > 0.0);
    }

    #[test]
    fn test_sequential_pattern() {
        let mut predictor = PreloadPredictor::new();

        // Simulate sequential reading
        for page in 1..=10 {
            predictor.record_visit(page);
        }

        let predictions = predictor.predict_next_pages(10, 100);
        assert!(!predictions.is_empty());

        // First prediction should be page 11
        assert_eq!(predictions[0].0, 11);
    }

    #[test]
    fn test_reverse_pattern() {
        let mut predictor = PreloadPredictor::new();

        // Simulate reverse reading
        for page in (1..=10).rev() {
            predictor.record_visit(page);
        }

        let predictions = predictor.predict_next_pages(5, 100);
        assert!(!predictions.is_empty());
    }

    #[test]
    fn test_clear_history() {
        let mut predictor = PreloadPredictor::new();
        predictor.record_visit(1);
        predictor.record_visit(2);

        assert_eq!(predictor.history_size(), 2);

        predictor.clear_history();
        assert_eq!(predictor.history_size(), 0);
    }
}

use fontdue::{Font, FontSettings};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Font manager for handling font loading, caching, and fallback
pub struct FontManager {
    /// Cached fonts by name
    fonts: Arc<RwLock<HashMap<String, Arc<Font>>>>,
    /// Font fallback chain
    fallback_chain: Vec<String>,
    /// Default font
    default_font: Option<Arc<Font>>,
}

impl FontManager {
    /// Create a new font manager
    pub fn new() -> Self {
        Self {
            fonts: Arc::new(RwLock::new(HashMap::new())),
            fallback_chain: vec![
                "Arial".to_string(),
                "Helvetica".to_string(),
                "Times New Roman".to_string(),
                "Courier New".to_string(),
            ],
            default_font: None,
        }
    }

    /// Initialize with system fonts
    pub async fn init_with_system_fonts(&mut self) -> Result<(), String> {
        // Load common system fonts
        self.load_system_fonts().await?;
        
        // Set default font
        if let Some(font) = self.get_font("Arial").await {
            self.default_font = Some(font);
        }
        
        Ok(())
    }

    /// Load system fonts based on platform
    async fn load_system_fonts(&self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            self.load_windows_fonts().await?;
        }
        
        #[cfg(target_os = "macos")]
        {
            self.load_macos_fonts().await?;
        }
        
        #[cfg(target_os = "linux")]
        {
            self.load_linux_fonts().await?;
        }
        
        #[cfg(target_os = "android")]
        {
            self.load_android_fonts().await?;
        }
        
        #[cfg(target_os = "ios")]
        {
            self.load_ios_fonts().await?;
        }
        
        Ok(())
    }

    /// Load Windows system fonts
    #[cfg(target_os = "windows")]
    async fn load_windows_fonts(&self) -> Result<(), String> {
        let font_paths = vec![
            ("Arial", "C:\\Windows\\Fonts\\arial.ttf"),
            ("Times New Roman", "C:\\Windows\\Fonts\\times.ttf"),
            ("Courier New", "C:\\Windows\\Fonts\\cour.ttf"),
            ("Verdana", "C:\\Windows\\Fonts\\verdana.ttf"),
            ("Tahoma", "C:\\Windows\\Fonts\\tahoma.ttf"),
            ("Microsoft YaHei", "C:\\Windows\\Fonts\\msyh.ttc"),
            ("SimSun", "C:\\Windows\\Fonts\\simsun.ttc"),
        ];
        
        for (name, path) in font_paths {
            if let Err(e) = self.load_font_from_file(name, path).await {
                eprintln!("Failed to load font {}: {}", name, e);
            }
        }
        
        Ok(())
    }

    /// Load macOS system fonts
    #[cfg(target_os = "macos")]
    async fn load_macos_fonts(&self) -> Result<(), String> {
        let font_paths = vec![
            ("Arial", "/System/Library/Fonts/Supplemental/Arial.ttf"),
            ("Times New Roman", "/System/Library/Fonts/Supplemental/Times New Roman.ttf"),
            ("Courier New", "/System/Library/Fonts/Supplemental/Courier New.ttf"),
            ("Helvetica", "/System/Library/Fonts/Helvetica.ttc"),
            ("PingFang SC", "/System/Library/Fonts/PingFang.ttc"),
        ];
        
        for (name, path) in font_paths {
            if let Err(e) = self.load_font_from_file(name, path).await {
                eprintln!("Failed to load font {}: {}", name, e);
            }
        }
        
        Ok(())
    }

    /// Load Linux system fonts
    #[cfg(target_os = "linux")]
    async fn load_linux_fonts(&self) -> Result<(), String> {
        let font_paths = vec![
            ("Arial", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
            ("Times New Roman", "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"),
            ("Courier New", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"),
            ("Noto Sans CJK", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        ];
        
        for (name, path) in font_paths {
            if let Err(e) = self.load_font_from_file(name, path).await {
                eprintln!("Failed to load font {}: {}", name, e);
            }
        }
        
        Ok(())
    }

    /// Load Android system fonts
    #[cfg(target_os = "android")]
    async fn load_android_fonts(&self) -> Result<(), String> {
        let font_paths = vec![
            ("Roboto", "/system/fonts/Roboto-Regular.ttf"),
            ("Noto Sans", "/system/fonts/NotoSans-Regular.ttf"),
            ("Noto Sans CJK", "/system/fonts/NotoSansCJK-Regular.ttc"),
            ("Droid Sans", "/system/fonts/DroidSans.ttf"),
        ];
        
        for (name, path) in font_paths {
            if let Err(e) = self.load_font_from_file(name, path).await {
                eprintln!("Failed to load font {}: {}", name, e);
            }
        }
        
        Ok(())
    }

    /// Load iOS system fonts
    #[cfg(target_os = "ios")]
    async fn load_ios_fonts(&self) -> Result<(), String> {
        let font_paths = vec![
            ("Helvetica", "/System/Library/Fonts/Cache/Helvetica.ttc"),
            ("Arial", "/System/Library/Fonts/Cache/Arial.ttc"),
            ("PingFang SC", "/System/Library/Fonts/PingFang.ttc"),
        ];
        
        for (name, path) in font_paths {
            if let Err(e) = self.load_font_from_file(name, path).await {
                eprintln!("Failed to load font {}: {}", name, e);
            }
        }
        
        Ok(())
    }

    /// Load a font from file
    pub async fn load_font_from_file(&self, name: &str, path: &str) -> Result<(), String> {
        let font_data = tokio::fs::read(path).await
            .map_err(|e| format!("Failed to read font file {}: {}", path, e))?;
        
        self.load_font_from_bytes(name, font_data).await
    }

    /// Load a font from bytes
    pub async fn load_font_from_bytes(&self, name: &str, data: Vec<u8>) -> Result<(), String> {
        let font = Font::from_bytes(data, FontSettings::default())
            .map_err(|e| format!("Failed to parse font {}: {:?}", name, e))?;
        
        let mut fonts = self.fonts.write().await;
        fonts.insert(name.to_string(), Arc::new(font));
        
        Ok(())
    }

    /// Get a font by name
    pub async fn get_font(&self, name: &str) -> Option<Arc<Font>> {
        let fonts = self.fonts.read().await;
        fonts.get(name).cloned()
    }

    /// Get a font with fallback
    /// If the requested font is not found, try fallback fonts
    pub async fn get_font_with_fallback(&self, name: &str) -> Arc<Font> {
        // Try requested font
        if let Some(font) = self.get_font(name).await {
            return font;
        }
        
        // Try fallback chain
        for fallback_name in &self.fallback_chain {
            if let Some(font) = self.get_font(fallback_name).await {
                return font;
            }
        }
        
        // Return default font or panic
        self.default_font.clone()
            .expect("No default font available")
    }

    /// Check if a character is supported by a font
    pub fn is_char_supported(font: &Font, ch: char) -> bool {
        font.lookup_glyph_index(ch) != 0
    }

    /// Find the best font for a character
    /// Returns the first font in the fallback chain that supports the character
    pub async fn find_font_for_char(&self, ch: char, preferred_font: Option<&str>) -> Arc<Font> {
        // Try preferred font first
        if let Some(font_name) = preferred_font {
            if let Some(font) = self.get_font(font_name).await {
                if Self::is_char_supported(&font, ch) {
                    return font;
                }
            }
        }
        
        // Try fallback chain
        let fonts = self.fonts.read().await;
        for fallback_name in &self.fallback_chain {
            if let Some(font) = fonts.get(fallback_name) {
                if Self::is_char_supported(font, ch) {
                    return font.clone();
                }
            }
        }
        
        // Return default font
        self.default_font.clone()
            .expect("No default font available")
    }

    /// Render text with automatic font fallback
    /// Returns a vector of (text, font) pairs
    pub async fn segment_text_by_font(&self, text: &str, preferred_font: Option<&str>) -> Vec<(String, Arc<Font>)> {
        let mut segments = Vec::new();
        let mut current_text = String::new();
        let mut current_font: Option<Arc<Font>> = None;
        
        for ch in text.chars() {
            let font: Arc<Font> = self.find_font_for_char(ch, preferred_font).await;
            
            if let Some(ref curr_font) = current_font {
                if Arc::<Font>::ptr_eq(curr_font, &font) {
                    // Same font, continue current segment
                    current_text.push(ch);
                } else {
                    // Different font, start new segment
                    if !current_text.is_empty() {
                        segments.push((current_text.clone(), Arc::<Font>::clone(curr_font)));
                        current_text.clear();
                    }
                    current_text.push(ch);
                    current_font = Some(font);
                }
            } else {
                // First character
                current_text.push(ch);
                current_font = Some(font);
            }
        }
        
        // Add last segment
        if !current_text.is_empty() {
            if let Some(font) = current_font {
                segments.push((current_text, font));
            }
        }
        
        segments
    }

    /// Add a custom font to the fallback chain
    pub fn add_to_fallback_chain(&mut self, font_name: String) {
        if !self.fallback_chain.contains(&font_name) {
            self.fallback_chain.push(font_name);
        }
    }

    /// Set the fallback chain
    pub fn set_fallback_chain(&mut self, chain: Vec<String>) {
        self.fallback_chain = chain;
    }

    /// Get the current fallback chain
    pub fn get_fallback_chain(&self) -> &[String] {
        &self.fallback_chain
    }

    /// Clear all cached fonts
    pub async fn clear_cache(&self) {
        let mut fonts = self.fonts.write().await;
        fonts.clear();
    }

    /// Get the number of cached fonts
    pub async fn font_count(&self) -> usize {
        let fonts = self.fonts.read().await;
        fonts.len()
    }

    /// Get all font names
    pub async fn get_font_names(&self) -> Vec<String> {
        let fonts = self.fonts.read().await;
        fonts.keys().cloned().collect()
    }
}

impl Default for FontManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_font_manager_creation() {
        let manager = FontManager::new();
        assert_eq!(manager.font_count().await, 0);
    }

    #[tokio::test]
    async fn test_fallback_chain() {
        let mut manager = FontManager::new();
        assert!(manager.get_fallback_chain().len() > 0);
        
        manager.add_to_fallback_chain("Custom Font".to_string());
        assert!(manager.get_fallback_chain().contains(&"Custom Font".to_string()));
    }
}
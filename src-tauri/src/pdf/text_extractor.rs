use crate::pdf::engine::PdfFile;
use crate::pdf::types::{PageText, PdfError, SearchResult, TextBlock, TextPosition};
use lopdf::content::{Content, Operation};
use lopdf::{Object, ObjectId};

pub struct TextExtractor;

impl TextExtractor {
    pub fn new() -> Self {
        Self
    }

    pub fn extract_page_text(
        &self,
        document: &PdfFile,
        page_number: u32,
    ) -> Result<PageText, PdfError> {
        let pages_map = document.get_pages();
        let page_id = pages_map.get(&page_number)
            .ok_or_else(|| PdfError::page_not_found(page_number, pages_map.len() as u32))?;

        let mut blocks = Vec::new();
        let mut full_text = String::new();

        let content_data = document.get_page_content(*page_id).unwrap_or_default();
        if !content_data.is_empty() {
            let content = Content::decode(&content_data)
                .map_err(|e| PdfError::parse_error(Some(page_number), "内容解析失败", e.to_string()))?;
            let text_blocks = self.parse_content_stream(&content)?;

            for block in text_blocks {
                full_text.push_str(&block.text);
                full_text.push('\n');
                blocks.push(block);
            }
        }

        Ok(PageText {
            page_number,
            blocks,
            full_text: full_text.trim().to_string(),
        })
    }

    fn parse_content_stream(
        &self,
        content: &Content,
    ) -> Result<Vec<TextBlock>, PdfError> {
        let mut text_blocks = Vec::new();
        let mut current_text = String::new();
        let mut current_x = 0.0;
        let mut current_y = 0.0;
        let mut current_font_size = 12.0;
        let mut current_font_name: Option<String> = None;

        let mut text_matrix = TextMatrix::default();
        let mut text_line_matrix = TextMatrix::default();

        for op in &content.operations {
            let name = op.operator.as_str();
            match name {
                "Td" => {
                    let tx = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let ty = as_f32(op.operands.get(1)).unwrap_or(0.0);
                    text_line_matrix.tx += tx;
                    text_line_matrix.ty += ty;
                    text_matrix = text_line_matrix;
                    current_x = text_matrix.tx;
                    current_y = text_matrix.ty;
                }
                "TD" => {
                    let tx = as_f32(op.operands.get(0)).unwrap_or(0.0);
                    let ty = as_f32(op.operands.get(1)).unwrap_or(0.0);
                    text_line_matrix.tx += tx;
                    text_line_matrix.ty += ty;
                    text_matrix.leading = -ty;
                    text_matrix = text_line_matrix;
                    current_x = text_matrix.tx;
                    current_y = text_matrix.ty;
                }
                "Tm" => {
                    let e = as_f32(op.operands.get(4)).unwrap_or(0.0);
                    let f = as_f32(op.operands.get(5)).unwrap_or(0.0);
                    text_matrix.tx = e;
                    text_matrix.ty = f;
                    text_line_matrix = text_matrix;
                    current_x = text_matrix.tx;
                    current_y = text_matrix.ty;
                }
                "T*" => {
                    text_line_matrix.ty -= text_matrix.leading;
                    text_matrix = text_line_matrix;
                    current_y = text_matrix.ty;
                }
                "Tj" => {
                    if !current_text.is_empty() {
                        self.flush_text_block(&mut text_blocks, &mut current_text, current_x, current_y, current_font_size, &current_font_name);
                    }
                    let decoded = decode_object_string(op.operands.get(0));
                    current_text.push_str(&decoded);
                }
                "'" => {
                    text_line_matrix.ty -= text_matrix.leading;
                    text_matrix = text_line_matrix;
                    current_y = text_matrix.ty;
                    let decoded = decode_object_string(op.operands.get(0));
                    current_text.push_str(&decoded);
                }
                "Tf" => {
                    current_font_size = as_f32(op.operands.get(1)).unwrap_or(current_font_size);
                    current_font_name = match op.operands.get(0) { Some(Object::Name(n)) => Some(String::from_utf8_lossy(n).to_string()), _ => current_font_name };
                }
                "TL" => {
                    text_matrix.leading = as_f32(op.operands.get(0)).unwrap_or(text_matrix.leading);
                }
                "BT" => {
                    text_matrix = TextMatrix::default();
                    text_line_matrix = TextMatrix::default();
                }
                "ET" => {
                    if !current_text.is_empty() {
                        self.flush_text_block(&mut text_blocks, &mut current_text, current_x, current_y, current_font_size, &current_font_name);
                    }
                }
                _ => {}
            }
        }

        if !current_text.is_empty() {
            text_blocks.push(TextBlock {
                text: current_text,
                position: TextPosition {
                    x: current_x,
                    y: current_y,
                    width: 0.0,
                    height: current_font_size,
                },
                font_size: current_font_size,
                font_name: current_font_name,
            });
        }

        Ok(text_blocks)
    }

    fn flush_text_block(
        &self,
        blocks: &mut Vec<TextBlock>,
        text: &mut String,
        x: f32,
        y: f32,
        font_size: f32,
        font_name: &Option<String>,
    ) {
        blocks.push(TextBlock {
            text: text.clone(),
            position: TextPosition {
                x,
                y,
                width: text.len() as f32 * font_size * 0.5,
                height: font_size,
            },
            font_size,
            font_name: font_name.clone(),
        });
        text.clear();
    }

    fn decode_pdf_string(&self, _bytes: &[u8]) -> String { String::new() }

    pub fn search_text(
        &self,
        document: &PdfFile,
        query: &str,
        case_sensitive: bool,
    ) -> Result<Vec<SearchResult>, PdfError> {
        let mut results = Vec::new();
        let page_count = document.get_pages().len() as u32;

        let search_query = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };

        for page_num in 1..=page_count {
            let page_text = self.extract_page_text(document, page_num)?;
            for block in &page_text.blocks {
                let text_to_search = if case_sensitive {
                    block.text.clone()
                } else {
                    block.text.to_lowercase()
                };

                if let Some(pos) = text_to_search.find(&search_query) {
                    let context_start = pos.saturating_sub(20);
                    let context_end = (pos + query.len() + 20).min(block.text.len());
                    let context = block.text[context_start..context_end].to_string();

                    results.push(SearchResult {
                        page_number: page_num,
                        text: block.text[pos..pos + query.len()].to_string(),
                        position: TextPosition {
                            x: block.position.x + (pos as f32 * block.font_size * 0.5),
                            y: block.position.y,
                            width: query.len() as f32 * block.font_size * 0.5,
                            height: block.font_size,
                        },
                        context,
                    });
                }
            }
        }

        Ok(results)
    }

    pub fn extract_all_text(&self, document: &PdfFile) -> Result<String, PdfError> {
        let mut all_text = String::new();
        let page_count = document.get_pages().len() as u32;

        for page_num in 1..=page_count {
            let page_text = self.extract_page_text(document, page_num)?;
            all_text.push_str(&format!("=== Page {} ===\n", page_num));
            all_text.push_str(&page_text.full_text);
            all_text.push_str("\n\n");
        }

        Ok(all_text)
    }

    pub fn get_text_at_position(
        &self,
        document: &PdfFile,
        page_number: u32,
        x: f32,
        y: f32,
    ) -> Result<Option<String>, PdfError> {
        let page_text = self.extract_page_text(document, page_number)?;

        for block in &page_text.blocks {
            if x >= block.position.x
                && x <= block.position.x + block.position.width
                && y >= block.position.y
                && y <= block.position.y + block.position.height
            {
                return Ok(Some(block.text.clone()));
            }
        }

        Ok(None)
    }
}

fn as_f32(o: Option<&Object>) -> Option<f32> {
    match o {
        Some(Object::Integer(v)) => Some(*v as f32),
        Some(Object::Real(v)) => Some(*v as f32),
        _ => None,
    }
}

fn decode_object_string(o: Option<&Object>) -> String {
    match o {
        Some(Object::String(bytes, _)) => String::from_utf8(bytes.clone()).unwrap_or_default(),
        _ => String::new(),
    }
}

#[derive(Debug, Clone, Copy)]
struct TextMatrix {
    tx: f32,
    ty: f32,
    leading: f32,
}

impl Default for TextMatrix {
    fn default() -> Self {
        Self {
            tx: 0.0,
            ty: 0.0,
            leading: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_extraction() {}
}

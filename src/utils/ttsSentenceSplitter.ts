/**
 * 按段落与句末标点切分文本为句子数组
 * 朗读流水线中作为最小切片单位（即朗读单位即高亮单位）
 */
export const splitTextToSentences = (text: string): string[] => {
  const paragraphs = text.split(/\n+/).filter(p => p.trim());
  const sentences: string[] = [];
  for (const para of paragraphs) {
    const parts = para.split(/(?<=[。！？；.!?;])\s*/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences;
};


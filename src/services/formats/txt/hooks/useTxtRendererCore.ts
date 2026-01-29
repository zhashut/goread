import { RenderOptions, TocItem } from '../../types';

export interface PageRange {
  index: number;
  startOffset: number;
  endOffset: number;
}

export interface ParagraphInfo {
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface TxtRendererCore {
  calculatePages(
    content: string,
    toc: TocItem[],
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<{ pages: PageRange[]; toc: TocItem[] }>;
  renderContent(
    container: HTMLElement,
    content: string,
    options?: RenderOptions,
    isVertical?: boolean
  ): void;
  renderContentWithPageDividers(
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options?: RenderOptions
  ): void;
}

function getThemeColors(theme: string | undefined) {
  if (theme === 'dark') {
    return { bg: '#1a1a1a', text: '#e0e0e0' };
  }
  if (theme === 'sepia') {
    return { bg: '#f4ecd8', text: '#5b4636' };
  }
  return { bg: '#fff', text: '#333' };
}

function applyContainerStyles(
  container: HTMLElement,
  options: RenderOptions | undefined,
  isVertical: boolean
): void {
  const fontSize = options?.fontSize || 16;
  const lineHeight = options?.lineHeight || 1.8;
  const fontFamily = options?.fontFamily || 'system-ui, sans-serif';
  const theme = options?.theme || 'light';
  const themeColors = getThemeColors(theme);

  container.style.cssText = `
      width: 100%;
      height: 100%;
      overflow-y: ${isVertical ? 'auto' : 'hidden'};
      background-color: ${themeColors.bg};
      color: ${themeColors.text};
      font-size: ${fontSize}px;
      line-height: ${lineHeight};
      font-family: ${fontFamily};
      padding: ${isVertical ? '0' : '16px'};
      box-sizing: border-box;
    `;
}

function createParagraphElement(
  text: string,
  isVertical: boolean = false
): HTMLParagraphElement {
  const p = document.createElement('p');
  p.style.cssText = `
        margin: 0 0 0.8em 0;
        ${isVertical ? 'padding: 0 16px;' : ''}
        text-indent: 2em;
        text-align: justify;
        word-break: break-word;
        white-space: pre-wrap;
      `;
  p.textContent = text;
  return p;
}

function splitIntoParagraphsWithOffsets(content: string): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = [];
  const lines = content.split('\n');
  let currentParagraphLines: string[] = [];
  let paragraphStart = 0;
  let currentOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = line.length;
    const isSeparator = i < lines.length - 1 ? 1 : 0;

    if (line.trim() === '') {
      if (currentParagraphLines.length > 0) {
        const text = currentParagraphLines.join('\n');
        paragraphs.push({
          text,
          startOffset: paragraphStart,
          endOffset: currentOffset,
        });
        currentParagraphLines = [];
      }
      currentOffset += lineLength + isSeparator;
      paragraphStart = currentOffset;
    } else {
      currentParagraphLines.push(line);
      currentOffset += lineLength + isSeparator;
    }
  }

  if (currentParagraphLines.length > 0) {
    const text = currentParagraphLines.join('\n');
    paragraphs.push({
      text,
      startOffset: paragraphStart,
      endOffset: content.length,
    });
  }

  return paragraphs;
}

function splitLongParagraphWithOffsets(
  para: ParagraphInfo,
  measureContainer: HTMLElement,
  maxHeight: number
): Array<{ text: string; startOffset: number; endOffset: number; isFullPage: boolean }> {
  const chunks: Array<{ text: string; startOffset: number; endOffset: number; isFullPage: boolean }> = [];
  let remaining = para.text;
  let currentOffset = para.startOffset;

  while (remaining.length > 0) {
    let low = 1;
    let high = remaining.length;
    let best = 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const testText = remaining.slice(0, mid);

      measureContainer.innerHTML = '';
      const p = document.createElement('p');
      p.style.cssText = 'margin: 0 0 0.8em 0; text-indent: 2em;';
      p.textContent = testText;
      measureContainer.appendChild(p);

      if (measureContainer.scrollHeight <= maxHeight) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const chunkText = remaining.slice(0, best);
    const chunkEndOffset = currentOffset + chunkText.length;
    remaining = remaining.slice(best);

    chunks.push({
      text: chunkText,
      startOffset: currentOffset,
      endOffset: chunkEndOffset,
      isFullPage: remaining.length > 0,
    });

    currentOffset = chunkEndOffset;
  }

  return chunks;
}

function updateTocPageNumbers(toc: TocItem[], pages: PageRange[]): TocItem[] {
  const updated: TocItem[] = [];
  for (const item of toc) {
    const cloned: TocItem = {
      title: item.title,
      location: item.location,
      level: item.level,
      children: item.children ? updateTocPageNumbers(item.children, pages) : undefined,
    };
    const charOffset = cloned.location as number;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (charOffset >= page.startOffset && charOffset < page.endOffset) {
        cloned.location = i + 1;
        break;
      }
    }
    updated.push(cloned);
  }
  return updated;
}

export function useTxtRendererCore(): TxtRendererCore {
  const calculatePages = async (
    content: string,
    toc: TocItem[],
    container: HTMLElement,
    options?: RenderOptions
  ): Promise<{ pages: PageRange[]; toc: TocItem[] }> => {
    const fontSize = options?.fontSize || 16;
    const lineHeight = options?.lineHeight || 1.8;
    const containerHeight = container.clientHeight || window.innerHeight;
    const containerWidth = container.clientWidth || window.innerWidth;

    const measureContainer = document.createElement('div');
    measureContainer.style.cssText = `
      position: absolute;
      left: -99999px;
      visibility: hidden;
      width: ${containerWidth}px;
      height: ${containerHeight}px;
      font-size: ${fontSize}px;
      line-height: ${lineHeight};
      font-family: ${options?.fontFamily || 'system-ui, sans-serif'};
      padding: 16px;
      box-sizing: border-box;
      white-space: pre-wrap;
      word-break: break-word;
      overflow: hidden;
    `;
    document.body.appendChild(measureContainer);

    const pages: PageRange[] = [];

    try {
      const paragraphs = splitIntoParagraphsWithOffsets(content);

      let currentPageStartOffset = 0;
      let currentPageParagraphs: ParagraphInfo[] = [];

      for (let i = 0; i < paragraphs.length; i++) {
        const para = paragraphs[i];

        const testP = document.createElement('p');
        testP.style.cssText = 'margin: 0 0 0.8em 0; text-indent: 2em;';
        testP.textContent = para.text;
        measureContainer.appendChild(testP);

        if (measureContainer.scrollHeight > containerHeight) {
          measureContainer.removeChild(testP);

          if (currentPageParagraphs.length > 0) {
            const lastPara = currentPageParagraphs[currentPageParagraphs.length - 1];
            pages.push({
              index: pages.length,
              startOffset: currentPageStartOffset,
              endOffset: lastPara.endOffset,
            });
            currentPageStartOffset = para.startOffset;
            currentPageParagraphs = [];
            measureContainer.innerHTML = '';
          }

          if (para.text.length > 0) {
            const chunks = splitLongParagraphWithOffsets(para, measureContainer, containerHeight);

            for (const chunk of chunks) {
              if (chunk.isFullPage) {
                pages.push({
                  index: pages.length,
                  startOffset: chunk.startOffset,
                  endOffset: chunk.endOffset,
                });
                currentPageStartOffset = chunk.endOffset;
              } else {
                const p = document.createElement('p');
                p.style.cssText = 'margin: 0 0 0.8em 0; text-indent: 2em;';
                p.textContent = chunk.text;
                measureContainer.appendChild(p);
                currentPageParagraphs.push({
                  text: chunk.text,
                  startOffset: chunk.startOffset,
                  endOffset: chunk.endOffset,
                });
              }
            }
          }
        } else {
          currentPageParagraphs.push(para);
        }
      }

      if (currentPageParagraphs.length > 0) {
        const lastPara = currentPageParagraphs[currentPageParagraphs.length - 1];
        pages.push({
          index: pages.length,
          startOffset: currentPageStartOffset,
          endOffset: lastPara.endOffset,
        });
      } else if (currentPageStartOffset < content.length) {
        pages.push({
          index: pages.length,
          startOffset: currentPageStartOffset,
          endOffset: content.length,
        });
      }

      if (pages.length === 0) {
        pages.push({
          index: 0,
          startOffset: 0,
          endOffset: content.length,
        });
      }

      const updatedToc = updateTocPageNumbers(toc, pages);
      return { pages, toc: updatedToc };
    } finally {
      document.body.removeChild(measureContainer);
    }
  };

  const renderContent = (
    container: HTMLElement,
    content: string,
    options?: RenderOptions,
    isVertical: boolean = false
  ): void => {
    applyContainerStyles(container, options, isVertical);
    container.innerHTML = '';
    const paragraphs = splitIntoParagraphsWithOffsets(content);

    for (const para of paragraphs) {
      const p = createParagraphElement(para.text, isVertical);
      container.appendChild(p);
    }
  };

  /**
   * 创建页面 wrapper 容器
   * 用于精确定位，添加 data-page-index 属性标识页码
   */
  const createPageWrapper = (pageIndex: number): HTMLDivElement => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-page-index', String(pageIndex));
    return wrapper;
  };

  const renderContentWithPageDividers = (
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options?: RenderOptions
  ): void => {
    applyContainerStyles(container, options, true);
    container.innerHTML = '';
    const paragraphs = splitIntoParagraphsWithOffsets(content);

    // 无分页时，所有内容放入一个 wrapper
    if (pages.length === 0) {
      const wrapper = createPageWrapper(0);
      for (const para of paragraphs) {
        const p = createParagraphElement(para.text, true);
        wrapper.appendChild(p);
      }
      container.appendChild(wrapper);
      return;
    }

    let pageIndex = 0;
    let currentPage = pages[pageIndex];
    let currentWrapper = createPageWrapper(pageIndex);
    container.appendChild(currentWrapper);

    const fontSize = options?.fontSize || 16;
    const theme = options?.theme || 'light';
    const pageGap = options?.pageGap ?? 4;
    const bandHeight = pageGap * 2 + 1;
    const paragraphMargin = fontSize * 0.8;
    const dividerMarginTop = Math.max(pageGap * 2, paragraphMargin * 1.5);
    const dividerMarginBottom = dividerMarginTop;
    const dividerColor = theme === 'dark' ? '#ffffff' : '#000000';

    for (const para of paragraphs) {
      const p = createParagraphElement(para.text, true);
      currentWrapper.appendChild(p);

      // 检查是否需要插入分隔符并开始新页面
      while (pageIndex < pages.length - 1 && para.endOffset >= currentPage.endOffset) {
        // 插入分隔符
        const divider = document.createElement('div');
        divider.style.height = `${bandHeight}px`;
        divider.style.width = '100%';
        divider.style.backgroundColor = dividerColor;
        divider.style.marginTop = `${dividerMarginTop}px`;
        divider.style.marginBottom = `${dividerMarginBottom}px`;
        container.appendChild(divider);

        // 开始新页面
        pageIndex += 1;
        currentPage = pages[pageIndex];
        currentWrapper = createPageWrapper(pageIndex);
        container.appendChild(currentWrapper);
      }
    }
  };

  return {
    calculatePages,
    renderContent,
    renderContentWithPageDividers,
  };
}


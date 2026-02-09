import { RenderOptions, TocItem } from '../../types';

export interface PageRange {
  index: number;
  startOffset: number;
  endOffset: number;
  chapterIndex?: number;
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
    options?: RenderOptions,
    config?: { updateTocPageNumbers?: boolean }
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
  appendContentWithPageDividers(
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options?: RenderOptions,
    startPageIndex?: number
  ): void;
  prependContentWithPageDividers(
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options?: RenderOptions,
    startPageIndex?: number
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

/**
 * 将内容按行分割，每行作为独立段落
 * 统一处理方式，避免空行检测的复杂逻辑
 * 注意：偏移量使用 JS 字符索引（string.slice 的参数语义）
 */
function splitContentIntoLines(content: string): ParagraphInfo[] {
  const lines: ParagraphInfo[] = [];
  const rawLines = content.split('\n');
  let currentOffset = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const lineLength = line.length;
    // 换行符占 1 个字符（最后一行没有换行符）
    const separatorLength = i < rawLines.length - 1 ? 1 : 0;

    // 只保留有内容的行，但偏移量始终累加
    if (line.trim().length > 0) {
      lines.push({
        text: line,
        startOffset: currentOffset,
        endOffset: currentOffset + lineLength,
      });
    }

    // 无论是否为空行，偏移量都要累加
    currentOffset += lineLength + separatorLength;
  }

  return lines;
}

/**
 * 更新目录页码：将字符偏移量转换为页码
 * 使用二分查找提高效率
 */
function updateTocPageNumbers(toc: TocItem[], pages: PageRange[]): TocItem[] {
  if (pages.length === 0) return toc;

  /**
   * 二分查找：找到包含指定字符偏移量的页码
   * 章节偏移量应该归属于包含该偏移量的页，或者该偏移量之后最近的页
   */
  const findPageForOffset = (charOffset: number): number => {
    // 边界检查：偏移量在第一页之前
    if (charOffset < pages[0].startOffset) {
      return 1;
    }
    // 边界检查：偏移量在最后一页之后
    if (charOffset > pages[pages.length - 1].endOffset) {
      return pages.length;
    }

    // 二分查找：找到第一个 startOffset >= charOffset 的页
    let left = 0;
    let right = pages.length - 1;
    let result = 0;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const page = pages[mid];

      // 精确匹配：偏移量在当前页范围内
      if (charOffset >= page.startOffset && charOffset <= page.endOffset) {
        return mid + 1;
      }

      if (charOffset < page.startOffset) {
        // 章节在当前页之前，记录当前页为候选，继续向左搜索
        result = mid;
        right = mid - 1;
      } else {
        // charOffset > page.endOffset
        // 章节在当前页之后，向右搜索
        left = mid + 1;
      }
    }

    // 返回章节所在的页：
    // 如果 charOffset 在两页之间的空隙，归属于下一页（即 result）
    // 因为章节标题应该显示在其内容开始的那一页
    return result + 1;
  };

  const updated: TocItem[] = [];
  for (const item of toc) {
    const charOffset = item.location as number;
    const pageNum = findPageForOffset(charOffset);

    const cloned: TocItem = {
      title: item.title,
      location: pageNum,
      level: item.level,
      children: item.children ? updateTocPageNumbers(item.children, pages) : undefined,
    };

    updated.push(cloned);
  }
  return updated;
}

export function useTxtRendererCore(): TxtRendererCore {
  /**
   * 核心分页算法：逐行填充
   * 每行独立测量高度，累积到页面容量后开启新页
   */
  const calculatePages = async (
    content: string,
    toc: TocItem[],
    container: HTMLElement,
    options?: RenderOptions,
    config?: { updateTocPageNumbers?: boolean }
  ): Promise<{ pages: PageRange[]; toc: TocItem[] }> => {
    const fontSize = options?.fontSize || 16;
    const lineHeight = options?.lineHeight || 1.8;
    const containerHeight = container.clientHeight || window.innerHeight;
    const containerWidth = container.clientWidth || window.innerWidth;

    // 创建测量容器
    const measureContainer = document.createElement('div');
    measureContainer.style.cssText = `
      position: absolute;
      left: -99999px;
      visibility: hidden;
      width: ${containerWidth}px;
      font-size: ${fontSize}px;
      line-height: ${lineHeight};
      font-family: ${options?.fontFamily || 'system-ui, sans-serif'};
      padding: 16px;
      box-sizing: border-box;
      white-space: pre-wrap;
      word-break: break-word;
    `;
    document.body.appendChild(measureContainer);

    const pages: PageRange[] = [];
    // 可用高度（扣除 padding）
    const availableHeight = containerHeight - 32;

    try {
      const lines = splitContentIntoLines(content);

      if (lines.length === 0) {
        // 空内容时返回单页
        pages.push({ index: 0, startOffset: 0, endOffset: content.length });
        return { pages, toc };
      }

      let currentPageStartOffset = lines[0].startOffset;
      let currentHeight = 0;
      let lastYieldTime = performance.now();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 测量当前行高度
        measureContainer.innerHTML = '';
        const p = document.createElement('p');
        p.style.cssText = 'margin: 0 0 0.8em 0; text-indent: 2em; white-space: pre-wrap; word-break: break-word;';
        p.textContent = line.text;
        measureContainer.appendChild(p);
        const lineRenderHeight = measureContainer.scrollHeight;

        // 判断是否需要换页
        if (currentHeight + lineRenderHeight > availableHeight && currentHeight > 0) {
          // 当前页满了，保存当前页
          const prevLine = lines[i - 1];
          pages.push({
            index: pages.length,
            startOffset: currentPageStartOffset,
            endOffset: prevLine.endOffset,
          });

          // 开始新页
          currentPageStartOffset = line.startOffset;
          currentHeight = lineRenderHeight;
        } else {
          // 累加高度
          currentHeight += lineRenderHeight;
        }

        // 每处理 50 行检查一次时间，如果超过 16ms (一帧) 则让出控制权
        if (i % 50 === 0) {
          const now = performance.now();
          if (now - lastYieldTime > 16) {
            await new Promise(resolve => setTimeout(resolve, 0));
            lastYieldTime = performance.now();
          }
        }
      }

      // 保存最后一页
      const lastLine = lines[lines.length - 1];
      pages.push({
        index: pages.length,
        startOffset: currentPageStartOffset,
        endOffset: lastLine.endOffset,
      });

      // 更新目录页码
      if (config?.updateTocPageNumbers === false) {
        return { pages, toc };
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
    const lines = splitContentIntoLines(content);

    for (const line of lines) {
      const p = createParagraphElement(line.text, isVertical);
      container.appendChild(p);
    }
  };

  /**
   * 创建页面 wrapper 容器
   */
  const createPageWrapper = (pageIndex: number): HTMLDivElement => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-page-index', String(pageIndex));
    return wrapper;
  };

  /**
   * 带分页分隔符的内容渲染
   * 核心逻辑：遍历行，根据行的 offset 判断是否跨页，仅在真正跨页时插入分隔符
   */
  const renderContentWithPageDividers = (
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options?: RenderOptions
  ): void => {
    applyContainerStyles(container, options, true);
    container.innerHTML = '';
    _renderContentInternal(container, content, pages, options, 0);
  };

  /**
   * 追加内容带分页分隔符
   * 用于连续滚动模式，不清空容器，直接追加新内容
   */
  const appendContentWithPageDividers = (
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options?: RenderOptions,
    startPageIndex: number = 0
  ): void => {
    // 在旧内容和新内容之间插入章节分隔符
    if (container.lastElementChild) {
      const theme = options?.theme || 'light';
      const pageGap = options?.pageGap ?? 4;
      const fontSize = options?.fontSize || 16;
      const bandHeight = pageGap * 2 + 1;
      const paragraphMargin = fontSize * 0.8;
      const dividerMargin = Math.max(pageGap * 2, paragraphMargin * 1.5);
      const dividerColor = theme === 'dark' ? '#ffffff' : '#000000';

      const divider = document.createElement('div');
      divider.className = 'txt-page-divider';
      divider.style.cssText = `
        height: ${bandHeight}px;
        width: 100%;
        background-color: ${dividerColor};
        margin-top: ${dividerMargin}px;
        margin-bottom: ${dividerMargin}px;
        display: ${options?.hideDivider ? 'none' : 'block'};
      `;
      container.appendChild(divider);
    }

    _renderContentInternal(container, content, pages, options, startPageIndex);
  };

  /**
   * 内部渲染逻辑，支持追加模式
   */
  const _renderContentInternal = (
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options: RenderOptions | undefined,
    startPageIndex: number
  ): void => {
    const lines = splitContentIntoLines(content);

    // 无分页或无内容时，直接渲染所有行
    if (pages.length === 0 || lines.length === 0) {
      // 如果是追加模式，且容器已有内容，检查最后一个 wrapper
      let wrapper: HTMLElement;
      const lastWrapper = container.lastElementChild as HTMLElement;
      if (lastWrapper && lastWrapper.hasAttribute('data-page-index')) {
        wrapper = lastWrapper;
      } else {
        wrapper = createPageWrapper(startPageIndex);
        container.appendChild(wrapper);
      }

      for (const line of lines) {
        const p = createParagraphElement(line.text, true);
        wrapper.appendChild(p);
      }
      return;
    }

    // 样式参数
    const fontSize = options?.fontSize || 16;
    const theme = options?.theme || 'light';
    const pageGap = options?.pageGap ?? 4;
    const bandHeight = pageGap * 2 + 1;
    const paragraphMargin = fontSize * 0.8;
    const dividerMarginTop = Math.max(pageGap * 2, paragraphMargin * 1.5);
    const dividerMarginBottom = dividerMarginTop;
    const dividerColor = theme === 'dark' ? '#ffffff' : '#000000';

    let pageIndex = 0;
    // 找到当前内容对应的起始页索引（相对于 pages 数组）
    // 注意：pages 数组是相对于 content 的，所以 pageIndex 从 0 开始对应 content 的开头

    // 如果是追加模式，我们需要接着上一次的页面继续渲染
    // 但是 pages 参数应该只包含当前 content 的分页信息，或者是全量 content 的分页信息？
    // 假设 pages 是当前 content 的分页信息，那么 pageIndex 从 0 开始
    // 如果 pages 是全量信息，我们需要找到 content startOffset 对应的 pageIndex

    // 这里假设 pages 是只针对当前 content 的分页数据
    // startPageIndex 是为了给 DOM 元素打上正确的 data-page-index 标签

    let currentWrapper: HTMLElement;

    // 检查是否需要复用上一个 wrapper (如果追加的第一行还在上一页)
    // 但通常追加是以章节为单位，章节之间通常会有分页符，除非上一章刚好填满一页
    // 简单起见，追加总是从新的一页或者接着当前页写

    // 初始化第一个 wrapper
    const firstPageGlobalIndex = startPageIndex + pageIndex;

    // 检查容器最后一个元素
    const lastWrapper = container.lastElementChild as HTMLElement;
    if (lastWrapper && lastWrapper.getAttribute('data-page-index') === String(firstPageGlobalIndex)) {
      currentWrapper = lastWrapper;
    } else {
      currentWrapper = createPageWrapper(firstPageGlobalIndex);
      container.appendChild(currentWrapper);
    }

    for (const line of lines) {
      // 检查当前行属于哪一页
      // pages[pageIndex] 是相对于 content 的偏移量
      while (pageIndex < pages.length - 1 && line.startOffset >= pages[pageIndex].endOffset) {
        // 当前行已超出当前页范围，插入分隔符并开始新页
        const divider = document.createElement('div');
        divider.className = 'txt-page-divider';
        divider.style.cssText = `
          height: ${bandHeight}px;
          width: 100%;
          background-color: ${dividerColor};
          margin-top: ${dividerMarginTop}px;
          margin-bottom: ${dividerMarginBottom}px;
          display: ${options?.hideDivider ? 'none' : 'block'};
        `;
        container.appendChild(divider);

        pageIndex++;
        const globalIndex = startPageIndex + pageIndex;
        currentWrapper = createPageWrapper(globalIndex);
        container.appendChild(currentWrapper);
      }

      // 将行添加到当前页
      const p = createParagraphElement(line.text, true);
      currentWrapper.appendChild(p);
    }
  };

  /**
   * 向容器前方插入内容，保持现有内容不变
   */
  const prependContentWithPageDividers = (
    container: HTMLElement,
    content: string,
    pages: PageRange[],
    options?: RenderOptions,
    startPageIndex: number = 0
  ): void => {
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    _renderContentInternal(tempDiv, content, pages, options, startPageIndex);
    while (tempDiv.firstChild) {
      fragment.appendChild(tempDiv.firstChild);
    }

    // 在新内容和旧内容之间插入章节分隔符
    const theme = options?.theme || 'light';
    const pageGap = options?.pageGap ?? 4;
    const fontSize = options?.fontSize || 16;
    const bandHeight = pageGap * 2 + 1;
    const paragraphMargin = fontSize * 0.8;
    const dividerMargin = Math.max(pageGap * 2, paragraphMargin * 1.5);
    const dividerColor = theme === 'dark' ? '#ffffff' : '#000000';

    if (container.firstChild) {
      const divider = document.createElement('div');
      divider.className = 'txt-page-divider';
      divider.style.cssText = `
        height: ${bandHeight}px;
        width: 100%;
        background-color: ${dividerColor};
        margin-top: ${dividerMargin}px;
        margin-bottom: ${dividerMargin}px;
        display: ${options?.hideDivider ? 'none' : 'block'};
      `;
      fragment.appendChild(divider);
    }

    const firstChild = container.firstChild;
    if (firstChild) {
      container.insertBefore(fragment, firstChild);
    } else {
      container.appendChild(fragment);
    }
  };

  return {
    calculatePages,
    renderContent,
    renderContentWithPageDividers,
    appendContentWithPageDividers,
    prependContentWithPageDividers,
  };
}


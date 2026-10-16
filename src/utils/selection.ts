/**
 * 文本选区工具
 *
 * 阅读器内容渲染在 Shadow DOM（EPUB / HTML 等格式）中，原生 window.getSelection()
 * 在部分浏览器只会把 Shadow DOM 内的选区暴露到宿主元素上，因此这里统一封装
 * 「按根节点取选区」的逻辑，供需要感知用户是否正在选中文字的模块复用。
 */

/**
 * 选区是否由程序设置（TTS 高亮等），而非用户手动选字。
 * 程序化选区不应触发「用户正在选字」的相关行为（暂停吸附 / 钉住页面 / 交出触摸手势）。
 */
let programmaticSelectionActive = false;

/** 标记程序化选区状态（由 TTS 高亮等程序写入选区的模块调用） */
export const setProgrammaticSelectionActive = (active: boolean): void => {
  programmaticSelectionActive = active;
};

/** 取得指定根节点（Document / ShadowRoot / Element）上的选区 */
export const getSelectionForRoot = (root: Node | null | undefined): Selection | null => {
  if (!root) return null;
  try {
    if (root instanceof ShadowRoot) {
      // Chrome/Safari 提供 ShadowRoot.getSelection()，可取到 Shadow DOM 内的真实选区
      const shadowGetSelection = (root as unknown as {
        getSelection?: () => Selection | null;
      }).getSelection;
      if (typeof shadowGetSelection === 'function') {
        const shadowSelection = shadowGetSelection.call(root);
        if (shadowSelection) return shadowSelection;
      }
    }
    return typeof window !== 'undefined' ? window.getSelection() : null;
  } catch {
    // 浏览器不支持或调用被拦截时按「无选区」处理
    return null;
  }
};

/** 选区是否可用：存在、有 range 且未折叠（折叠表示只是光标，没有真正选中内容） */
const isUsableSelection = (selection: Selection | null): selection is Selection => {
  try {
    return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
  } catch {
    return false;
  }
};

/**
 * 判断宿主元素（含其 Shadow DOM 内容）内是否存在正在进行的文本选区。
 *
 * 用途：用户选中文字时，浏览器会为展示选区（放大镜、选区手柄）自动滚动所在的
 * 滚动容器；若阅读器此时也执行「吸附到页边界」等自动滚动，两者会来回争夺滚动
 * 位置，视觉上就是屏幕抖动。选中期间应暂停阅读器的自动滚动。
 */
export const hasActiveSelectionIn = (host: HTMLElement | null): boolean => {
  if (!host) return false;
  // 程序化选区（TTS 高亮）不算用户选字
  if (programmaticSelectionActive) return false;

  // 先取 Shadow DOM 内的真实选区，再退回全局选区（部分浏览器会把选区重定向到宿主元素）
  const candidates = [getSelectionForRoot(host.shadowRoot), getSelectionForRoot(host)];
  for (const selection of candidates) {
    if (!isUsableSelection(selection)) continue;
    try {
      const node = selection.getRangeAt(0).startContainer;
      // node === host：选区被重定向到宿主元素本身
      if (node === host || host.contains(node) || host.shadowRoot?.contains(node)) {
        return true;
      }
    } catch {
      // 选区无法读取时忽略
    }
  }
  return false;
};

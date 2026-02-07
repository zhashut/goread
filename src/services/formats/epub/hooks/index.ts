/**
 * EPUB Hooks 统一导出
 * 提供 EPUB 渲染器所需的各个功能模块
 */

// 主题样式 Hook
export { useEpubTheme, type ThemeColors, type EpubThemeHook } from './useEpubTheme';

// 资源加载 Hook
export {
  useEpubResource,
  type EpubResourceContext,
  type EpubResourceHook,
} from './useEpubResource';

// 导航 Hook
export {
  useEpubNavigation,
  type NavigationContext,
  type EpubNavigationHook,
} from './useEpubNavigation';

// 纵向连续渲染 Hook
export {
  useVerticalRender,
  type VerticalRenderContext,
  type VerticalRenderState,
  type VerticalRenderHook,
} from './useVerticalRender';

// 横向渲染 Hook
export {
  useHorizontalRender,
  type HorizontalRenderContext,
  type HorizontalRenderState,
  type HorizontalRenderHook,
} from './useHorizontalRender';

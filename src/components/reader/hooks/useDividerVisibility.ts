import { useEffect, useRef } from 'react';
import { IBookRenderer } from '../../../services/formats';
import { EpubRenderer } from '../../../services/formats/epub/EpubRenderer';
import { MobiRenderer } from '../../../services/formats/mobi/MobiRenderer';

interface UseDividerVisibilityProps {
  rendererRef: React.MutableRefObject<IBookRenderer | null>;
  hideDivider: boolean;
  isDomRender: boolean;
  loading: boolean;
}

/**
 * 分隔线动态显隐控制
 */
export const useDividerVisibility = ({
  rendererRef,
  hideDivider,
  isDomRender,
  loading,
}: UseDividerVisibilityProps) => {
  const prevHideDividerRef = useRef<boolean>(hideDivider);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isDomRender || loading) return;

    // 仅当 hideDivider 实际变化时才更新
    const hideDividerChanged = prevHideDividerRef.current !== hideDivider;
    prevHideDividerRef.current = hideDivider;
    
    // 主题变化不需要这里处理，渲染时已通过 options 传递 hideDivider
    // 此 hook 仅处理用户主动切换 hideDivider 的情况
    if (!hideDividerChanged) return;

    // EPUB: 使用专用方法
    if (renderer instanceof EpubRenderer) {
      renderer.updateDividerVisibility(hideDivider);
      return;
    }

    if (renderer instanceof MobiRenderer) {
      renderer.updateDividerVisibility(hideDivider);
      return;
    }

    if (renderer.format === 'txt' && typeof (renderer as any).updateDividerVisibility === 'function') {
      (renderer as any).updateDividerVisibility(hideDivider);
    }
  }, [hideDivider, isDomRender, loading, rendererRef]);
};

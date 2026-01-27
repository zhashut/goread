/**
 * 封面加载 Hook
 * 提供封面 src 的获取和懒迁移功能
 */

import { useState, useEffect, useCallback } from 'react';
import { 
  getCoverRootPath, 
  getCoverSrcSync, 
  parseCoverImage 
} from '../utils/coverUtils';
import { logError } from '../services';

// 全局缓存封面根目录
let globalCoverRoot: string | null = null;
let rootLoadingPromise: Promise<string> | null = null;

/**
 * 获取封面根目录（带全局缓存和并发控制）
 */
async function ensureCoverRoot(): Promise<string | null> {
  if (globalCoverRoot) {
    return globalCoverRoot;
  }
  
  if (!rootLoadingPromise) {
    rootLoadingPromise = getCoverRootPath().then(root => {
      globalCoverRoot = root;
      return root;
    });
  }
  
  return rootLoadingPromise;
}

/**
 * 封面 Hook 选项
 */
interface UseCoverOptions {
  /** 书籍 ID（用于日志） */
  bookId?: number;
}

/**
 * 封面 Hook 返回值
 */
interface UseCoverResult {
  /** 封面 src，可以直接用于 img 标签 */
  src: string | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 加载是否出错 */
  error: boolean;
  /** 封面类型 */
  coverType: string;
  /** 重新加载封面 */
  reload: () => void;
  /** 处理加载错误（用于 img onError） */
  handleError: () => void;
}

/**
 * 封面加载 Hook
 * @param coverImage 封面字符串（可能是 Base64、data URL 或文件路径）
 * @param options 选项
 */
export function useCover(
  coverImage: string | null | undefined,
  _options: UseCoverOptions = {}
): UseCoverResult {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [coverType, setCoverType] = useState<string>('none');

  // 加载封面
  const loadCover = useCallback(async () => {
    const info = parseCoverImage(coverImage);
    setCoverType(info.type);
    
    if (info.type === 'none') {
      setSrc(null);
      setLoading(false);
      return;
    }
    
    // 对于 Base64 和 data URL，可以同步获取
    if (info.type === 'base64' || info.type === 'dataUrl') {
      const result = getCoverSrcSync(coverImage, null);
      setSrc(result);
      setLoading(false);
      return;
    }
    
    // 文件路径需要异步获取根目录
    setLoading(true);
    try {
      const root = await ensureCoverRoot();
      const result = getCoverSrcSync(coverImage, root);
      setSrc(result);
    } catch (e) {
      await logError('Failed to load cover in useCover', {
        error: String(e),
      });
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [coverImage]);

  // 处理加载错误
  const handleError = useCallback(() => {
    setError(true);
  }, []);

  // 重新加载
  const reload = useCallback(() => {
    setError(false);
    loadCover();
  }, [loadCover]);

  // 初始加载
  useEffect(() => {
    setError(false);
    loadCover();
  }, [loadCover]);

  return {
    src,
    loading,
    error,
    coverType,
    reload,
    handleError,
  };
}

/**
 * 批量预加载封面根目录
 * 在应用初始化时调用，可以提前缓存根目录
 */
export async function preloadCoverRoot(): Promise<void> {
  await ensureCoverRoot();
}

/**
 * 获取当前缓存的封面根目录（同步）
 */
export function getCachedCoverRoot(): string | null {
  return globalCoverRoot;
}

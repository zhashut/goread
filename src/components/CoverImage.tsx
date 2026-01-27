import React, { useCallback } from 'react';
import { useCover } from '../hooks/useCover';
import { logError } from '../services';

export interface CoverImageProps {
  /** 封面字符串（Base64/data URL/文件路径） */
  coverImage: string | null | undefined;
  /** 图片 alt 文本 */
  alt?: string;
  /** 样式 */
  style?: React.CSSProperties;
  /** 类名 */
  className?: string;

  /** 加载错误时的回调 */
  onError?: () => void;
  /** 加载成功时的回调 */
  onLoad?: () => void;
  /** 自定义占位内容 */
  placeholder?: React.ReactNode;
  bookId?: number;
  enableMigration?: boolean;
}

const CoverImage: React.FC<CoverImageProps> = ({
  coverImage,
  alt = '',
  style,
  className,
  onError,
  onLoad,
  placeholder,
  bookId,
}) => {
  const {
    src,
    loading,
    error,
    coverType,
    handleError: hookHandleError,
  } = useCover(coverImage, { bookId });

  const handleImageError = useCallback(() => {
    hookHandleError();
    if (bookId) {
      logError('Cover image element load error', {
        bookId,
        coverType,
      }).catch(() => {});
    }
    onError?.();
  }, [hookHandleError, onError, bookId, coverType]);

  if (coverType === 'none' || error || !src) {
    if (placeholder) {
      return <>{placeholder}</>;
    }
    return null;
  }
  if (loading) {
    return (
      <div 
        style={{ 
          ...style, 
          backgroundColor: '#f5f5f5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }} 
        className={className}
      />
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      style={style}
      className={className}
      onError={handleImageError}
      onLoad={onLoad}
    />
  );
};

export { CoverImage };
export default CoverImage;

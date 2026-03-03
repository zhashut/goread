import React, { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  duration?: number;
  onClose?: () => void;
  /** 自定义定位样式，可覆盖默认的底部定位 */
  style?: React.CSSProperties;
}

export const Toast: React.FC<ToastProps> = ({ message, duration = 2000, onClose, style }) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      onClose?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [message, duration, onClose]);

  if (!visible || !message) return null;

  // 是否为居中定位
  const isCentered = style?.top === '50%';

  const defaultStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: '80px',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    color: '#fff',
    padding: '10px 20px',
    borderRadius: '20px',
    fontSize: '14px',
    zIndex: 2000,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    maxWidth: '80%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    animation: 'fadeIn 0.2s ease-out',
  };

  return (
    <div style={{ ...defaultStyle, ...style }}>
      {message}
      <style>
        {`
          @keyframes fadeIn {
            from { opacity: 0; transform: ${isCentered ? 'translate(-50%, calc(-50% + 10px))' : 'translate(-50%, 10px)'}; }
            to { opacity: 1; transform: ${isCentered ? 'translate(-50%, -50%)' : 'translateX(-50%)'}; }
          }
        `}
      </style>
    </div>
  );
};

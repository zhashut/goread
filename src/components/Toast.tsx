import React, { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  duration?: number;
  onClose?: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, duration = 2000, onClose }) => {
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

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '80px', // Above bottom nav/safe area
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
      }}
    >
      {message}
      <style>
        {`
          @keyframes fadeIn {
            from { opacity: 0; transform: translate(-50%, 10px); }
            to { opacity: 1; transform: translate(-50%, 0); }
          }
        `}
      </style>
    </div>
  );
};

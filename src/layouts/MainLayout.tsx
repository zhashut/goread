import React, { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { applyNonScalable } from '../utils/viewport';

export const MainLayout: React.FC = () => {
  useEffect(() => {
    applyNonScalable();
  }, []);
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      overflow: 'hidden',
      backgroundColor: '#1f1f1f', // 默认背景色
      color: '#fff',
    }}>
      <Outlet />
    </div>
  );
};

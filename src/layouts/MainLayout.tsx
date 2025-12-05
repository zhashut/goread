import React from 'react';
import { Outlet } from 'react-router-dom';

export const MainLayout: React.FC = () => {
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

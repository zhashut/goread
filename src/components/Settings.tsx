import React from 'react';

export const Settings: React.FC = () => {
  return (
    <div style={{
      padding: '20px',
      minHeight: '100vh',
      backgroundColor: '#fafafa'
    }}>
      <h1 style={{
        fontSize: '24px',
        fontWeight: '600',
        color: '#333',
        marginBottom: '30px'
      }}>
        设置
      </h1>
      
      <div style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        padding: '20px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
      }}>
        <p style={{
          color: '#666',
          fontSize: '16px'
        }}>
          设置功能开发中...
        </p>
      </div>
    </div>
  );
};
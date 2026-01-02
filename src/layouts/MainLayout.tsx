import React, { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { applyNonScalable } from '../utils/viewport';
import { usePageTransition } from '../hooks/usePageTransition';
import { useExternalFileOpen } from '../hooks';
import ImportProgressDrawer from '../components/bookshelf/ImportProgressDrawer';
import { useImportProgress } from '../components/bookshelf/hooks';

export const MainLayout: React.FC = () => {
  const location = useLocation();
  const { type, durationMs, timingFunction } = usePageTransition();
  const importProgress = useImportProgress(() => {});
  const { importOpen, importTotal, importCurrent, importTitle, stopImport } = importProgress;
  
  useExternalFileOpen();

  useEffect(() => {
    applyNonScalable();
  }, []);

  const contentStyle: React.CSSProperties =
    type === 'fade'
      ? {
          width: '100%',
          height: '100%',
          animationDuration: `${durationMs}ms`,
          animationTimingFunction: timingFunction,
        }
      : {
          width: '100%',
          height: '100%',
        };

  const contentClassName = type === 'fade' ? 'page-transition-fade' : undefined;

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        backgroundColor: '#f6f6f6',
        color: '#0f0f0f',
      }}
    >
      <div
        key={location.pathname}
        className={contentClassName}
        style={contentStyle}
      >
        <Outlet />
      </div>
      <ImportProgressDrawer
        open={importOpen}
        title={importTitle}
        current={importCurrent}
        total={importTotal}
        onStop={stopImport}
      />
    </div>
  );
};

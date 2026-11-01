import React, { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { applyNonScalable } from '../utils/viewport';
import { usePageTransition } from '../hooks/usePageTransition';
import { useExternalFileOpen } from '../hooks';
import ImportProgressDrawer from '../components/bookshelf/ImportProgressDrawer';
import { useImportProgress } from '../components/bookshelf/hooks';
import { getSafeAreaInsets } from '../utils/layout';
import { GlobalBottomBar, GLOBAL_NAV_BAR_H } from './GlobalBottomBar';
import { GlobalToastHost } from '../components/GlobalToastHost';

/** 判定当前路由是否展示全局底部菜单栏（与 GlobalBottomBar 的可见规则保持一致） */
const isNavRoute = (pathname: string): boolean =>
  !pathname.startsWith('/reader') && pathname !== '/search';

export const MainLayout: React.FC = () => {
  const location = useLocation();
  const { type, durationMs, timingFunction } = usePageTransition();
  const importProgress = useImportProgress(() => {});
  const { importOpen, importTotal, importCurrent, importTitle, stopImport } = importProgress;

  useExternalFileOpen();

  useEffect(() => {
    applyNonScalable();
  }, []);

  // 全局底部菜单栏占位高度，经 CSS 变量下发给各页面做底部避让
  const navBarVisible = isNavRoute(location.pathname);
  const rootStyle = {
    width: '100vw',
    height: '100vh',
    overflow: 'hidden',
    backgroundColor: '#f6f6f6',
    color: '#0f0f0f',
    // getSafeAreaInsets() 返回 env()/var() 字符串（非数字），必须整体放入 calc() 参与计算，
    // 不可做 JS 数值拼接（"55" + "env(...)" 会生成非法值导致避让失效）
    '--goread-navbar-h': navBarVisible
      ? `calc(${GLOBAL_NAV_BAR_H}px + ${getSafeAreaInsets().bottom})`
      : '0px',
  } as React.CSSProperties;

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
    <div style={rootStyle}>
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
      {/* 全局底部菜单栏：跨页面固定展示，按路由高亮对应入口（位于转场容器外，转场时不闪动） */}
      <GlobalBottomBar />
      {/* 全局 Toast 宿主：常驻所有路由（含阅读器），监听全局事件展示应用统一风格提示（替代各模块原生 alert） */}
      <GlobalToastHost />
    </div>
  );
};

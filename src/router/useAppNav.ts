import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';

export const useAppNav = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  return {
    // 基础操作
    goBack: () => navigate(-1),
    
    // 业务跳转
    toBookshelf: (
      tab: 'recent' | 'all' = 'recent',
      options?: { replace?: boolean; state?: any; resetStack?: boolean }
    ) => {
      const isAtRoot = location.pathname === '/';
      const historyState = window.history.state as { idx?: number } | null | undefined;
      const routerIdx = historyState?.idx;
      const { replace, state, resetStack } = options || {};

      if (resetStack) {
        if (typeof routerIdx === 'number' && routerIdx > 0) {
          sessionStorage.setItem('bookshelf_active_tab', tab);
          navigate(-routerIdx);
          return;
        }
        navigate(`/?tab=${tab}`, { replace: true, state });
        return;
      }

      if (isAtRoot) {
        navigate(`/?tab=${tab}`, { replace: typeof replace === 'boolean' ? replace : true, state });
        return;
      }

      if (typeof routerIdx === 'number' && routerIdx > 0) {
        sessionStorage.setItem('bookshelf_active_tab', tab);
        navigate(-routerIdx);
      } else {
        navigate(`/?tab=${tab}`, { replace: typeof replace === 'boolean' ? replace : true, state });
      }
    },
    
    toReader: (bookId: number, state?: any) => {
      navigate(`/reader/${bookId}`, { state });
    },
    
    openGroup: (groupId: number) => {
      navigate(`/?tab=all&group=${groupId}`);
    },
    
    closeGroup: () => {
      // 策略：优先尝试返回上一级，以对齐物理返回键的行为
      // 如果是直接打开的链接（无历史），则替换 URL 去除参数
      if (window.history.length > 1) {
        navigate(-1);
      } else {
        const currentTab = searchParams.get('tab') || 'all';
        navigate(`/?tab=${currentTab}`, { replace: true });
      }
    },

    toSettings: (state?: any) => navigate('/settings', { state }),
    toSearch: () => navigate('/search'),
    toImport: (state?: any) => navigate('/import', { state }),
    toStatistics: (state?: any) => navigate('/statistics', { state }),
    toAbout: (state?: any) => navigate('/about', { state }),
    toImportResults: (state: any, options?: { replace?: boolean }) => navigate('/import/results', { state, ...options }),
    
    /**
     * 结束导入流程并返回书架「全部」栏目
     * 策略：先回退到历史栈底部清理导入流程页面，再替换为正确的 URL
     */
    finishImportFlow: () => {
      const historyState = window.history.state as { idx?: number } | null | undefined;
      const routerIdx = historyState?.idx;
      
      if (typeof routerIdx === 'number' && routerIdx > 0) {
        // 监听 popstate 事件，在回退完成后替换 URL 确保正确定位
        const handlePopState = () => {
          window.removeEventListener('popstate', handlePopState);
          // 使用 setTimeout 确保在 React Router 处理完 popstate 后执行替换
          setTimeout(() => {
            navigate(`/?tab=all`, { replace: true });
          }, 0);
        };
        window.addEventListener('popstate', handlePopState);
        // 回退到历史栈底部
        window.history.go(-routerIdx);
      } else {
        // 无历史记录可回退，直接替换
        navigate(`/?tab=all`, { replace: true });
      }
    },

    // 暴露 navigate 的 delta 跳转能力
    go: (delta: number) => navigate(delta),
    
    // 状态查询 (Helper)
    currentTab: searchParams.get('tab') || 'recent',
    activeGroupId: searchParams.get('group') ? Number(searchParams.get('group')) : null,
    location, // 暴露 location 对象供组件读取 state
  };
};

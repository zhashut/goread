import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';

export const useAppNav = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  return {
    // 基础操作
    goBack: () => navigate(-1),
    
    // 业务跳转
    toBookshelf: (tab: 'recent' | 'all' = 'recent', options?: { replace?: boolean, state?: any }) => {
      // 策略：不论从何处进入书架（最近/全部），都清空历史栈（回退到起点）
      // 这样用户在书架页面按返回键时，会直接退出应用，而不是回退到之前的页面
      const isAtRoot = location.pathname === '/';

      // 如果已经在根路径，直接替换当前 entry (Tab 切换)
      // 或者是为了进入选择模式（Push State），此时 options.replace 可能为 false
      if (isAtRoot) {
         // 默认 replace: true，但允许 options.replace 覆盖
         navigate(`/?tab=${tab}`, { replace: true, ...options });
         return;
      }

      // 尝试获取 React Router 维护的历史栈索引
      const historyState = window.history.state;
      const routerIdx = historyState?.idx;

      // 如果能获取到索引且深度 > 0，则回退到起点 (idx 0)
      if (typeof routerIdx === 'number' && routerIdx > 0) {
        // 通过 sessionStorage 传递目标 Tab，由 Bookshelf 组件处理
        sessionStorage.setItem('bookshelf_active_tab', tab);
        navigate(-routerIdx);
      } else {
        // 兜底：无索引信息或已在起点，使用 replace
        // 注意：不再使用 history.length，因为它包含 forward history，会导致计算错误
        navigate(`/?tab=${tab}`, { replace: true, ...options });
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
     * 结束导入流程并返回书架
     * 统一使用 toBookshelf 处理返回逻辑（包含清栈）
     * 导入结束通常去"全部"栏目
     */
    finishImportFlow: () => {
      const tab = 'all';
      
      const historyState = window.history.state;
      const routerIdx = historyState?.idx;
      
      if (typeof routerIdx === 'number' && routerIdx > 0) {
        sessionStorage.setItem('bookshelf_active_tab', tab);
        navigate(-routerIdx);
      } else {
        navigate(`/?tab=${tab}`, { replace: true });
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

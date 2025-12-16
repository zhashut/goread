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
      const stackDepth = window.history.length;
      const isAtRoot = location.pathname === '/';

      // 如果已经在根路径，直接替换当前 entry (Tab 切换)
      // 或者是为了进入选择模式（Push State），此时 options.replace 可能为 false
      if (isAtRoot) {
         // 默认 replace: true，但允许 options.replace 覆盖
         navigate(`/?tab=${tab}`, { replace: true, ...options });
         return;
      }

      // 如果从其他页面返回且历史栈有深度，回退到起点
      if (stackDepth > 1) {
        // 通过 sessionStorage 传递目标 Tab，由 Bookshelf 组件处理
        sessionStorage.setItem('bookshelf_active_tab', tab);
        navigate(-(stackDepth - 1));
      } else {
        // 兜底：无历史记录（直接打开），使用 replace
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
    toImportResults: (state: any, options?: { replace?: boolean }) => navigate('/import/results', { state, ...options }),
    
    /**
     * 结束导入流程并返回书架
     * 统一使用 toBookshelf 处理返回逻辑（包含清栈）
     * 导入结束通常去"全部"栏目
     */
    finishImportFlow: () => {
      // 这里的逻辑与 toBookshelf('all') 一致，利用闭包直接调用 navigate 和 logic 比较麻烦
      // 因为 toBookshelf 定义在 return 对象里，这里无法直接调用
      // 重新实现一遍逻辑，或者简单地做一次 navigate
      // 为了复用，我们在 return 之前定义 helper 函数会更好，但为了最小化改动，
      // 我们这里直接复制逻辑，或者使用一个简单的 trick: 
      // 由于我们无法调用 sibling methods, 我们只能 duplicate logic or move definition up.
      // Let's duplicate logic for now to be safe and explicit.
      
      const tab = 'all';
      const stackDepth = window.history.length;
      // 导入流程肯定不是在根路径 (是在 /import/results)
      
      if (stackDepth > 1) {
        sessionStorage.setItem('bookshelf_active_tab', tab);
        navigate(-(stackDepth - 1));
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

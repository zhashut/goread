import { useCallback, useEffect, useState } from "react";

interface UseSearchOverlayOptions {
  onReset?: () => void;
}

export const useSearchOverlay = (options: UseSearchOverlayOptions) => {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      // 只有当回退后的状态不是 search overlay 时才关闭搜索
      // 这样抽屉（grouping/choose）的关闭不会影响搜索视图
      if (searchOpen && e.state?.overlay !== "search") {
        setSearchOpen(false);
        if (options.onReset) {
          options.onReset();
        }
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [searchOpen, options]);

  const openSearch = useCallback(() => {
    if (!searchOpen) {
      setSearchOpen(true);
      const currentState = window.history.state;
      const newState =
        typeof currentState === "object" && currentState !== null
          ? { ...currentState, overlay: "search" }
          : { overlay: "search" };
      window.history.pushState(newState, "");
    }
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    if (searchOpen) {
      window.history.back();
    }
  }, [searchOpen]);

  return {
    searchOpen,
    openSearch,
    closeSearch,
  };
}


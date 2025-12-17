import { useCallback, useEffect, useState } from "react";

interface UseSearchOverlayOptions {
  onReset?: () => void;
}

export const useSearchOverlay = (options: UseSearchOverlayOptions) => {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handlePopState = () => {
      if (searchOpen) {
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
      window.history.pushState({ overlay: "search" }, "");
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


import React, { createContext, useContext, useMemo } from 'react';
import { DEFAULT_PAGE_TRANSITION, PageTransitionConfig } from './pageTransitionConfig';

interface PageTransitionContextValue {
  config: PageTransitionConfig;
}

const PageTransitionContext = createContext<PageTransitionContextValue>({
  config: DEFAULT_PAGE_TRANSITION,
});

export const PageTransitionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useMemo<PageTransitionContextValue>(() => {
    return {
      config: DEFAULT_PAGE_TRANSITION,
    };
  }, []);

  return (
    <PageTransitionContext.Provider value={value}>
      {children}
    </PageTransitionContext.Provider>
  );
};

export const usePageTransitionContext = () => {
  return useContext(PageTransitionContext);
};


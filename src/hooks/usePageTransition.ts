import { useMatches } from "react-router-dom";
import { DEFAULT_PAGE_TRANSITION, PageTransitionConfig } from "../router/pageTransitionConfig";
import { usePageTransitionContext } from "../router/PageTransitionProvider";

type TransitionHandle = {
  transition?: Partial<PageTransitionConfig>;
};

export const usePageTransition = (): PageTransitionConfig => {
  const { config } = usePageTransitionContext();
  const matches = useMatches() as Array<{ handle?: TransitionHandle }>;

  let override: Partial<PageTransitionConfig> | undefined;

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const handle = matches[i].handle as TransitionHandle | undefined;
    if (handle && handle.transition) {
      override = handle.transition;
      break;
    }
  }

  const base = config || DEFAULT_PAGE_TRANSITION;

  if (!override) {
    return base;
  }

  return {
    ...base,
    ...override,
  };
};


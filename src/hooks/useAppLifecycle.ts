import { useEffect } from "react";

type AppLifecycleListener = {
  onForeground?: () => void;
  onBackground?: () => void;
};

const appLifecycleListeners = new Set<AppLifecycleListener>();
let appLifecycleInitialized = false;

const ensureAppLifecycleListener = () => {
  if (appLifecycleInitialized) return;
  appLifecycleInitialized = true;

  const handleVisibilityChange = () => {
    const hidden = document.hidden;
    appLifecycleListeners.forEach((listener) => {
      if (hidden) {
        if (listener.onBackground) {
          listener.onBackground();
        }
      } else {
        if (listener.onForeground) {
          listener.onForeground();
        }
      }
    });
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
};

export interface UseAppLifecycleOptions {
  onForeground?: () => void;
  onBackground?: () => void;
}

export const useAppLifecycle = (options?: UseAppLifecycleOptions) => {
  useEffect(() => {
    ensureAppLifecycleListener();

    if (!options || (!options.onForeground && !options.onBackground)) {
      return;
    }

    const listener: AppLifecycleListener = {
      onForeground: options.onForeground,
      onBackground: options.onBackground,
    };

    appLifecycleListeners.add(listener);

    return () => {
      appLifecycleListeners.delete(listener);
    };
  }, [options?.onForeground, options?.onBackground]);
};


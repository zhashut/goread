/**
 * Mobi 主题样式 Hook
 */

export interface MobiThemeHook {
    getThemeStyles: (theme: string) => string;
}

export function useMobiTheme(): MobiThemeHook {
    /**
     * 获取主题样式
     */
    const getThemeStyles = (theme: string): string => {
        switch (theme) {
            case 'dark':
                return `
          background-color: #1a1a1a;
          color: #e0e0e0;
        `;
            case 'sepia':
                return `
          background-color: #f4ecd8;
          color: #5b4636;
        `;
            case 'light':
            default:
                return `
          background-color: #ffffff;
          color: #24292f;
        `;
        }
    };

    return {
        getThemeStyles,
    };
}

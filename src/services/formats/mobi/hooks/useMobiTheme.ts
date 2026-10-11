/**
 * Mobi 主题样式 Hook
 */

import { getReaderPageBackground } from '../../../../constants/readerTheme';

export interface MobiThemeHook {
    getThemeStyles: (theme: string) => string;
}

export function useMobiTheme(): MobiThemeHook {
    /**
     * 获取主题样式
     */
    const getThemeStyles = (theme: string): string => {
        // 页面底色统一取自主题常量；文字色仍由各格式自行维护
        const bg = getReaderPageBackground(theme);
        switch (theme) {
            case 'dark':
                return `
          background-color: ${bg};
          color: #e0e0e0;
        `;
            case 'sepia':
                return `
          background-color: ${bg};
          color: #5b4636;
        `;
            case 'light':
            default:
                return `
          background-color: ${bg};
          color: #24292f;
        `;
        }
    };

    return {
        getThemeStyles,
    };
}

import { useState, useEffect } from "react";
import {
    getReaderSettings,
    saveReaderSettings,
    ReaderSettings,
} from "../../../services";
import { statusBarService } from "../../../services/statusBarService";
import { IBookRenderer } from "../../../services/formats";
import { EpubRenderer } from "../../../services/formats/epub/EpubRenderer";

/**
 * 管理阅读器设置的 Hook
 * 负责加载、监听和保存阅读器设置，以及处理状态栏等副作用
 * 注意：阅读模式(readingMode)已改为书籍级配置，由 useBookReadingMode 管理
 */
export const useReaderSettings = (rendererRef?: React.MutableRefObject<IBookRenderer | null>) => {
    const [settings, setSettings] = useState<ReaderSettings>(getReaderSettings());

    // 监听多窗口/标签页的设置变化同步
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === "reader_settings_v1") {
                setSettings(getReaderSettings());
            }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    // 应用状态栏设置（副作用）
    // 阅读页留白背景恒为深色（#000000 / #2c2c2c），需要浅色图标
    useEffect(() => {
        statusBarService.applySettings(settings.showStatusBar, 'light');
        return () => {
            // 卸载时恢复状态栏显示，并恢复系统默认的图标外观（与更新前一致）
            statusBarService.applySettings(true, 'system');
        };
    }, [settings.showStatusBar]);

    // 当页面间隙变化时，更新 EPUB 渲染器的分割线间距
    useEffect(() => {
        if (!rendererRef) return;
        const renderer = rendererRef.current;
        if (renderer && renderer instanceof EpubRenderer) {
            renderer.updatePageGap(settings.pageGap);
        }
    }, [settings.pageGap, rendererRef]);

    // 辅助函数：更新并保存设置
    const updateSettings = (partial: Partial<ReaderSettings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...partial };
            saveReaderSettings(partial);
            return next;
        });
    };

    return {
        settings,
        setSettings,
        updateSettings,
    };
};

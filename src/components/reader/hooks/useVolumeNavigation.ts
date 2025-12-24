import { useEffect } from "react";
import { volumeKeyService } from "../../../services/volumeKeyService";

/**
 * 音量键翻页 Hook
 * 监听音量键事件并调用翻页函数
 */
export const useVolumeNavigation = (
    enabled: boolean,
    actions: { nextPage: () => void; prevPage: () => void }
) => {
    const { nextPage, prevPage } = actions;

    useEffect(() => {
        if (!enabled) {
            volumeKeyService.setEnabled(false);
            return;
        }

        // 启用音量键翻页
        volumeKeyService.setEnabled(true);
        volumeKeyService.onVolumeKey((direction) => {
            if (direction === "up") {
                prevPage();
            } else {
                nextPage();
            }
        });

        // 清理：禁用音量键翻页并移除回调
        return () => {
            volumeKeyService.setEnabled(false);
            volumeKeyService.onVolumeKey(null);
        };
    }, [enabled, nextPage, prevPage]);
};

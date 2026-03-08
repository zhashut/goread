import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { IBookRenderer } from '../../../services/formats/types';
import { useTTS } from '../../tts';
import { EpubRenderer } from '../../../services/formats/epub/EpubRenderer';
import { logError } from '../../../services';

interface UseReaderTTSOptions {
    rendererRef: React.MutableRefObject<IBookRenderer | null>;
    /** 格式标记，用于计算 listenSupported */
    isEpubDom: boolean;
    isMobi: boolean;
    isTxt: boolean;
    readingMode: "horizontal" | "vertical";
    onReadingActivity?: () => void;
}

interface UseReaderTTSReturn {
    /** 当前格式是否支持听书 */
    listenSupported: boolean;
    /** TTS 是否处于激活状态（朗读中或暂停中） */
    isListening: boolean;
    /** 切换听书开关（处理 toast 消息） */
    handleToggleListen: () => void;
    stopListenSilently: () => Promise<void>;
    /** 听书状态 toast 消息（空字符串表示不显示） */
    listenToastMsg: string;
    /** 清除 toast 消息 */
    clearListenToast: () => void;
    notifyTtsDocumentUpdated: () => void;
    markTtsViewOutOfSync: (pageNum: number) => void;
}

/**
 * Reader 层 TTS 听书逻辑
 * 封装 listenSupported 计算、useTTS 调用、toggle 回调和 toast 状态管理
 */
export const useReaderTTS = ({
    rendererRef,
    isEpubDom,
    isMobi,
    isTxt,
    readingMode,
    onReadingActivity,
}: UseReaderTTSOptions): UseReaderTTSReturn => {
    // 听书功能仅支持 epub / mobi / txt
    const listenSupported = isEpubDom || isMobi || isTxt;
    const viewSyncRef = useRef({
        outOfSync: false,
        syncing: false,
        lastPreciseProgress: 0,
    });
    const notifyDocumentUpdatedRef = useRef<(() => Promise<void>) | null>(null);

    const handleTtsMark = useCallback(async (mark: string): Promise<void> => {
        if (!isEpubDom || readingMode !== "horizontal") return;

        const renderer = rendererRef.current;
        if (!(renderer instanceof EpubRenderer)) return;

        const sync = viewSyncRef.current;

        if (!sync.outOfSync) {
            const p = renderer.getInstantPreciseProgress();
            if (p > 0 && isFinite(p)) {
                sync.lastPreciseProgress = p;
            }
            return;
        }

        if (sync.syncing) return;

        const target = sync.lastPreciseProgress;
        if (!(target > 0 && isFinite(target))) return;

        sync.syncing = true;
        try {
            await renderer.goToPage(target);
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            await notifyDocumentUpdatedRef.current?.();
            sync.outOfSync = false;
        } catch (e) {
            void logError('[TTS][Sync] EPUB 横向校准失败', { error: String(e), mark, target });
        } finally {
            sync.syncing = false;
        }
    }, [isEpubDom, readingMode, rendererRef]);

    const tts = useTTS({ rendererRef, listenSupported, onReadingActivity, onMark: handleTtsMark });
    notifyDocumentUpdatedRef.current = tts.notifyDocumentUpdated;

    const [listenToastMsg, setListenToastMsg] = useState("");

    const { t: tReader } = useTranslation('reader');

    const handleToggleListen = useCallback(async () => {
        const result = await tts.toggle();
        // toggle 返回 void 表示被防抖拦截，无需 toast
        if (!result) return;
        if ('action' in result && result.action === 'stop') {
            setListenToastMsg(tReader('listenOff'));
        } else if (result.success) {
            setListenToastMsg(tReader('listenOn'));
        } else {
            const reason = result.failReason ?? 'listenFailedUnknown';
            setListenToastMsg(tReader(reason));
        }
    }, [tts.toggle, tReader]);

    const markTtsViewOutOfSync = useCallback((pageNum: number) => {
        if (!tts.isActive) return;
        if (!isEpubDom || readingMode !== "horizontal") return;
        if (!isFinite(pageNum) || pageNum <= 0) return;
        const renderer = rendererRef.current;
        if (renderer instanceof EpubRenderer) {
            const sync = viewSyncRef.current;
            if (!(sync.lastPreciseProgress > 0) || !isFinite(sync.lastPreciseProgress)) {
                const p = renderer.getInstantPreciseProgress();
                if (p > 0 && isFinite(p)) {
                    sync.lastPreciseProgress = p;
                }
            }
        }
        viewSyncRef.current.outOfSync = true;
    }, [tts.isActive, isEpubDom, readingMode, rendererRef]);

    return {
        listenSupported,
        isListening: tts.isActive,
        handleToggleListen,
        stopListenSilently: tts.stop,
        listenToastMsg,
        clearListenToast: () => setListenToastMsg(""),
        notifyTtsDocumentUpdated: tts.notifyDocumentUpdated,
        markTtsViewOutOfSync,
    };
};

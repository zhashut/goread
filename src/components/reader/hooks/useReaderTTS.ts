import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { IBookRenderer } from '../../../services/formats/types';
import { useTTS, type TTSWarningKey } from '../../tts';

interface UseReaderTTSOptions {
    rendererRef: React.MutableRefObject<IBookRenderer | null>;
    /** 格式标记，用于计算 listenSupported */
    isEpubDom: boolean;
    isMobi: boolean;
    isTxt: boolean;
    readingMode: 'horizontal' | 'vertical';
    onReadingActivity?: () => void;
    /** 通知标题（书名），仅 Android 原生媒体通知使用 */
    notificationTitle?: string;
    /** 通知副标题（章节名） */
    notificationSubtitle?: string;
    /** 书籍 id：用于解析封面作为通知大图标 */
    notificationBookId?: number;
}

interface UseReaderTTSReturn {
    listenSupported: boolean;
    isListening: boolean;
    handleToggleListen: () => void;
    stopListenSilently: () => Promise<void>;
    /** 模式切换前调用：先回写朗读位置再停止，保证切换后进度连续 */
    stopListenAndRestore: () => Promise<void>;
    listenToastMsg: string;
    clearListenToast: () => void;
    notifyTtsDocumentUpdated: () => void;
    /** 留作占位：横向阅读时若发现页面切换需要刷新 anchor 索引 */
    markTtsViewOutOfSync: (pageNum: number) => void;
}

/**
 * Reader 层 TTS 听书逻辑
 * 仅负责：listenSupported 计算、useTTS 调用、toggle 回调与 toast 状态
 */
export const useReaderTTS = ({
    rendererRef,
    isEpubDom,
    isMobi,
    isTxt,
    readingMode: _readingMode,
    onReadingActivity,
    notificationTitle,
    notificationSubtitle,
    notificationBookId,
}: UseReaderTTSOptions): UseReaderTTSReturn => {
    const listenSupported = isEpubDom || isMobi || isTxt;
    const { t: tReader } = useTranslation('reader');
    const [listenToastMsg, setListenToastMsg] = useState('');

    // 非阻塞警告映射为 toast（例如后台保活服务启动失败）
    const handleWarning = useCallback(
        (key: TTSWarningKey) => {
            setListenToastMsg(tReader(key));
        },
        [tReader],
    );

    const tts = useTTS({
        rendererRef,
        listenSupported,
        onReadingActivity,
        notificationTitle,
        notificationSubtitle,
        notificationBookId,
        onWarning: handleWarning,
    });

    const handleToggleListen = useCallback(async () => {
        const result = await tts.toggle();
        if (!result) return;
        if ('action' in result && result.action === 'stop') {
            setListenToastMsg(tReader('listenOff'));
        } else if (result.success) {
            // 通知权限被拒绝时，朗读仍可正常开始，仅提示后台无通知
            setListenToastMsg(
                result.notificationPermissionDenied
                    ? tReader('listenOnNotificationDisabled')
                    : tReader('listenOn'),
            );
        } else {
            const reason = result.failReason ?? 'listenFailedUnknown';
            setListenToastMsg(tReader(reason));
        }
    }, [tts.toggle, tReader]);

    const markTtsViewOutOfSync = useCallback((_pageNum: number) => {
        if (!tts.isActive) return;
        // 翻页时通知 Provider 重新计算 anchor 索引
        tts.notifyDocumentUpdated();
    }, [tts.isActive, tts.notifyDocumentUpdated]);

    return {
        listenSupported,
        isListening: tts.isActive,
        handleToggleListen,
        stopListenSilently: tts.stop,
        stopListenAndRestore: tts.stopAndRestorePosition,
        listenToastMsg,
        clearListenToast: () => setListenToastMsg(''),
        notifyTtsDocumentUpdated: tts.notifyDocumentUpdated,
        markTtsViewOutOfSync,
    };
};

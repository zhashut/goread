import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { IBookRenderer } from '../../../services/formats/types';
import { useTTS } from '../../tts';

interface UseReaderTTSOptions {
    rendererRef: React.MutableRefObject<IBookRenderer | null>;
    /** 格式标记，用于计算 listenSupported */
    isEpubDom: boolean;
    isMobi: boolean;
    isTxt: boolean;
    readingMode: 'horizontal' | 'vertical';
    onReadingActivity?: () => void;
}

interface UseReaderTTSReturn {
    listenSupported: boolean;
    isListening: boolean;
    handleToggleListen: () => void;
    stopListenSilently: () => Promise<void>;
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
}: UseReaderTTSOptions): UseReaderTTSReturn => {
    const listenSupported = isEpubDom || isMobi || isTxt;
    const tts = useTTS({ rendererRef, listenSupported, onReadingActivity });

    const [listenToastMsg, setListenToastMsg] = useState('');
    const { t: tReader } = useTranslation('reader');

    const handleToggleListen = useCallback(async () => {
        const result = await tts.toggle();
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
        listenToastMsg,
        clearListenToast: () => setListenToastMsg(''),
        notifyTtsDocumentUpdated: tts.notifyDocumentUpdated,
        markTtsViewOutOfSync,
    };
};


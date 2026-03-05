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
}

interface UseReaderTTSReturn {
    /** 当前格式是否支持听书 */
    listenSupported: boolean;
    /** TTS 是否处于激活状态（朗读中或暂停中） */
    isListening: boolean;
    /** 切换听书开关（处理 toast 消息） */
    handleToggleListen: () => void;
    /** 听书状态 toast 消息（空字符串表示不显示） */
    listenToastMsg: string;
    /** 清除 toast 消息 */
    clearListenToast: () => void;
    notifyTtsDocumentUpdated: () => void;
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
}: UseReaderTTSOptions): UseReaderTTSReturn => {
    // 听书功能仅支持 epub / mobi / txt
    const listenSupported = isEpubDom || isMobi || isTxt;

    // 底层 TTS hook
    const tts = useTTS({ rendererRef, listenSupported });

    // 听书状态提示
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

    return {
        listenSupported,
        isListening: tts.isActive,
        handleToggleListen,
        listenToastMsg,
        clearListenToast: () => setListenToastMsg(""),
        notifyTtsDocumentUpdated: tts.notifyDocumentUpdated,
    };
};

import { useState } from "react";
import html2canvas from "html2canvas";
import {
    QUALITY_SCALE_MAP,
} from "../../../constants/config";
import { useReaderState } from "./useReaderState";

type CaptureProps = {
    readerState: ReturnType<typeof useReaderState>;
    refs: {
        dataset: {
            domContainerRef: React.RefObject<HTMLDivElement>;
            canvasRef: React.RefObject<HTMLCanvasElement>;
            verticalScrollRef: React.RefObject<HTMLDivElement>;
            verticalCanvasRefs: React.MutableRefObject<Map<number, HTMLCanvasElement>>;
        };
    };
    data: {
        readingMode: "horizontal" | "vertical";
        settings: { renderQuality?: string };
    };
    actions: {
        setUiVisible: (visible: boolean) => void;
        setMoreDrawerOpen: (open: boolean) => void;
    };
};

/**
 * 截图功能 Hook
 * 负责：
 * 1. 捕捉当前阅读视图（Canvas 或 DOM）
 * 2. 处理 DPR 缩放
 * 3. 拼接纵向模式的 Canvas
 */
export const useCapture = ({
    readerState,
    refs,
    data,
    actions,
}: CaptureProps) => {
    const [cropMode, setCropMode] = useState(false);
    const [capturedImage, setCapturedImage] = useState<string | null>(null);

    const { isDomRender } = readerState;
    const { domContainerRef, canvasRef, verticalScrollRef, verticalCanvasRefs } =
        refs.dataset;
    const { readingMode, settings } = data;
    const { setUiVisible, setMoreDrawerOpen } = actions;

    const getCurrentScale = () => {
        const dpr = Math.max(1, Math.min(3, (window as any).devicePixelRatio || 1));
        const qualityScale =
            QUALITY_SCALE_MAP[settings.renderQuality || "standard"] || 1.0;
        return dpr * qualityScale;
    };

    const handleCapture = async () => {
        let dataUrl = "";
        try {
            const dpr = getCurrentScale();

            // DOM 渲染模式（Markdown 等格式）：使用 html2canvas 截图
            if (isDomRender) {
                if (domContainerRef.current) {
                    const canvas = await html2canvas(domContainerRef.current, {
                        scale: dpr,
                        useCORS: true,
                        backgroundColor: "#ffffff",
                    });
                    dataUrl = canvas.toDataURL("image/png");
                }
            } else if (readingMode === "horizontal") {
                if (canvasRef.current) {
                    dataUrl = canvasRef.current.toDataURL("image/png");
                }
            } else {
                if (verticalScrollRef.current) {
                    const container = verticalScrollRef.current;
                    const width = container.clientWidth;
                    const height = container.clientHeight;
                    const canvas = document.createElement("canvas");
                    // 使用 DPR 提升截图清晰度
                    canvas.width = width * dpr;
                    canvas.height = height * dpr;
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                        ctx.fillStyle = "#2a2a2a";
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        verticalCanvasRefs.current.forEach((vCanvas) => {
                            const rect = vCanvas.getBoundingClientRect();
                            const containerRect = container.getBoundingClientRect();
                            const relativeTop = rect.top - containerRect.top;
                            const relativeLeft = rect.left - containerRect.left;
                            if (relativeTop < height && relativeTop + rect.height > 0) {
                                // 绘制时考虑 DPR 缩放
                                ctx.drawImage(
                                    vCanvas,
                                    relativeLeft * dpr,
                                    relativeTop * dpr,
                                    rect.width * dpr,
                                    rect.height * dpr
                                );
                            }
                        });
                        dataUrl = canvas.toDataURL("image/png");
                    }
                }
            }
            if (dataUrl) {
                setCapturedImage(dataUrl);
                setCropMode(true);
                setMoreDrawerOpen(false);
                setUiVisible(false);
            }
        } catch (e) {
            console.error("Capture failed", e);
        }
    };

    return {
        cropMode,
        setCropMode,
        capturedImage,
        setCapturedImage,
        handleCapture,
    };
};

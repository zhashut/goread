import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import html2canvas from "html2canvas";
import {
    QUALITY_SCALE_MAP,
} from "../../../constants/config";
import { useReaderState } from "./useReaderState";
import { ReaderSettings } from "../../../services";

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
        settings: ReaderSettings;
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
    const [searchParams, setSearchParams] = useSearchParams();

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
            const theme = data.settings.theme || "light";
            let domBgColor = "#ffffff";
            if (theme === "dark") {
                domBgColor = "#000000";
            } else if (theme === "sepia") {
                domBgColor = "#f4ecd8";
            }

            // DOM 渲染模式：使用 html2canvas 截图
            if (isDomRender) {
                if (domContainerRef.current) {
                    const canvas = await html2canvas(domContainerRef.current, {
                        scale: dpr,
                        useCORS: true,
                        backgroundColor: domBgColor,
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
                        const isDark = theme === "dark";
                        const bgColor = isDark ? "#000000" : "#ffffff";
                        const dividerColor = isDark ? "#ffffff" : "#000000";
                        ctx.fillStyle = bgColor;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);

                        const containerRect = container.getBoundingClientRect();
                        const items: {
                            canvas: HTMLCanvasElement;
                            top: number;
                            left: number;
                            width: number;
                            height: number;
                        }[] = [];

                        verticalCanvasRefs.current.forEach((vCanvas) => {
                            const rect = vCanvas.getBoundingClientRect();
                            const relativeTop = rect.top - containerRect.top;
                            const relativeLeft = rect.left - containerRect.left;
                            if (relativeTop < height && relativeTop + rect.height > 0) {
                                items.push({
                                    canvas: vCanvas,
                                    top: relativeTop,
                                    left: relativeLeft,
                                    width: rect.width,
                                    height: rect.height,
                                });
                            }
                        });

                        items.sort((a, b) => a.top - b.top);

                        items.forEach((item, index) => {
                            ctx.drawImage(
                                item.canvas,
                                item.left * dpr,
                                item.top * dpr,
                                item.width * dpr,
                                item.height * dpr
                            );

                            if (index < items.length - 1) {
                                const next = items[index + 1];
                                const currentBottom = item.top + item.height;
                                const gapTop = currentBottom;
                                const gapBottom = next.top;
                                const gapHeight = gapBottom - gapTop;
                                if (gapHeight > 0) {
                                    ctx.fillStyle = dividerColor;
                                    ctx.fillRect(
                                        0,
                                        gapTop * dpr,
                                        canvas.width,
                                        gapHeight * dpr
                                    );
                                    ctx.fillStyle = bgColor;
                                }
                            }
                        });
                        dataUrl = canvas.toDataURL("image/png");
                    }
                }
            }
            if (dataUrl) {
                setCapturedImage(dataUrl);
                setMoreDrawerOpen(false);
                setUiVisible(false);
                const next = new URLSearchParams(searchParams);
                next.set("crop", "1");
                setSearchParams(next, { replace: false });
            }
        } catch (e) {
            console.error("Capture failed", e);
        }
    };

    useEffect(() => {
        const cropFlag = searchParams.get("crop") === "1";
        if (cropFlag && !cropMode) {
            setCropMode(true);
        } else if (!cropFlag && cropMode) {
            setCropMode(false);
            setCapturedImage(null);
            setUiVisible(false);
        }
    }, [searchParams, cropMode, setUiVisible]);

    const closeCrop = () => {
        setCropMode(false);
        setCapturedImage(null);
        setUiVisible(false);
        const currentCrop = searchParams.get("crop");
        if (currentCrop === "1") {
            const next = new URLSearchParams(searchParams);
            next.delete("crop");
            setSearchParams(next, { replace: true });
        }
    };

    return {
        cropMode,
        setCropMode,
        capturedImage,
        setCapturedImage,
        handleCapture,
        closeCrop,
    };
};

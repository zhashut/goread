/**
 * 渐进式渲染管理器
 * 先渲染低分辨率版本，再渲染高分辨率版本，提升感知速度
 */

export interface ProgressiveRenderOptions {
    lowScale: number;  // 低分辨率缩放比例
    highScale: number; // 高分辨率缩放比例
    transitionDuration: number; // 过渡动画时长（ms）
}

export class ProgressiveRenderer {
    private defaultOptions: ProgressiveRenderOptions = {
        lowScale: 0.5,
        highScale: 1.0,
        transitionDuration: 200,
    };

    /**
     * 渐进式渲染页面
     * @param pdfPage PDF.js的页面对象
     * @param canvas 目标canvas元素
     * @param options 渲染选项
     * @param onLowResReady 低分辨率渲染完成回调
     * @param onHighResReady 高分辨率渲染完成回调
     */
    async render(
        pdfPage: any,
        canvas: HTMLCanvasElement,
        options: Partial<ProgressiveRenderOptions> = {},
        onLowResReady?: () => void,
        onHighResReady?: () => void
    ): Promise<void> {
        const opts = { ...this.defaultOptions, ...options };
        const context = canvas.getContext('2d');
        if (!context) return;

        try {
            // 第一阶段：渲染低分辨率版本
            const lowViewport = pdfPage.getViewport({ scale: opts.lowScale });

            // 创建临时canvas用于低分辨率渲染
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = lowViewport.width;
            tempCanvas.height = lowViewport.height;
            const tempContext = tempCanvas.getContext('2d')!;

            // 渲染低分辨率
            await pdfPage.render({
                canvasContext: tempContext,
                viewport: lowViewport,
            }).promise;

            // 设置canvas尺寸为高分辨率
            const highViewport = pdfPage.getViewport({ scale: opts.highScale });
            canvas.width = highViewport.width;
            canvas.height = highViewport.height;

            // 将低分辨率图像拉伸到canvas（快速显示）
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);

            // 设置过渡动画
            canvas.style.transition = `opacity ${opts.transitionDuration}ms ease`;
            canvas.style.opacity = '1';

            if (onLowResReady) {
                onLowResReady();
            }

            // 第二阶段：渲染高分辨率版本
            // 使用requestIdleCallback在空闲时渲染，避免阻塞UI
            await new Promise<void>((resolve) => {
                const renderHighRes = async () => {
                    // 创建另一个临时canvas用于高分辨率渲染
                    const highResCanvas = document.createElement('canvas');
                    highResCanvas.width = highViewport.width;
                    highResCanvas.height = highViewport.height;
                    const highResContext = highResCanvas.getContext('2d')!;

                    // 渲染高分辨率
                    await pdfPage.render({
                        canvasContext: highResContext,
                        viewport: highViewport,
                    }).promise;

                    // 平滑过渡到高分辨率
                    canvas.style.opacity = '0.7';

                    // 短暂延迟后替换
                    setTimeout(() => {
                        context.clearRect(0, 0, canvas.width, canvas.height);
                        context.drawImage(highResCanvas, 0, 0);
                        canvas.style.opacity = '1';

                        if (onHighResReady) {
                            onHighResReady();
                        }

                        resolve();
                    }, 50);
                };

                // 使用requestIdleCallback或setTimeout
                if ('requestIdleCallback' in window) {
                    requestIdleCallback(() => renderHighRes());
                } else {
                    setTimeout(() => renderHighRes(), 0);
                }
            });

        } catch (error) {
            console.error('Progressive render failed:', error);
            throw error;
        }
    }

    /**
     * 简单渲染（不使用渐进式）
     */
    async renderDirect(
        pdfPage: any,
        canvas: HTMLCanvasElement,
        scale: number = 1.0
    ): Promise<void> {
        const viewport = pdfPage.getViewport({ scale });
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await pdfPage.render({
            canvasContext: context,
            viewport: viewport,
        }).promise;
    }
}

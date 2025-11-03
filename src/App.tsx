import { useState, useRef } from "react";
// 导入 tauri API 的根模块
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
// 导入 pdf.js 库的主模块和类型
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.js",
  import.meta.url
).toString();

function App() {
  // 使用 state 来存储 PDF 文档对象和一些元数据
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [feedback, setFeedback] = useState("请选择一个 PDF 文件开始阅读。");

  // 使用 ref 来获取对 canvas DOM 元素的直接引用
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * 核心功能函数：打开、读取并渲染 PDF 文件。
   * 这是一个异步函数，因为它涉及到等待用户操作和文件 I/O。
   */
  const openAndRenderPdf = async () => {
    try {
      setFeedback("正在打开文件选择对话框...");

      // 调用 Tauri 的对话框 API，让用户选择一个 PDF 文件。
      const selectedPath = await open({
        multiple: false, // 只允许选择单个文件
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      // 如果用户取消了选择，selectedPath 会是 null
      if (!selectedPath || Array.isArray(selectedPath)) {
        setFeedback("用户取消了文件选择。");
        return;
      }

      setFeedback(`正在读取文件: ${selectedPath}`);

      // 使用 Tauri 的文件系统 API 读取文件的二进制内容。
      // readFile 函数返回 Uint8Array，这正是 pdf.js 所需的数据格式。
      const pdfData = await readFile(selectedPath);

      setFeedback("文件读取成功，正在使用 PDF.js 解析...");

      // 将二进制数据加载到 PDF.js 中。
      // `getDocument` 返回一个加载任务的 promise。
      const loadingTask = pdfjsLib.getDocument(pdfData);
      const pdf = await loadingTask.promise;

      setPdfDoc(pdf); // 将解析后的 PDF 文档对象存入 state
      setFeedback(`PDF 解析成功！总共 ${pdf.numPages} 页。正在渲染第一页...`);

      // 获取 PDF 的第一页并进行渲染。
      const page = await pdf.getPage(1); // 页码从 1 开始

      const canvas = canvasRef.current;
      if (!canvas) {
        throw new Error("Canvas 元素未找到！");
      }

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("无法获取 Canvas 的 2D 上下文！");
      }

      // 设置一个合适的缩放比例来渲染页面
      const viewport = page.getViewport({ scale: 1.5 });

      // 调整 canvas 的尺寸以匹配 PDF 页面的尺寸
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      // 创建渲染任务
      const renderTask = page.render({
        canvasContext: context,
        viewport: viewport,
      });

      await renderTask.promise; // 等待渲染完成
      setFeedback(`第一页渲染完成。`);
    } catch (error) {
      console.error("处理 PDF 时发生错误:", error);
      setFeedback(`发生错误: ${error}`);
    }
  };

  return (
    <div style={{ padding: "20px", textAlign: "center" }}>
      <h1>Read Tauri - 阶段 0 验证</h1>
      <button onClick={openAndRenderPdf} style={{ marginBottom: "20px" }}>
        打开 PDF 文件
      </button>
      <p>{feedback}</p>
      {/* 渲染 PDF 的画布 */}
      <div
        style={{
          border: "1px solid #ccc",
          marginTop: "20px",
          display: "inline-block",
        }}
      >
        <canvas ref={canvasRef}></canvas>
      </div>
    </div>
  );
}

export default App;

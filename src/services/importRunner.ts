import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { bookService, groupService } from "./index";
import { pathToTitle, waitNextFrame } from "./importUtils";

// 运行导入到已存在分组，并同步导入进度到 UI（标题/进度）
export const importPathsToExistingGroup = async (
  paths: string[],
  groupId: number
) => {
  const total = paths.length;
  const firstTitle = paths[0] ? pathToTitle(paths[0]) : "";

  // 广播开始事件
  window.dispatchEvent(
    new CustomEvent("goread:import:start", {
      detail: { total, title: firstTitle },
    })
  );

  let cancelled = false;
  const cancelHandler = () => {
    cancelled = true;
  };
  window.addEventListener("goread:import:cancel", cancelHandler as any, {
    once: false,
  });

  for (let i = 0; i < paths.length; i++) {
    if (cancelled) break;
    const filePath = paths[i];

    // 在处理前同步当前书籍标题到抽屉，current 保持为 i
    {
      const title = pathToTitle(filePath) || "Unknown";
      window.dispatchEvent(
        new CustomEvent("goread:import:progress", {
          detail: { current: i, total, title },
        })
      );
      // 让出一帧，以确保UI刷新
      await waitNextFrame();
    }

    // 读取与解析PDF，生成封面
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const fileData = await readFile(filePath);
    (pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl;
    let pdf: any;
    try {
      pdf = await (pdfjs as any).getDocument({ data: fileData }).promise;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("GlobalWorkerOptions.workerSrc")) {
        pdf = await (pdfjs as any).getDocument({
          data: fileData,
          disableWorker: true,
        }).promise;
      } else {
        throw e;
      }
    }
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: context, viewport }).promise;
    const coverImage = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
    const title = pathToTitle(filePath) || "Unknown";
    const saved = await bookService.addBook(
      filePath,
      title,
      coverImage,
      pdf.numPages
    );
    await groupService.moveBookToGroup(saved.id, groupId);

    // 完成一册后同步进度与标题
    window.dispatchEvent(
      new CustomEvent("goread:import:progress", {
        detail: { current: i + 1, total, title },
      })
    );
    await waitNextFrame();
  }

  window.removeEventListener("goread:import:cancel", cancelHandler as any);
  window.dispatchEvent(new CustomEvent("goread:import:done"));
  window.dispatchEvent(new CustomEvent("goread:groups:changed"));
  window.dispatchEvent(new CustomEvent("goread:books:changed"));
};

// 创建分组并导入书籍（同样同步进度）
export const createGroupAndImport = async (
  paths: string[],
  groupName: string
) => {
  const g = await groupService.addGroup(groupName.trim());
  await importPathsToExistingGroup(paths, g.id);
};
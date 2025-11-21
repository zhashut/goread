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
    const invoke = await import("../services/index").then(m => m.getInvoke());
    const info = await invoke('pdf_load_document', { filePath });
    const dataUrl: string = await invoke('pdf_render_page_base64', {
      filePath: filePath,
      pageNumber: 1,
      quality: 'thumbnail',
      width: 256,
      height: null,
    });
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    context.drawImage(img, 0, 0);
    const coverImage = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
    const title = pathToTitle(filePath) || "Unknown";
    const saved = await bookService.addBook(
      filePath,
      title,
      coverImage,
      (info?.info.page_count ?? 0)
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

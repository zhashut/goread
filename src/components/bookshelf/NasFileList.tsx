import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { Loading } from "../Loading";
import { BookCard } from "../BookCard";
import { isSupportedFile } from "../../constants/fileTypes";
import type { NasConnection, NasEntry } from "../../utils/nasConnections";
import { useNasBrowse } from "./hooks/useNasBrowse";
import { useAppNav } from "../../router/useAppNav";
import { nasOpenRemote, formatNasBytes } from "../../services/nasService";
import { txtPreloader, isTxtFile } from "../../services/formats/txt/txtPreloader";
import type { BookshelfTab, IBook, IGroup } from "../../types";
import type { BookshelfViewMode } from "./TopBar";
import FolderCover from "./FolderCover";
import { GroupListRow, BookListRow } from "./BookshelfListRows";
import {
  GROUP_GRID_COLUMNS,
  GROUP_GRID_GAP,
  GRID_GAP_GROUP_DETAIL,
  CARD_INFO_MARGIN_TOP,
  GROUP_NAME_FONT_SIZE,
  GROUP_NAME_FONT_WEIGHT,
  TOP_BAR_MARGIN_BOTTOM,
} from "../../constants/ui";

/** 下载进度事件 payload（与后端 DownloadProgress 结构对应） */
type NasDownloadProgress = {
  /** 文件名（后端已清洗） */
  name: string;
  /** 已下载字节数 */
  downloaded: number;
  /** 总字节数（服务器未返回时为 null） */
  total?: number | null;
};

interface NasFileListProps {
  /** 当前页签对应的 NAS 连接配置 */
  connection: NasConnection;
  /** 轻提示回调（如打开失败时的提示文案） */
  onNotify: (msg: string) => void;
  /** 视图模式（grid/list）：与本地书架页签共用同一状态 */
  viewMode: BookshelfViewMode;
}

/**
 * 网络书架文件列表组件
 *
 * 展示指定 NAS 连接的远程 WebDAV 目录内容：顶部面包屑支持层级跳转，
 * 展示风格与本地书架保持一致（网格/列表双视图）——目录以文件夹卡片/分组行呈现，
 * 文件以书籍卡片/书籍行呈现（未入库统一按「未读」样式，无封面按格式回退）。
 * 目录点击进入下一层，文件点击即打开阅读（透明缓存：命中缓存秒开，
 * 未命中自动下载并显示进度浮层，完成后直接进入阅读器，进度/书签自动保留）。
 * 仅展示目录与受支持的书籍文件，其余文件（如图片、隐藏文件）自动过滤。
 *
 * @param connection 当前页签对应的 NAS 连接
 * @param onNotify 轻提示回调，透传 toast 文案
 * @param viewMode 视图模式，与本地书架保持一致
 */
export const NasFileList: React.FC<NasFileListProps> = ({
  connection,
  onNotify,
  viewMode,
}) => {
  const { t } = useTranslation('bookshelf');
  const nav = useAppNav();
  // 目录浏览状态与动作（连接切换时自动从起始路径重新加载）
  const { entries, loading, error, dirStack, goInto, goToDepth, reload } =
    useNasBrowse(connection);

  // 打开远端书状态：openingPath 标记正在打开的文件（防重复点击）；
  // progress 为事件推送的下载进度；showOverlay 延迟 300ms 再显示浮层，缓存命中秒开时不闪烁
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<NasDownloadProgress | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const openingRef = useRef(false);
  const unmountedRef = useRef(false);

  // 目录遮罩状态：与本地书架分组详情（GroupDetailOverlay）一致的进入体验——
  // 点击目录弹出毛玻璃遮罩，在遮罩内继续浏览；dirOverlayBaseDepth 记录
  // 打开遮罩时的页签层级，关闭时据此恢复页签浏览位置
  const [dirOverlayOpen, setDirOverlayOpen] = useState(false);
  const [dirOverlayBaseDepth, setDirOverlayBaseDepth] = useState(0);

  // 监听后端下载进度事件（与「导入-NAS」页共用 goread:nas:download 事件）
  useEffect(() => {
    // React StrictMode（dev）下 effect 会经历 mount→cleanup→re-mount 双执行：
    // cleanup 置 unmountedRef=true 后 re-mount 不会自动复位，必须在此显式重置，
    // 否则该标志永久为 true，后续所有 `!unmountedRef.current` 分支（浮层/跳转/提示）被吞
    unmountedRef.current = false;
    const unlisten = listen<NasDownloadProgress>("goread:nas:download", (e) => {
      if (!unmountedRef.current) setProgress(e.payload);
    });
    return () => {
      unmountedRef.current = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  // 进度百分比（total 未知时进度条走 0，文本展示已下载字节数）
  const percent = progress?.total
    ? Math.min(100, Math.round(((progress.downloaded || 0) / progress.total) * 100))
    : 0;

  /**
   * 点击文件行直接打开远端书籍（透明缓存）
   * 功能描述：调用 nas_open_remote 命令，后端按「连接 id + 远端路径」确定性缓存：
   *          命中缓存直接复用，未命中流式下载（进度经 goread:nas:download 事件推送），
   *          完成后入库并返回书籍 id，跳转阅读器续读。300ms 内完成不显示进度浮层。
   * 参数说明：entry - 被点击的文件条目。
   * 返回值类型及用途：无返回（异步跳转阅读器，失败时经 onNotify 提示）。
   */
  const handleOpenFile = useCallback(async (entry: NasEntry) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpeningPath(entry.path);
    setProgress({ name: entry.name, downloaded: 0, total: entry.size ?? null });
    const timer = window.setTimeout(() => {
      if (!unmountedRef.current) setShowOverlay(true);
    }, 300);
    try {
      const result = await nasOpenRemote(connection, entry.path, entry.name);
      // 重下载发生后失效 TXT 渲染缓存：此处先于阅读页执行，若不处理，
      // 阅读页二次调用 nas_open_remote 时缓存已命中（was_cached=true），
      // 旧章节内容会一直命中 txtCacheService 直到整页刷新
      if (!result.was_cached && isTxtFile(result.cache_path)) {
        txtPreloader.clear(result.cache_path);
      }
      if (!unmountedRef.current) {
        // 跳转阅读器（fromTab 记录来源 NAS 页签，返回书架时可定位）
        nav.toReader(result.book_id, { fromTab: `nas:${connection.id}` as BookshelfTab });
      }
    } catch (e) {
      if (!unmountedRef.current) {
        onNotify(`${t("nasOpenFailed")}: ${String(e)}`);
      }
    } finally {
      window.clearTimeout(timer);
      openingRef.current = false;
      if (!unmountedRef.current) {
        setShowOverlay(false);
        setOpeningPath(null);
        setProgress(null);
      }
    }
  }, [connection, nav, onNotify, t]);

  // 过滤出目录与受支持的书籍文件
  const visibleEntries = entries.filter(
    (e) => e.is_dir || isSupportedFile(e.path)
  );

  /**
   * 将 NAS 文件条目映射为伪书籍对象（复用本地书架卡片/列表行渲染）
   * 功能描述：NAS 文件未入库，仅构造展示所需字段——无 cover_image 时封面按文件格式回退；
   *          total_pages=0 且无 last_read_time 使进度逻辑判定为「未读」。
   * 参数说明：entry - NAS 文件条目。
   * 返回值类型及用途：IBook，供 BookCard / BookListRow 展示。
   */
  const entryToBook = (entry: NasEntry): IBook => ({
    id: 0,
    title: entry.name,
    file_path: entry.path,
    current_page: 0,
    total_pages: 0,
  });

  /**
   * 将 NAS 目录条目映射为伪分组对象（复用本地书架分组行渲染）
   * 功能描述：NAS 目录无文件计数，仅构造展示所需字段，配合 metaText={null} 隐藏「(文件N个)」。
   * 参数说明：entry - NAS 目录条目。
   * 返回值类型及用途：IGroup，供 GroupListRow 展示。
   */
  const entryToGroup = (entry: NasEntry): IGroup => ({
    id: 0,
    name: entry.name,
    book_count: 0,
  });

  /**
   * 点击目录条目：弹出目录浏览遮罩
   * 功能描述：记录打开遮罩时的页签层级（关闭时据此恢复），再进入目标目录；
   *          目录内容在遮罩内展示（样式与本地书架分组详情一致），页签本体被遮罩覆盖。
   * 参数说明：entry - 被点击的目录条目。
   * 返回值类型及用途：无返回（更新遮罩状态并异步加载目录）。
   */
  const handleDirClick = (entry: NasEntry) => {
    if (loading) return;
    setDirOverlayBaseDepth(dirStack.length - 1);
    setDirOverlayOpen(true);
    goInto(entry);
  };

  /**
   * 关闭目录遮罩
   * 功能描述：收起遮罩并将页签浏览层级恢复到打开遮罩前的深度；加载中不响应，
   *          与页签内面包屑/卡片的 loading 防护一致，避免层级栈与条目列表竞态错位。
   * 参数说明：无。
   * 返回值类型及用途：无返回（更新遮罩状态并异步恢复层级）。
   */
  const handleDirOverlayClose = () => {
    if (loading) return;
    setDirOverlayOpen(false);
    goToDepth(dirOverlayBaseDepth);
  };

  /**
   * 渲染目录条目网格
   * 功能描述：以三列网格展示目录（文件夹卡片）与书籍文件（书籍卡片），
   *          目录点击回调由调用方注入（页签内点击弹遮罩、遮罩内点击继续下钻）；
   *          网格列数与本地书架分组详情一致，间距由调用方通过 gapPx 决定。
   * 参数说明：onDirClick - 目录条目点击回调；gapPx - 网格间距（像素）。
   * 返回值类型及用途：JSX，目录条目网格。
   */
  const renderEntryGrid = (
    onDirClick: (entry: NasEntry) => void,
    gapPx: number
  ) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
        gap: gapPx + "px",
        alignContent: "start",
        gridAutoRows: "min-content",
      }}
    >
      {visibleEntries.map((entry) =>
        entry.is_dir ? (
          <div
            key={entry.path}
            onClick={() => !loading && onDirClick(entry)}
            style={{ cursor: loading ? "wait" : "pointer" }}
          >
            <FolderCover />
            <div style={{ marginTop: CARD_INFO_MARGIN_TOP + "px" }}>
              <div
                style={{
                  fontSize: GROUP_NAME_FONT_SIZE + "px",
                  fontWeight: GROUP_NAME_FONT_WEIGHT,
                  color: "#333",
                  lineHeight: 1.5,
                  overflow: "hidden",
                  textAlign: "left",
                  display: "-webkit-box",
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: "vertical" as any,
                }}
              >
                {entry.name}
              </div>
            </div>
          </div>
        ) : (
          <BookCard
            key={entry.path}
            width="100%"
            book={entryToBook(entry)}
            onClick={() => handleOpenFile(entry)}
          />
        )
      )}
    </div>
  );

  return (
    <div style={{ paddingBottom: "var(--goread-navbar-h)" }}>
      {/* 面包屑导航：当前层置灰不可点，历史层可跳转 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          fontSize: 13,
          padding: "6px 16px 8px 16px",
        }}
      >
        {dirStack.map((seg, idx) => (
          <React.Fragment key={seg.path + idx}>
            <button
              onClick={() => {
                if (!loading && idx !== dirStack.length - 1) goToDepth(idx);
              }}
              style={{
                background: "none",
                border: "none",
                boxShadow: "none",
                borderRadius: 0,
                padding: 0,
                cursor:
                  idx === dirStack.length - 1 || loading ? "default" : "pointer",
                color: idx === dirStack.length - 1 ? "#999" : "#555",
                maxWidth: 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginRight: 6,
              }}
              title={seg.path}
              disabled={loading}
            >
              {seg.name}
            </button>
            {idx < dirStack.length - 1 && (
              <span style={{ color: "#999", marginRight: 6 }}>›</span>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* 状态分支：加载中 / 加载失败 / 空目录 / 目录内容 */}
      {loading && entries.length === 0 ? (
        <Loading
          visible
          overlay={false}
          text=""
          showSpinner={false}
          style={{ height: 120 }}
          textStyle={{ color: "#999" }}
        />
      ) : error ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: 300,
            color: "#999",
          }}
        >
          <div style={{ fontSize: "15px", marginBottom: 6 }}>
            {t("nasLoadFailed")}
          </div>
          <div style={{ fontSize: "13px", marginBottom: 16, color: "#bbb" }}>
            {error}
          </div>
          <button
            onClick={reload}
            style={{
              height: 36,
              padding: "0 24px",
              border: "none",
              borderRadius: 18,
              background: "#d15158",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {t("retry")}
          </button>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: 300,
            color: "#999",
          }}
        >
          <div style={{ fontSize: "15px" }}>{t("nasDirEmpty")}</div>
        </div>
      ) : (
        viewMode === "grid" ? (
          renderEntryGrid(handleDirClick, GROUP_GRID_GAP)
        ) : (
          visibleEntries.map((entry) =>
            entry.is_dir ? (
              <GroupListRow
                key={entry.path}
                group={entryToGroup(entry)}
                selectable={false}
                selected={false}
                metaText={null}
                onClick={() => handleDirClick(entry)}
                onLongPress={() => {}}
                onToggleSelect={() => {}}
              />
            ) : (
              <BookListRow
                key={entry.path}
                book={entryToBook(entry)}
                selectable={false}
                selected={false}
                onClick={() => handleOpenFile(entry)}
                onLongPress={() => {}}
                onToggleSelect={() => {}}
              />
            )
          )
        )
      )}

      {/* 目录浏览遮罩：样式与本地书架分组详情（GroupDetailOverlay + GroupDetail）保持一致——
          毛玻璃遮罩 + 居中标题 + 75vh #f7f7f7 主体，遮罩内固定网格视图、可继续下钻；
          点击遮罩空白处关闭并恢复页签进入前层级 */}
      {dirOverlayOpen && (
        <div
          onClick={handleDirOverlayClose}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(225,225,225,0.6)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              marginTop: TOP_BAR_MARGIN_BOTTOM + 35,
            }}
          >
            {/* 标题：当前所在目录名（NAS 目录只读，无本地分组的点击编辑交互） */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: "16px",
                fontWeight: 500,
                color: "#333",
                textAlign: "center",
                marginBottom: "12px",
                display: "inline-block",
                padding: "0 4px",
                maxWidth: "80%",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {dirStack[dirStack.length - 1]?.name}
            </div>
            {/* 抽屉主体：宽度占满、高度 75vh，内容滚动区样式与 GroupDetail 一致 */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                height: "75vh",
                maxHeight: "75vh",
                overflow: "hidden",
                background: "#f7f7f7",
                boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  backgroundColor: "#f7f7f7",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* 遮罩内面包屑：仅展示所进入目录之下的层级（超过一层才显示），支持层级跳转 */}
                {dirStack.length - dirOverlayBaseDepth - 1 > 1 && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      fontSize: 13,
                      padding: "6px 16px 8px 16px",
                    }}
                  >
                    {dirStack.slice(dirOverlayBaseDepth + 1).map((seg, idx) => {
                      const isCurrent =
                        idx ===
                        dirStack.length - dirOverlayBaseDepth - 2;
                      return (
                        <React.Fragment key={seg.path + idx}>
                          <button
                            onClick={() => {
                              if (!loading && !isCurrent) {
                                goToDepth(dirOverlayBaseDepth + 1 + idx);
                              }
                            }}
                            style={{
                              background: "none",
                              border: "none",
                              boxShadow: "none",
                              borderRadius: 0,
                              padding: 0,
                              cursor:
                                isCurrent || loading ? "default" : "pointer",
                              color: isCurrent ? "#999" : "#555",
                              maxWidth: 160,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              marginRight: 6,
                            }}
                            title={seg.path}
                            disabled={loading}
                          >
                            {seg.name}
                          </button>
                          {!isCurrent && (
                            <span style={{ color: "#999", marginRight: 6 }}>
                              ›
                            </span>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}
                {/* 遮罩内状态分支：加载中 / 加载失败 / 空目录 / 目录内容（固定网格视图） */}
                {loading && entries.length === 0 ? (
                  <Loading
                    visible
                    overlay={false}
                    text=""
                    showSpinner={false}
                    style={{ flex: 1 }}
                    textStyle={{ color: "#666" }}
                  />
                ) : error ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: 1,
                      color: "#999",
                    }}
                  >
                    <div style={{ fontSize: "15px", marginBottom: 6 }}>
                      {t("nasLoadFailed")}
                    </div>
                    <div
                      style={{
                        fontSize: "13px",
                        marginBottom: 16,
                        color: "#bbb",
                      }}
                    >
                      {error}
                    </div>
                    <button
                      onClick={reload}
                      style={{
                        height: 36,
                        padding: "0 24px",
                        border: "none",
                        borderRadius: 18,
                        background: "#d15158",
                        color: "#fff",
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      {t("retry")}
                    </button>
                  </div>
                ) : visibleEntries.length === 0 ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: 1,
                      color: "#999",
                      fontSize: "15px",
                    }}
                  >
                    {t("nasDirEmpty")}
                  </div>
                ) : (
                  <div
                    className="no-scrollbar"
                    style={{
                      flex: 1,
                      overflowY: "auto",
                      padding: "16px 8px 16px 16px",
                    }}
                  >
                    {renderEntryGrid(goInto, GRID_GAP_GROUP_DETAIL)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 打开远端书进度浮层：下载中展示文件名与进度；300ms 内完成（缓存命中）则不显示 */}
      {showOverlay && openingPath && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              width: 260,
              padding: "18px 20px",
              borderRadius: 12,
              background: "#fff",
              boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
            }}
          >
            <div
              style={{
                fontSize: 14,
                color: "#333",
                marginBottom: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={progress?.name}
            >
              {progress?.name}
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "#eee",
                overflow: "hidden",
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${percent}%`,
                  borderRadius: 3,
                  background: "#d15158",
                  transition: "width 0.2s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: "#999", textAlign: "center" }}>
              {progress?.total
                ? `${percent}%`
                : formatNasBytes(progress?.downloaded || 0)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { useAppNav } from "../router/useAppNav";
import { IBook } from "../types";
import { COVER_ASPECT_RATIO_COMPACT, GROUP_GRID_COLUMNS, GROUP_GRID_GAP } from "../constants/ui";
import { bookService } from "../services";
import { BookCard } from "./BookCard";
import { SearchHeader } from "./SearchHeader";
import { epubPreloader, isEpubFile } from "../services/formats/epub/epubPreloader";
import { mobiPreloader, isMobiFile } from "../services/formats/mobi/mobiPreloader";
import { txtPreloader, isTxtFile } from "../services/formats/txt/txtPreloader";
import { useNasSearch, NasSearchResult } from "../hooks/useNasSearch";
import { nasOpenRemote } from "../services/nasService";
import { showGlobalToast } from "../utils/globalToast";


const EmptyState: React.FC = () => {
  const { t } = useTranslation('search');
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#bbb",
        flexDirection: "column",
      }}
    >
      <svg
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ marginBottom: "8px" }}
      >
        <rect
          x="4"
          y="3"
          width="16"
          height="18"
          rx="2"
          stroke="#ccc"
          strokeWidth="2"
        />
        <line
          x1="7"
          y1="8"
          x2="17"
          y2="8"
          stroke="#ccc"
          strokeWidth="2"
        />
        <line
          x1="7"
          y1="12"
          x2="17"
          y2="12"
          stroke="#ccc"
          strokeWidth="2"
        />
      </svg>
      <div>{t('noFiles')}</div>
    </div>
  );
};

export const Search: React.FC = () => {
  const { t } = useTranslation('search');
  const { t: tc } = useTranslation('common');
  // 网络书架打开失败提示复用 bookshelf 命名空间的既有文案
  const { t: tb } = useTranslation('bookshelf');
  const nav = useAppNav();


  const [books, setBooks] = useState<IBook[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  // 网络书架点击即读防并发标记：防止重复点击触发多次下载入库
  const nasOpeningRef = useRef(false);

  // 网络书架搜索：防抖后遍历全部 NAS 连接，搜索未入库的远端书籍文件
  const { results: nasResults, searching: nasSearching } = useNasSearch(query);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const list = await bookService.getAllBooks();
        setBooks(list || []);
      } catch (e) {
        setBooks([]);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as IBook[];
    return (books || []).filter((b) =>
      (b.title || "").toLowerCase().includes(q)
    );
  }, [books, query]);

  // 已入库 NAS 书籍的「连接id|远端路径」集合，用于识别网络书架结果中已存在的书籍
  const importedNasKeys = useMemo(() => {
    const set = new Set<string>();
    for (const b of books || []) {
      if (b.source === 'nas' && b.source_conn_id && b.source_path) {
        set.add(`${b.source_conn_id}|${b.source_path}`);
      }
    }
    return set;
  }, [books]);

  // 网络书架搜索结果过滤：剔除已入库书籍，仅展示尚未导入的远端文件
  const filteredNasResults = useMemo(
    () => nasResults.filter((r) => !importedNasKeys.has(`${r.connection.id}|${r.entry.path}`)),
    [nasResults, importedNasKeys]
  );

  /**
   * 将网络书架搜索结果映射为展示用伪书籍对象
   * 功能描述：NAS 文件未入库，仅构造 BookCard 展示所需字段（与网络书架页 entryToBook 一致）。
   * 参数说明：result - 网络书架搜索结果。
   * 返回值类型及用途：返回 IBook，供 BookCard 展示。
   */
  const nasResultToBook = (result: NasSearchResult): IBook => ({
    id: 0,
    title: result.entry.name,
    file_path: result.entry.path,
    current_page: 0,
    total_pages: 0,
  });

  /**
   * 打开网络书架搜索结果中的未入库文件
   * 功能描述：调用 nasOpenRemote 将远端文件下载缓存并入库（幂等，命中缓存秒开），
   *          TXT 文件新下载后失效预加载缓存，随后跳转阅读器；
   *          进行中防重复点击，失败时经全局 Toast 提示。
   * 参数说明：result - 网络书架搜索结果（含连接配置与远端条目）。
   * 返回值类型及用途：无返回（异步执行，成功后跳转阅读器）。
   */
  const handleOpenNasFile = async (result: NasSearchResult) => {
    if (nasOpeningRef.current) return;
    nasOpeningRef.current = true;
    try {
      showGlobalToast(t('nasOpening'));
      const res = await nasOpenRemote(result.connection, result.entry.path, result.entry.name);
      // TXT 新缓存后失效预加载缓存，避免阅读器读到过期目录结构
      if (!res.was_cached && isTxtFile(res.cache_path)) {
        txtPreloader.clear(res.cache_path);
      }
      nav.toReader(res.book_id);
    } catch (e) {
      showGlobalToast(`${tb("nasOpenFailed")}: ${String(e)}`);
    } finally {
      nasOpeningRef.current = false;
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#fafafa",
        overflow: "hidden",
      }}
    >
      <SearchHeader
        value={query}
        onChange={setQuery}
        onClose={() => nav.goBack()}
        onClear={() => setQuery("")}
        placeholder={t('placeholder')}
        autoFocus
      />
      {query.trim() !== "" && (
        <div
          style={{
            marginTop: "8px",
            fontSize: "14px",
            color: "#666",
            padding: "0 12px",
            flexShrink: 0,
          }}
        >
          {t('totalBooks', { count: results.length })}
        </div>
      )}

      {/* 结果区域 */}
      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: "auto", position: "relative" }}
      >
        {loading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "#666",
            }}
          >
            {tc('loading')}
          </div>
        ) : !query ? (
          <EmptyState />
        ) : results.length === 0 && filteredNasResults.length === 0 && !nasSearching ? (
          <EmptyState />
        ) : (
          <>
            {results.length > 0 && (
              <div
                style={{
                  padding: "16px 8px 16px 16px",
                  display: "grid",
                  gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                  gap: GROUP_GRID_GAP + "px",
                }}
              >
                {results.map((b) => (
                  <BookCard
                    width="100%"
                    key={b.id}
                    book={b}
                    aspectRatio={COVER_ASPECT_RATIO_COMPACT}
                    onClick={() => {
                      // EPUB 预加载：提前触发书籍加载，利用页面切换时间完成 ZIP 解析
                      if (isEpubFile(b.file_path)) {
                        epubPreloader.preload(b.file_path);
                      }
                      // MOBI 预加载：提前触发书籍加载，利用页面切换时间完成解析
                      if (isMobiFile(b.file_path)) {
                        mobiPreloader.preload(b.file_path);
                      }
                      // TXT 预加载：提前触发元数据加载，利用页面切换时间完成目录解析
                      if (isTxtFile(b.file_path)) {
                        txtPreloader.preload(b.file_path);
                      }
                      nav.toReader(b.id);
                    }}
                  />
                ))}
              </div>
            )}
            {/* 网络书架结果分区：遍历 NAS 连接命中的未入库书籍文件 */}
            {(nasSearching || filteredNasResults.length > 0) && (
              <div style={{ paddingBottom: "16px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "12px 16px 4px",
                    fontSize: "13px",
                    color: "#999",
                  }}
                >
                  <span>{t('nasSection')}</span>
                  {nasSearching && <span>{t('nasSearching')}</span>}
                </div>
                <div
                  style={{
                    padding: "8px 8px 0 16px",
                    display: "grid",
                    gridTemplateColumns: `repeat(${GROUP_GRID_COLUMNS}, minmax(0, 1fr))`,
                    gap: GROUP_GRID_GAP + "px",
                  }}
                >
                  {filteredNasResults.map((r) => (
                    <BookCard
                      width="100%"
                      key={`nas-${r.connection.id}-${r.entry.path}`}
                      book={nasResultToBook(r)}
                      aspectRatio={COVER_ASPECT_RATIO_COMPACT}
                      onClick={() => handleOpenNasFile(r)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

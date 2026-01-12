import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from 'react-i18next';
import { useAppNav } from "../router/useAppNav";
import { IBook } from "../types";
import { COVER_ASPECT_RATIO_COMPACT, GROUP_GRID_COLUMNS, GROUP_GRID_GAP } from "../constants/ui";
import { bookService } from "../services";
import { BookCard } from "./BookCard";
import { SearchHeader } from "./SearchHeader";
import { epubPreloader, isEpubFile } from "../services/formats/epub/epubPreloader";

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
  const nav = useAppNav();

  
  const [books, setBooks] = useState<IBook[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

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
        ) : results.length === 0 ? (
          <EmptyState />
        ) : (
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
                  nav.toReader(b.id);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

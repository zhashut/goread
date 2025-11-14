import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { IBook } from "../types";
import { COVER_ASPECT_RATIO_COMPACT, GRID_GAP_BOOK_CARDS } from "../constants/ui";
import { bookService } from "../services";
import { BookCard } from "./BookCard";

export const Search: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const fromTab = (params.get("tab") === "all" ? "all" : "recent");
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
    <div style={{ minHeight: "100vh", background: "#fafafa" }}>
      {/* 顶部搜索栏（贴近图1样式）*/}
      <div style={{ padding: "10px 12px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: "#efefef",
            borderRadius: "12px",
            height: "40px",
            padding: "0 8px",
            overflow: "hidden",
          }}
        >
          <button
            onClick={() => navigate(`/?tab=${fromTab}`)}
            aria-label="返回"
            title="返回"
            style={{
              background: "transparent",
              border: "none",
              width: "32px",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              margin: 0,
              cursor: "pointer",
              color: "#666",
              boxShadow: "none",
              borderRadius: 0,
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M15 18l-6-6 6-6"
                stroke="#666"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入书名关键词..."
            autoFocus
            style={{
              flex: 1,
              padding: "0 6px",
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: "14px",
              color: "#333",
              caretColor: "#d15158",
              height: "100%",
              boxShadow: "none",
              WebkitAppearance: "none",
              appearance: "none",
              borderRadius: 0,
            }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="清除"
              aria-label="清除"
              style={{
                background: "transparent",
                border: "none",
                padding: "0 4px",
                height: "100%",
                display: "flex",
                alignItems: "center",
                cursor: "pointer",
                boxShadow: "none",
                borderRadius: 0,
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="12" cy="12" r="10" stroke="#999" strokeWidth="2" />
                <path
                  d="M9 9l6 6m0-6l-6 6"
                  stroke="#999"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
        {query.trim() !== "" && (
          <div style={{ marginTop: "8px", fontSize: "14px", color: "#666" }}>
            共 {results.length} 本
          </div>
        )}
      </div>

      {/* 结果区域 */}
      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "60vh",
            color: "#666",
          }}
        >
          加载中…
        </div>
      ) : !query ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "60vh",
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
            <line x1="7" y1="8" x2="17" y2="8" stroke="#ccc" strokeWidth="2" />
            <line
              x1="7"
              y1="12"
              x2="17"
              y2="12"
              stroke="#ccc"
              strokeWidth="2"
            />
          </svg>
          <div>没有文件信息</div>
        </div>
      ) : results.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "60vh",
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
            <line x1="7" y1="8" x2="17" y2="8" stroke="#ccc" strokeWidth="2" />
            <line
              x1="7"
              y1="12"
              x2="17"
              y2="12"
              stroke="#ccc"
              strokeWidth="2"
            />
          </svg>
          <div>没有文件信息</div>
        </div>
      ) : (
        <div
          style={{
            padding: "12px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, 160px)",
            gap: GRID_GAP_BOOK_CARDS + "px",
            justifyItems: "center",
          }}
        >
          {results.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              width={160}
              aspectRatio={COVER_ASPECT_RATIO_COMPACT}
              onClick={() => navigate(`/reader/${b.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

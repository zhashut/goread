import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useLayoutEffect,
} from "react";
import { useNavigate, useLocation } from "react-router-dom";
import * as pdfjs from "pdfjs-dist";
// 通过 Vite 将 worker 打包为可用 URL，并告知 PDF.js
// 这样就不需要手动禁用 worker，性能也更好
// @ts-ignore
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { IBook, IGroup } from "../types";
import { bookService, groupService, getReaderSettings } from "../services";
import { GroupDetail } from "./GroupDetail";

interface BookCardProps {
  book: IBook;
  onClick: () => void;
  onDelete: () => void;
}

const BookCard: React.FC<BookCardProps> = ({ book, onClick, onDelete }) => {
  const progress =
    book.total_pages > 0
      ? Math.min(
          100,
          Math.round((book.current_page / book.total_pages) * 1000) / 10
        )
      : 0;

  return (
    <div
      className="book-card"
      onClick={onClick}
      style={{
        width: "160px",
        margin: 0,
        cursor: "pointer",
        transition: "transform 0.2s ease",
        backgroundColor: "transparent",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-4px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <div
        style={{
          width: "100%",
          height: "230px",
          backgroundColor: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          border: "1px solid #e5e5e5",
          borderRadius: "4px",
          boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
          overflow: "hidden",
        }}
      >
        {/* 删除按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="删除书籍"
          style={{
            position: "absolute",
            top: "6px",
            right: "6px",
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            padding: "4px 6px",
            fontSize: "12px",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.8)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.6)";
          }}
        >
          删除
        </button>
        {book.cover_image ? (
          <img
            src={`data:image/jpeg;base64,${book.cover_image}`}
            alt={book.title}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <div
            style={{
              color: "#999",
              fontSize: "14px",
              textAlign: "center",
            }}
          >
            暂无封面
          </div>
        )}
      </div>
      <div style={{ marginTop: "8px" }}>
        <div
          style={{
            fontSize: "14px",
            fontWeight: 500,
            color: "#333",
            lineHeight: 1.5,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as any,
            overflow: "hidden",
            textAlign: "left",
          }}
        >
          {book.title}
        </div>
        <div
          style={{
            marginTop: "4px",
            fontSize: "12px",
            color: "#888",
            textAlign: "left",
          }}
        >
          已读 {progress}%
        </div>
      </div>
    </div>
  );
};

export const Bookshelf: React.FC = () => {
  const location = useLocation();
  const [books, setBooks] = useState<IBook[]>([]);
  const [groups, setGroups] = useState<IGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"recent" | "all">(() => {
    const search =
      typeof window !== "undefined" ? window.location.search : location.search;
    const params = new URLSearchParams(search || "");
    return params.get("tab") === "all" ? "all" : "recent";
  });

  // Sync tab with URL when it changes to avoid visual switching from recent -> all
  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const next = params.get("tab") === "all" ? "all" : "recent";
    setActiveTab((prev) => (prev === next ? prev : next));
  }, [location.search]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  // tabs underline animation
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const recentLabelRef = useRef<HTMLDivElement | null>(null);
  const allLabelRef = useRef<HTMLDivElement | null>(null);
  const [underlinePos, setUnderlinePos] = useState<{
    left: number;
    width: number;
  }>({ left: 0, width: 0 });
  const [animateUnderline, setAnimateUnderline] = useState(false);
  const [underlineReady, setUnderlineReady] = useState(false);
  const navigate = useNavigate();
  const [groupOverlayOpen, setGroupOverlayOpen] = useState(false);
  const [overlayGroupId, setOverlayGroupId] = useState<number | null>(null);

  useEffect(() => {
    loadBooks();
    loadGroups();
  }, []);

  // 监听分组详情页的删除事件，及时刷新“最近”
  useEffect(() => {
    const onChanged = () => {
      loadBooks();
    };
    window.addEventListener("goread:books:changed", onChanged as any);
    return () =>
      window.removeEventListener("goread:books:changed", onChanged as any);
  }, []);

  // 监听分组变化事件，刷新分组列表与封面
  useEffect(() => {
    const onGroupsChanged = () => {
      loadGroups();
    };
    window.addEventListener("goread:groups:changed", onGroupsChanged as any);
    return () =>
      window.removeEventListener(
        "goread:groups:changed",
        onGroupsChanged as any
      );
  }, []);

  const loadBooks = async () => {
    try {
      setLoading(true);
      await bookService.initDatabase();
      const settings = getReaderSettings();
      const recentCount = Math.max(1, settings.recentDisplayCount || 9);
      let list: IBook[] = [];
      try {
        const recent = await bookService.getRecentBooks(recentCount);
        // 仅显示真正阅读过的书籍；如果没有则“最近”为空
        list = Array.isArray(recent) ? recent : [];
      } catch {
        const allBooks = await bookService.getAllBooks();
        list = (allBooks || []).sort(
          (a, b) => (b.last_read_time || 0) - (a.last_read_time || 0)
        );
      }
      setBooks(list);
    } catch (error) {
      console.error("Failed to load books:", error);
      setBooks([]);
    } finally {
      setLoading(false);
    }
  };

  const loadGroups = async () => {
    try {
      const allGroups = await groupService.getAllGroups();
      setGroups(allGroups || []);
    } catch (error) {
      console.error("Failed to load groups:", error);
      setGroups([]);
    }
  };

  const handleBookClick = (book: IBook) => {
    navigate(`/reader/${book.id}`);
  };

  const handleImportBook = async () => {
    try {
      const [{ open }, { readFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);

      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (selected && !Array.isArray(selected)) {
        const filePath =
          typeof selected === "string" ? selected : (selected as any).path;
        const fileName =
          typeof selected === "string"
            ? selected.split("\\").pop()?.split("/").pop()
            : (selected as any).name;

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

        const title = fileName?.replace(/\.pdf$/i, "") || "Unknown";
        await bookService.addBook(filePath, title, coverImage, pdf.numPages);
        await loadBooks();
        alert(`成功导入书籍: ${title}`);
      }
    } catch (error: any) {
      console.error("Failed to import book:", error);
      const msg =
        typeof error?.message === "string" ? error.message : String(error);
      alert(`导入书籍失败，请重试\n\n原因：${msg}`);
    }
  };

  const handleDeleteBook = async (book: IBook) => {
    try {
      if (activeTab === "recent") {
        let ok: boolean = false;
        try {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          ok = await confirm(`仅从“最近”中移除该书籍？不会删除书籍`, {
            title: "goread",
          });
        } catch {
          ok = window.confirm("仅从“最近”中移除该书籍？不会删除书籍");
        }
        if (!ok) return;
        await bookService.clearRecent(book.id);
        await loadBooks();
      } else {
        let ok: boolean = false;
        try {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          ok = await confirm(`确认删除该书籍及其书签?`, { title: "goread" });
        } catch {
          ok = window.confirm("确认删除该书籍及其书签?");
        }
        if (!ok) return;
        await bookService.deleteBook(book.id);
        await Promise.all([loadBooks(), loadGroups()]);
      }
    } catch (error: any) {
      console.error("删除书籍失败:", error);
      const msg =
        typeof error?.message === "string" ? error.message : String(error);
      alert(`删除书籍失败，请重试\n\n原因：${msg}`);
    }
  };
  // 分组封面：基于“全部”分组中的书籍封面（最多4张）
  const [groupCovers, setGroupCovers] = useState<Record<number, string[]>>({});
  useEffect(() => {
    const run = async () => {
      try {
        const entries = await Promise.all(
          (groups || []).map(async (g) => {
            try {
              const list = await groupService.getBooksByGroup(g.id);
              const covers = (list || [])
                .filter((b) => !!b.cover_image)
                .slice(0, 4)
                .map((b) => b.cover_image as string);
              return [g.id, covers] as [number, string[]];
            } catch {
              return [g.id, []] as [number, string[]];
            }
          })
        );
        const map: Record<number, string[]> = {};
        entries.forEach(([id, covers]) => {
          map[id] = covers;
        });
        setGroupCovers(map);
      } catch (e) {
        setGroupCovers({});
      }
    };
    if (groups && groups.length > 0) run();
    else setGroupCovers({});
  }, [groups]);

  const filteredBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return books;
    return books.filter((b) => (b.title || "").toLowerCase().includes(q));
  }, [books, query]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => (g.name || "").toLowerCase().includes(q));
  }, [groups, query]);

  // 点击外部关闭更多菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const inMenu = !!(
        menuRef.current &&
        target &&
        menuRef.current.contains(target)
      );
      const inBtn = !!(
        menuBtnRef.current &&
        target &&
        menuBtnRef.current.contains(target)
      );
      if (!inMenu && !inBtn) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  // 计算“更多”菜单的定位：基于视口坐标居中于按钮；在靠近右侧时自动左移并保留安全边距
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const btn = menuBtnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const btnRect = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const edge = 14; // 右侧安全边距（视口）
    const menuWidth = menu.offsetWidth || 0;
    let center = btnRect.left + btnRect.width / 2; // 视口坐标
    const maxCenter = vw - edge - menuWidth / 2;
    const minCenter = edge + menuWidth / 2;
    center = Math.max(minCenter, Math.min(maxCenter, center));
    const top = btnRect.bottom + 6; // 视口坐标
    setMenuPos({ left: center, top });
  }, [menuOpen]);

  // update underline position smoothly when active tab or layout changes
  useLayoutEffect(() => {
    const update = () => {
      const target =
        activeTab === "recent" ? recentLabelRef.current : allLabelRef.current;
      if (!target || !tabsRef.current) return;
      const tabsRect = tabsRef.current.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      setUnderlinePos({ left: rect.left - tabsRect.left, width: rect.width });
      setUnderlineReady(true);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [activeTab, loading]);

  // ensure underline is positioned on first paint using current activeTab
  useLayoutEffect(() => {
    const update = () => {
      const target =
        activeTab === "recent" ? recentLabelRef.current : allLabelRef.current;
      if (!target || !tabsRef.current) return;
      const tabsRect = tabsRef.current.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      setUnderlinePos({ left: rect.left - tabsRect.left, width: rect.width });
      setUnderlineReady(true);
    };
    update();
    requestAnimationFrame(update);
  }, []);

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          fontSize: "16px",
          color: "#666",
        }}
      >
        加载中...
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "16px 8px 16px 16px",
        height: "100vh",
        backgroundColor: "#fafafa",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "12px",
        }}
      >
        <div
          ref={tabsRef}
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: "18px",
            position: "relative",
            paddingBottom: "8px",
          }}
        >
          <button
            onClick={() => {
              setActiveTab("recent");
              setAnimateUnderline(true);
            }}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              boxShadow: "none",
              borderRadius: 0,
            }}
            title="最近"
          >
            <div
              ref={recentLabelRef}
              style={{
                fontSize: "18px",
                color: activeTab === "recent" ? "#000" : "#bbb",
                transition: "color 200ms ease",
              }}
            >
              最近
            </div>
          </button>
          <button
            onClick={() => {
              setActiveTab("all");
              setAnimateUnderline(true);
            }}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              boxShadow: "none",
              borderRadius: 0,
            }}
            title="全部"
          >
            <div
              ref={allLabelRef}
              style={{
                fontSize: "18px",
                color: activeTab === "all" ? "#000" : "#bbb",
                transition: "color 200ms ease",
              }}
            >
              全部
            </div>
          </button>
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: underlinePos.left,
              width: underlinePos.width,
              height: "3px",
              backgroundColor: "#d15158",
              transition: animateUnderline
                ? "left 250ms ease, width 250ms ease"
                : "none",
              opacity: underlineReady ? 1 : 0,
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "20px",
            position: "relative",
          }}
        >
          <button
            title="搜索"
            aria-label="搜索"
            onClick={() => navigate(`/search?tab=${activeTab}`)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              margin: 0,
              cursor: "pointer",
              color: "#333",
              WebkitAppearance: "none",
              appearance: "none",
              outline: "none",
              boxShadow: "none",
              borderRadius: 0,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="11" cy="11" r="7" stroke="#333" strokeWidth="2" />
              <line
                x1="20"
                y1="20"
                x2="16.5"
                y2="16.5"
                stroke="#333"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            ref={menuBtnRef}
            title="更多"
            aria-label="更多"
            onClick={() => setMenuOpen((m) => !m)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              margin: 0,
              cursor: "pointer",
              color: "#333",
              WebkitAppearance: "none",
              appearance: "none",
              outline: "none",
              boxShadow: "none",
              borderRadius: 0,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="#333"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                left: menuPos.left,
                top: menuPos.top,
                transform: "translateX(-50%)",
                background: "#fff",
                border: "none",
                boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
                borderRadius: "10px",
                padding: "8px 14px",
                width: "auto",
                minWidth: "100px",
                whiteSpace: "nowrap",
                zIndex: 20,
              }}
            >
              <button
                onClick={() => {
                  setMenuOpen(false);
                  navigate("/import");
                }}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 0,
                  padding: "8px 6px",
                  cursor: "pointer",
                  color: "#333",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f7f7f7";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden
                >
                  <path
                    d="M12 3v8"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M9.5 8.5L12 11l2.5-2.5"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <rect
                    x="4"
                    y="13"
                    width="16"
                    height="7"
                    rx="2"
                    stroke="#333"
                    strokeWidth="2"
                  />
                </svg>
                <span>导入</span>
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  navigate("/settings");
                }}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 0,
                  padding: "8px 6px",
                  cursor: "pointer",
                  color: "#333",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f7f7f7";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="9" stroke="#333" strokeWidth="2" />
                  <circle cx="12" cy="12" r="3" stroke="#333" strokeWidth="2" />
                  <path
                    d="M12 4.5v2.3"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M12 17.2v2.3"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M4.5 12h2.3"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M17.2 12h2.3"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M6.8 6.8l1.6 1.6"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M15.6 15.6l1.6 1.6"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M6.8 17.2l1.6-1.6"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M15.6 8.4l1.6-1.6"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <span>设置</span>
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  alert("GoRead - 轻量 PDF 阅读器");
                }}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  boxShadow: "none",
                  borderRadius: 0,
                  padding: "8px 6px",
                  cursor: "pointer",
                  color: "#333",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f7f7f7";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="9" stroke="#333" strokeWidth="2" />
                  <path
                    d="M12 9v6"
                    stroke="#333"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <circle cx="12" cy="6.5" r="1.5" fill="#333" />
                </svg>
                <span>关于</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 首页临时搜索输入移除，改为跳转到 /search */}
      <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === "recent" ? (
          filteredBooks.length === 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "400px",
                color: "#999",
              }}
            >
              <div style={{ fontSize: "18px", marginBottom: "10px" }}>
                暂无书籍
              </div>
              <div style={{ fontSize: "14px" }}>
                通过右上角“更多”中的“导入”添加书籍
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
              {filteredBooks.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  onClick={() => handleBookClick(book)}
                  onDelete={() => handleDeleteBook(book)}
                />
              ))}
            </div>
          )
        ) : filteredGroups.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "400px",
              color: "#999",
            }}
          >
            <div style={{ fontSize: "18px", marginBottom: "10px" }}>
              暂无分组
            </div>
            <div style={{ fontSize: "14px" }}>
              通过右上角“更多”中的“导入”添加书籍
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "20px 30px" }}>
            {filteredGroups.map((g) => (
              <div
                key={g.id}
                style={{ width: "160px", margin: 0, cursor: "pointer" }}
                onClick={() => {
                  setOverlayGroupId(g.id);
                  setGroupOverlayOpen(true);
                }}
              >
                <div
                  style={{
                    width: "100%",
                    background: "#fff",
                    border: "1px solid #e5e5e5",
                    borderRadius: "4px",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
                    overflow: "hidden",
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "6px",
                    padding: "6px",
                  }}
                >
                  {Array.from({ length: 4 }).map((_, idx) => {
                    const covers = groupCovers[g.id] || [];
                    const img = covers[idx];
                    return (
                      <div
                        key={idx}
                        style={{
                          width: "100%",
                          aspectRatio: "2 / 3",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: "#fff",
                          border: "1px solid #dcdcdc",
                          borderRadius: 4,
                          overflow: "hidden",
                        }}
                      >
                        {img ? (
                          <img
                            src={`data:image/jpeg;base64,${img}`}
                            alt={`cover-${idx}`}
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                              objectPosition: "center",
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              height: "100%",
                              background: "#fff",
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: "8px" }}>
                  <div
                    style={{
                      fontSize: "14px",
                      fontWeight: 500,
                      color: "#333",
                      lineHeight: 1.5,
                      overflow: "hidden",
                      textAlign: "left",
                      display: "-webkit-box",
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: "vertical" as any,
                    }}
                  >
                    {g.name}
                  </div>
                  <div
                    style={{
                      marginTop: "4px",
                      fontSize: "12px",
                      color: "#888",
                      textAlign: "left",
                    }}
                  >
                    共 {g.book_count} 本
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {groupOverlayOpen && overlayGroupId !== null && (
        <div
          onClick={() => {
            setGroupOverlayOpen(false);
            setActiveTab("all");
          }}
          style={{
            position: "fixed",
            inset: 0,
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
              gap: "12px",
            }}
          >
            {/* 标题在容器外居中 */}
            <div
              style={{
                fontSize: "16px",
                fontWeight: 500,
                color: "#333",
                textAlign: "center",
              }}
            >
              {groups.find((g) => g.id === overlayGroupId)?.name || "分组"}
            </div>
            {/* 抽屉主体：宽度占满，高度85%，居中位置 */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                height: "85vh",
                maxHeight: "85vh",
                overflow: "hidden",
                background: "#f7f7f7",
              }}
            >
              <div style={{ width: "100%", height: "100%" }}>
                <GroupDetail
                  groupIdProp={overlayGroupId}
                  onClose={() => {
                    setGroupOverlayOpen(false);
                    setActiveTab("all");
                    // 关闭抽屉时刷新分组与最近
                    loadGroups();
                    loadBooks();
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

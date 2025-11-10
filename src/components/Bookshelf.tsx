import React, { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { useNavigate } from "react-router-dom";
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
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除书籍"
          style={{
            position: 'absolute',
            top: '6px',
            right: '6px',
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            padding: '4px 6px',
            fontSize: '12px',
            cursor: 'pointer'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.8)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'; }}
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
  const [books, setBooks] = useState<IBook[]>([]);
  const [groups, setGroups] = useState<IGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'recent' | 'all'>('recent');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  // tabs underline animation
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const recentLabelRef = useRef<HTMLDivElement | null>(null);
  const allLabelRef = useRef<HTMLDivElement | null>(null);
  const [underlinePos, setUnderlinePos] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  const navigate = useNavigate();
  const [groupOverlayOpen, setGroupOverlayOpen] = useState(false);
  const [overlayGroupId, setOverlayGroupId] = useState<number | null>(null);

  useEffect(() => {
    loadBooks();
    loadGroups();
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
        if (recent && Array.isArray(recent) && recent.length > 0) {
          list = recent;
        } else {
          const allBooks = await bookService.getAllBooks();
          list = (allBooks || []).sort((a, b) => (b.last_read_time || 0) - (a.last_read_time || 0)).slice(0, recentCount);
        }
      } catch {
        const allBooks = await bookService.getAllBooks();
        list = (allBooks || []).sort((a, b) => (b.last_read_time || 0) - (a.last_read_time || 0));
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
      console.error('Failed to load groups:', error);
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
        const filePath = typeof selected === "string" ? selected : (selected as any).path;
        const fileName = typeof selected === "string" ? selected.split("\\").pop()?.split("/").pop() : (selected as any).name;

        const fileData = await readFile(filePath);
        (pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl;
        let pdf: any;
        try {
          pdf = await (pdfjs as any).getDocument({ data: fileData }).promise;
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (msg.includes("GlobalWorkerOptions.workerSrc")) {
            pdf = await (pdfjs as any).getDocument({ data: fileData, disableWorker: true }).promise;
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
      const msg = typeof error?.message === "string" ? error.message : String(error);
      alert(`导入书籍失败，请重试\n\n原因：${msg}`);
    }
  };

  const handleDeleteBook = async (book: IBook) => {
    try {
      let ok: boolean = false;
      try {
        const { confirm } = await import('@tauri-apps/plugin-dialog');
        ok = await confirm(`确认删除该书籍及其书签?`, { title: 'goread' });
      } catch {
        ok = window.confirm('确认删除该书籍及其书签?');
      }
      if (!ok) return;
      await bookService.deleteBook(book.id);
      await loadBooks();
    } catch (error: any) {
      console.error('删除书籍失败:', error);
      const msg = typeof error?.message === 'string' ? error.message : String(error);
      alert(`删除书籍失败，请重试\n\n原因：${msg}`);
    }
  };

  const groupCovers = useMemo(() => {
    const map: Record<number, string[]> = {};
    books.forEach((b) => {
      if (typeof b.group_id === 'number') {
        map[b.group_id] = map[b.group_id] || [];
        if (b.cover_image && map[b.group_id].length < 4) {
          map[b.group_id].push(b.cover_image);
        }
      }
    });
    return map;
  }, [books]);

  const filteredBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return books;
    return books.filter(b => (b.title || '').toLowerCase().includes(q));
  }, [books, query]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(g => (g.name || '').toLowerCase().includes(q));
  }, [groups, query]);

  // 点击外部关闭更多菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const inMenu = !!(menuRef.current && target && menuRef.current.contains(target));
      const inBtn = !!(menuBtnRef.current && target && menuBtnRef.current.contains(target));
      if (!inMenu && !inBtn) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  // update underline position smoothly when active tab or layout changes
  useLayoutEffect(() => {
    const update = () => {
      const target = (activeTab === 'recent') ? recentLabelRef.current : allLabelRef.current;
      if (!target || !tabsRef.current) return;
      const tabsRect = tabsRef.current.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      setUnderlinePos({ left: rect.left - tabsRect.left, width: rect.width });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [activeTab, loading]);

  // ensure underline is positioned on first paint (mount)
  useLayoutEffect(() => {
    const update = () => {
      const target = recentLabelRef.current;
      if (!target || !tabsRef.current) return;
      const tabsRect = tabsRef.current.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      setUnderlinePos({ left: rect.left - tabsRect.left, width: rect.width });
    };
    update();
    requestAnimationFrame(update);
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontSize: "16px", color: "#666" }}>加载中...</div>
    );
  }

  return (
    <div style={{ padding: '16px', minHeight: '100vh', backgroundColor: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div ref={tabsRef} style={{ display: 'flex', alignItems: 'flex-end', gap: '18px', position: 'relative', paddingBottom: '8px' }}>
          <button onClick={() => setActiveTab('recent')} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', boxShadow: 'none', borderRadius: 0 }} title="最近">
            <div ref={recentLabelRef} style={{ fontSize: '18px', color: activeTab === 'recent' ? '#000' : '#bbb', transition: 'color 200ms ease' }}>最近</div>
          </button>
          <button onClick={() => setActiveTab('all')} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', boxShadow: 'none', borderRadius: 0 }} title="全部">
            <div ref={allLabelRef} style={{ fontSize: '18px', color: activeTab === 'all' ? '#000' : '#bbb', transition: 'color 200ms ease' }}>全部</div>
          </button>
          <div style={{ position: 'absolute', bottom: 0, left: underlinePos.left, width: underlinePos.width, height: '3px', backgroundColor: '#d15158', transition: 'left 250ms ease, width 250ms ease' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', position: 'relative' }}>
          <button
            title="搜索"
            aria-label="搜索"
            onClick={() => setSearchOpen(s => !s)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              margin: 0,
              cursor: 'pointer',
              color: '#333',
              WebkitAppearance: 'none',
              appearance: 'none',
              outline: 'none',
              boxShadow: 'none',
              borderRadius: 0,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="11" cy="11" r="7" stroke="#333" strokeWidth="2" />
              <line x1="20" y1="20" x2="16.5" y2="16.5" stroke="#333" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            ref={menuBtnRef}
            title="更多"
            aria-label="更多"
            onClick={() => setMenuOpen(m => !m)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              margin: 0,
              cursor: 'pointer',
              color: '#333',
              WebkitAppearance: 'none',
              appearance: 'none',
              outline: 'none',
              boxShadow: 'none',
              borderRadius: 0,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#333" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>
          {menuOpen && (
            <div ref={menuRef} style={{ position: 'absolute', right: 0, top: '28px', background: '#fff', border: '1px solid #eee', padding: '6px 8px', width: '160px', zIndex: 10 }}>
              <button onClick={() => { setMenuOpen(false); handleImportBook(); }} style={{ width: '100%', background: 'none', border: 'none', padding: '8px 6px', cursor: 'pointer', textAlign: 'left', color: '#333' }}>导入</button>
              <button onClick={() => { setMenuOpen(false); navigate('/settings'); }} style={{ width: '100%', background: 'none', border: 'none', padding: '8px 6px', cursor: 'pointer', textAlign: 'left', color: '#333' }}>设置</button>
              <button onClick={() => { setMenuOpen(false); alert('GoRead - 轻量 PDF 阅读器'); }} style={{ width: '100%', background: 'none', border: 'none', padding: '8px 6px', cursor: 'pointer', textAlign: 'left', color: '#333' }}>关于</button>
            </div>
          )}
        </div>
      </div>

      {searchOpen && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={activeTab === 'recent' ? '搜索最近阅读…' : '搜索分组…'} style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: '6px' }} />
        </div>
      )}

      {activeTab === 'recent' ? (
        filteredBooks.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '400px', color: '#999' }}>
            <div style={{ fontSize: '18px', marginBottom: '10px' }}>暂无书籍</div>
            <div style={{ fontSize: '14px' }}>通过右上角“更多”中的“导入”添加PDF</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {filteredBooks.map((book) => (
              <BookCard key={book.id} book={book} onClick={() => handleBookClick(book)} onDelete={() => handleDeleteBook(book)} />
            ))}
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          {filteredGroups.map((g) => (
            <div key={g.id} style={{ width: '160px', margin: 0, cursor: 'pointer' }} onClick={() => { setOverlayGroupId(g.id); setGroupOverlayOpen(true); }}>
              <div style={{ width: '100%', height: '160px', background: '#fff', border: '1px solid #e5e5e5', borderRadius: '4px', boxShadow: '0 2px 6px rgba(0,0,0,0.06)', overflow: 'hidden', display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '1px' }}>
                {Array.from({ length: 4 }).map((_, idx) => {
                  const covers = groupCovers[g.id] || [];
                  const img = covers[idx];
                  return img ? (
                    <img key={idx} src={`data:image/jpeg;base64,${img}`} alt={`cover-${idx}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div key={idx} style={{ background: idx % 2 === 0 ? '#f2f2f2' : '#e9e9e9' }} />
                  );
                })}
              </div>
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 500, color: '#333', lineHeight: 1.5, overflow: 'hidden', textAlign: 'left', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' as any }}>{g.name}</div>
                <div style={{ marginTop: '4px', fontSize: '12px', color: '#888', textAlign: 'left' }}>共 {g.book_count} 本</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {groupOverlayOpen && overlayGroupId !== null && (
        <div
          onClick={() => { setGroupOverlayOpen(false); setActiveTab('all'); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(225,225,225,0.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            {/* 标题在容器外居中 */}
            <div style={{ fontSize: '16px', fontWeight: 500, color: '#333', textAlign: 'center' }}>
              {(groups.find(g => g.id === overlayGroupId)?.name) || '分组'}
            </div>
            {/* 抽屉主体：宽度占满，高度85%，居中位置 */}
            <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '85vh', maxHeight: '85vh', overflow: 'hidden', background: '#f7f7f7' }}>
              <div style={{ width: '100%', height: '100%' }}>
                <GroupDetail groupIdProp={overlayGroupId} onClose={() => { setGroupOverlayOpen(false); setActiveTab('all'); }} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

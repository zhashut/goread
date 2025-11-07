import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { IBook, IBookmark } from '../types';
// @ts-ignore
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { bookService, bookmarkService } from '../services';

export const Reader: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [book, setBook] = useState<IBook | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pdf, setPdf] = useState<any>(null);
  const [bookmarks, setBookmarks] = useState<IBookmark[]>([]);
  type TocNode = { title: string; page?: number; children?: TocNode[]; expanded?: boolean };
  const [toc, setToc] = useState<TocNode[]>([]);
  const tocItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // UI 可见与进度滑动状态
  const [uiVisible, setUiVisible] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPage, setSeekPage] = useState<number | null>(null);
  const [leftTab, setLeftTab] = useState<'toc' | 'bookmark'>('toc');
  // 目录弹层开关
  const [tocOverlayOpen, setTocOverlayOpen] = useState(false);
  // 书签提示气泡
  const [bookmarkToastVisible, setBookmarkToastVisible] = useState(false);
  const [bookmarkToastText, setBookmarkToastText] = useState('');

  useEffect(() => {
    loadBook();
  }, [bookId]);

  const loadBook = async () => {
    try {
      setLoading(true);
      const books = await bookService.getAllBooks();
      const targetBook = books.find(b => b.id === parseInt(bookId!));
      
      if (!targetBook) {
        alert('书籍不存在');
        navigate('/');
        return;
      }

      setBook(targetBook);
      setCurrentPage(targetBook.current_page);
      setTotalPages(targetBook.total_pages);

      // 加载PDF文件
      const fs = await import('@tauri-apps/plugin-fs');
      const fileData = await fs.readFile(targetBook.file_path);
      
      const pdfjs = await import('pdfjs-dist');
      // 设置 workerSrc，避免 "No GlobalWorkerOptions.workerSrc specified" 报错
      (pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl;
      let loadedPdf: any;
      try {
        loadedPdf = await (pdfjs as any).getDocument({ data: fileData }).promise;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes('GlobalWorkerOptions.workerSrc')) {
          loadedPdf = await (pdfjs as any).getDocument({ data: fileData, disableWorker: true }).promise;
        } else {
          throw e;
        }
      }
      setPdf(loadedPdf);

      // 渲染当前页面
      await renderPage(targetBook.current_page, loadedPdf);

      // 加载目录（Outline）——保留层级结构，支持字符串/数组 dest
      try {
        const outline = await loadedPdf.getOutline();
        const resolvePage = async (node: any): Promise<number | undefined> => {
          const key = node?.dest || node?.a?.dest;
          try {
            if (!key) return undefined;
            if (Array.isArray(key)) {
              const ref = key[0];
              if (ref) return (await loadedPdf.getPageIndex(ref)) + 1;
            }
            if (typeof key === 'string') {
              const dest = await loadedPdf.getDestination(key);
              const ref = dest && dest[0];
              if (ref) return (await loadedPdf.getPageIndex(ref)) + 1;
            }
          } catch (e) {
            console.warn('解析目录目标失败', e);
          }
          return undefined;
        };
        const parseNodes = async (nodes: any[] | undefined, level = 0): Promise<TocNode[]> => {
          if (!nodes || !Array.isArray(nodes)) return [];
          const result: TocNode[] = [];
          for (const n of nodes) {
            const title = n?.title || '无标题';
            const page = await resolvePage(n);
            const children = await parseNodes(n?.items || n?.children, level + 1);
            result.push({ title, page, children, expanded: level === 0 });
          }
          return result;
        };
        const root = await parseNodes(outline as any[], 0);
        setToc(root || []);
      } catch (e) {
        console.warn('获取PDF目录失败', e);
        setToc([]);
      }

      // 加载书签
      try {
        const list = await bookmarkService.getBookmarks(targetBook.id);
        setBookmarks(Array.isArray(list) ? list : []);
      } catch (e) {
        console.warn('获取书签失败', e);
        setBookmarks([]);
      }
    } catch (error) {
      console.error('Failed to load book:', error);
      alert('加载书籍失败');
    } finally {
      setLoading(false);
    }
  };

  const renderPage = async (pageNum: number, pdfDoc?: any) => {
    const pdfToUse = pdfDoc || pdf;
    if (!pdfToUse || !canvasRef.current) return;

    try {
      const page = await pdfToUse.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d')!;
      
      // 设置canvas尺寸
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      // 渲染页面
      await page.render({
        canvasContext: context,
        viewport: viewport
      }).promise;
    } catch (error) {
      console.error('Failed to render page:', error);
    }
  };

  const goToPage = async (pageNum: number) => {
    if (pageNum < 1 || pageNum > totalPages) return;
    
    setCurrentPage(pageNum);
    await renderPage(pageNum);
    
    // 保存阅读进度
    if (book) {
      await bookService.updateBookProgress(book.id!, pageNum);
    }
  };

  const nextPage = () => goToPage(currentPage + 1);
  const prevPage = () => goToPage(currentPage - 1);

  // 计算当前章节页（<= currentPage 的最大章节页）
  const findCurrentChapterPage = (nodes: TocNode[]): number | undefined => {
    const pages: number[] = [];
    const collect = (ns: TocNode[]) => {
      for (const n of ns) {
        if (typeof n.page === 'number') pages.push(n.page);
        if (n.children && n.children.length) collect(n.children);
      }
    };
    collect(nodes);
    pages.sort((a, b) => a - b);
    let target: number | undefined = undefined;
    for (const p of pages) { if (p <= currentPage) target = p; else break; }
    return target;
  };

  // 侧栏自动滚动至当前章节
  useEffect(() => {
    const chapterPage = findCurrentChapterPage(toc);
    if (typeof chapterPage === 'number') {
      const el = tocItemRefs.current.get(chapterPage);
      if (el) el.scrollIntoView({ block: 'center' });
    }
  }, [currentPage, toc]);

  const currentChapterPageVal = findCurrentChapterPage(toc);

  // 根据当前位置生成书签标题：优先使用章节标题，否则使用“第 X 页”
  const getBookmarkTitleForCurrent = (): string => {
    const chapterPage = currentChapterPageVal;
    if (typeof chapterPage === 'number') {
      const findTitle = (nodes: TocNode[]): string | undefined => {
        for (const n of nodes) {
          if (n.page === chapterPage) return n.title;
          if (n.children && n.children.length) {
            const t = findTitle(n.children);
            if (t) return t;
          }
        }
        return undefined;
      };
      const title = findTitle(toc);
      if (title) return title;
    }
    return `第 ${currentPage} 页`;
  };

  const addBookmark = async () => {
    if (!book) return;
    try {
      const title = getBookmarkTitleForCurrent();
      const created = await bookmarkService.addBookmark(book.id, currentPage, title);
      setBookmarks((prev) => [...prev, created].sort((a, b) => a.page_number - b.page_number));
      // 展示短暂气泡提示
      setBookmarkToastText('书签已添加');
      setBookmarkToastVisible(true);
      setTimeout(() => setBookmarkToastVisible(false), 1200);
    } catch (e) {
      console.error('添加书签失败', e);
      alert('添加书签失败');
    }
  };

  const deleteBookmark = async (id: number) => {
    try {
      await bookmarkService.deleteBookmark(id);
      setBookmarks((prev) => prev.filter((b) => b.id !== id));
    } catch (e) {
      console.error('删除书签失败', e);
      alert('删除书签失败');
    }
  };

  // 渲染目录树（组件内，可访问状态与方法）
  const renderTocTree = (nodes: TocNode[], level: number): React.ReactNode => {
    const indent = 10 + level * 14;
    return nodes.map((node, idx) => {
      const hasChildren = !!(node.children && node.children.length);
      const caret = hasChildren ? (node.expanded ? '▼' : '▶') : '•';
      const isActive = typeof currentChapterPageVal === 'number' && node.page === currentChapterPageVal;
      return (
        <div key={`${level}-${idx}`} style={{ marginLeft: indent }}>
          <div
            onClick={() => {
              if (hasChildren) {
                node.expanded = !node.expanded;
                setToc([...toc]);
              }
              if (typeof node.page === 'number') {
                goToPage(node.page);
                setTocOverlayOpen(false);
                setUiVisible(false);
              }
            }}
            ref={(el) => {
              if (el && typeof node.page === 'number') {
                tocItemRefs.current.set(node.page, el as HTMLDivElement);
              }
            }}
            style={{
              padding: '8px',
              borderRadius: '6px',
              cursor: (typeof node.page === 'number' || hasChildren) ? 'pointer' : 'default',
              backgroundColor: isActive ? '#333' : 'transparent'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = isActive ? '#333' : '#2a2a2a'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = isActive ? '#333' : 'transparent'; }}
          >
            <span style={{ marginRight: 12, fontSize: '11px', lineHeight: '1', color: '#ffffff', opacity: 0.7 }}>{caret}</span>
            <span style={{ fontSize: '13px', color: isActive ? '#d15158' : '#ffffff' }}>{node.title}</span>
            {typeof node.page === 'number' && (
              <span style={{ fontSize: '12px', opacity: 0.7, marginLeft: 6 }}>第 {node.page} 页</span>
            )}
          </div>
          {hasChildren && node.expanded && renderTocTree(node.children!, level + 1)}
        </div>
      );
    });
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontSize: '16px',
        color: '#666'
      }}>
        加载中...
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: '#2c2c2c'
    }}>
      {/* 主体区域：仅中间渲染区（目录改为蒙版弹层） */}
      <div style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden'
      }}>
        {/* 中间渲染区 */}
        <div
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            if (x < rect.width * 0.3) {
              prevPage();
            } else if (x > rect.width * 0.7) {
              nextPage();
            } else {
              setUiVisible((v) => !v);
            }
          }}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'auto',
            padding: '20px',
            position: 'relative'
          }}
        >
          {/* 顶部工具栏覆盖层：与底部控制栏一致的显示/隐藏逻辑 */}
          {(uiVisible || isSeeking || tocOverlayOpen) && (
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: '10px',
                left: '50%',
                transform: 'translateX(-50%)',
                width: '80%',
                backgroundColor: 'rgba(26,26,26,0.92)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                color: 'white',
                borderRadius: '10px',
                padding: '8px 12px',
                boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
                zIndex: 12
              }}
            >
              <button
                onClick={() => navigate('/')}
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '16px' }}
                title="返回"
              >
                {'<'}
              </button>
              <div style={{ fontSize: '16px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {book?.title}
              </div>
              <div style={{ width: '24px' }} />
            </div>
          )}
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
            }}
          />

          {/* 顶部页码气泡：贴紧顶部栏最左侧下方，顶部栏可见时下移 */}
          {(uiVisible || isSeeking) && (
            (() => {
              const offset = (uiVisible || isSeeking || tocOverlayOpen) ? 72 : 14;
              return (
                <div
                  style={{
                    position: 'absolute',
                    top: `${offset}px`,
                    left: '10%',
                    display: 'block',
                    pointerEvents: 'none',
                    zIndex: 11
                  }}
                >
                  <div
                    style={{
                      padding: '6px 12px',
                      borderRadius: '18px',
                      backgroundColor: 'rgba(0,0,0,0.75)',
                      color: '#fff',
                      fontSize: '12px',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.25)'
                    }}
                  >
                    {(isSeeking && seekPage !== null ? seekPage : currentPage)} / {totalPages}
                  </div>
                </div>
              );
            })()
          )}

          {/* 目录蒙版弹层：占据页面90%，点击外部收回 */}
          {tocOverlayOpen && (
            <div
              onClick={(e) => { e.stopPropagation(); setTocOverlayOpen(false); setUiVisible(false); }}
              style={{
                position: 'absolute',
                inset: 0,
                backgroundColor: 'rgba(0,0,0,0.6)',
                display: 'flex',
                alignItems: 'stretch',
                justifyContent: 'flex-start',
                zIndex: 20
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '90%',
                  height: '100%',
                  backgroundColor: '#1f1f1f',
                  color: '#fff',
                  borderRadius: '0 10px 10px 0',
                  overflowY: 'auto',
                  padding: '16px',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
                }}
                className="no-scrollbar"
              >
                {/* 顶部页签：目录 / 书签（图标与文字贴近） */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                  <button
                    onClick={() => setLeftTab('toc')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: leftTab === 'toc' ? '#d15158' : '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      padding: '4px 6px',
                      borderBottom: leftTab === 'toc' ? '2px solid #d15158' : '2px solid transparent'
                    }}
                  >
                    <span style={{ marginRight: '6px' }}>≡</span>
                    <span>目录</span>
                  </button>
                  <button
                    onClick={() => setLeftTab('bookmark')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: leftTab === 'bookmark' ? '#d15158' : '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      padding: '4px 6px',
                      borderBottom: leftTab === 'bookmark' ? '2px solid #d15158' : '2px solid transparent'
                    }}
                  >
                    <span style={{ marginRight: '6px' }}>🔖</span>
                    <span>书签</span>
                  </button>
                </div>
                {/* 内容区：目录或书签列表 */}
                {leftTab === 'toc' ? (
                  toc.length === 0 ? (
                    <div style={{ fontSize: '13px', opacity: 0.6 }}>无目录信息</div>
                  ) : (
                    <div>{renderTocTree(toc, 0)}</div>
                  )
                ) : (
                  bookmarks.length === 0 ? (
                    <div style={{ fontSize: '13px', opacity: 0.6, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>没有添加书签</div>
                  ) : (
                    <div>
                      {bookmarks.map((bm) => (
                        <div
                          key={bm.id}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer' }}
                          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                          onClick={() => { goToPage(bm.page_number); setTocOverlayOpen(false); setUiVisible(false); }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '13px', color: '#fff' }}>{bm.title}</span>
                            <span style={{ fontSize: '12px', opacity: 0.7 }}>第 {bm.page_number} 页</span>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); deleteBookmark(bm.id); }} style={{ background: 'none', border: 'none', color: '#ccc', cursor: 'pointer', fontSize: '12px' }} title="删除书签">✕</button>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {/* 覆盖式底部控制栏（绝对定位），不挤压内容；抽屉打开时隐藏 */}
          {(uiVisible || isSeeking) && !tocOverlayOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: '20px',
                width: 'min(720px, calc(100% - 32px))',
                backgroundColor: 'rgba(26,26,26,0.92)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                borderRadius: '10px',
                padding: '14px 18px',
                paddingBottom: 'calc(14px + env(safe-area-inset-bottom))',
                boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
                zIndex: 10
              }}
            >
              {/* 上方进度滑条 + 两端上一章/下一章文案 */}
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'clamp(10px, 1.6vw, 12px)', color: '#bbb', marginBottom: '8px' }}>
                  <span
                    onClick={() => {
                      const page = findCurrentChapterPage(toc);
                      if (typeof page === 'number' && page < currentPage) {
                        goToPage(page);
                      } else {
                        prevPage();
                      }
                    }}
                    style={{ cursor: currentPage <= 1 ? 'default' : 'pointer', opacity: currentPage <= 1 ? 0.5 : 1 }}
                  >上一章</span>
                  <span
                    onClick={() => {
                      const pages: number[] = [];
                      const collect = (ns: TocNode[]) => {
                        for (const n of ns) {
                          if (typeof n.page === 'number') pages.push(n.page);
                          if (n.children && n.children.length) collect(n.children);
                        }
                      };
                      collect(toc);
                      pages.sort((a, b) => a - b);
                      const target = pages.find((p) => p > currentPage);
                      if (typeof target === 'number') {
                        goToPage(target);
                      } else {
                        nextPage();
                      }
                    }}
                    style={{ cursor: currentPage >= totalPages ? 'default' : 'pointer', opacity: currentPage >= totalPages ? 0.5 : 1 }}
                  >下一章</span>
                </div>
                {(() => {
                  const sliderVal = isSeeking && seekPage !== null ? seekPage : currentPage;
                  const pct = Math.max(0, Math.min(100, Math.round((sliderVal / Math.max(1, totalPages)) * 100)));
                  const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #3a3a3a ${pct}%, #3a3a3a 100%)`;
                  return (
                    <input
                      className="reader-range"
                      type="range"
                      min={1}
                      max={totalPages}
                      value={sliderVal}
                      onMouseDown={(e) => { e.stopPropagation(); setIsSeeking(true); }}
                      onTouchStart={(e) => { e.stopPropagation(); setIsSeeking(true); }}
                      onInput={(e) => {
                        const v = Number((e.target as HTMLInputElement).value);
                        setSeekPage(v);
                      }}
                      onMouseUp={async (e) => {
                        e.stopPropagation();
                        const v = Number((e.target as HTMLInputElement).value);
                        setIsSeeking(false);
                        setSeekPage(null);
                        await goToPage(v);
                      }}
                      onTouchEnd={async (e) => {
                        e.stopPropagation();
                        const v = Number((e.target as HTMLInputElement).value);
                        setIsSeeking(false);
                        setSeekPage(null);
                        await goToPage(v);
                      }}
                      style={{ width: '100%', height: '6px', borderRadius: '6px', background: track, outline: 'none' }}
                    />
                  );
                })()}
              </div>
              {/* 下方图标操作区：5等分网格，窄屏也不拥挤 */}
              <div style={{ marginTop: '14px', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', alignItems: 'center', justifyItems: 'center', width: '100%', gap: '8px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <button onClick={() => setTocOverlayOpen(true)} style={{ background: 'none', border: 'none', color: tocOverlayOpen ? '#d15158' : '#fff', cursor: 'pointer', fontSize: 'clamp(16px, 3.2vw, 18px)' }} title="目录">≡</button>
                  <div style={{ fontSize: 'clamp(10px, 1.6vw, 12px)', color: tocOverlayOpen ? '#d15158' : '#ccc', marginTop: '6px' }}>目录</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <button style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 'clamp(16px, 3.2vw, 18px)' }} title="阅读方式">▉▉</button>
                  <div style={{ fontSize: 'clamp(10px, 1.6vw, 12px)', color: '#ccc', marginTop: '6px' }}>阅读方式</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <button style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 'clamp(16px, 3.2vw, 18px)' }} title="自动滚动">☰</button>
                  <div style={{ fontSize: 'clamp(10px, 1.6vw, 12px)', color: '#ccc', marginTop: '6px' }}>自动滚动</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <button onClick={addBookmark} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 'clamp(16px, 3.2vw, 18px)' }} title="书签">🔖</button>
                  <div style={{ fontSize: 'clamp(10px, 1.6vw, 12px)', color: '#ccc', marginTop: '6px' }}>书签</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <button onClick={() => { setLeftTab('bookmark'); setTocOverlayOpen(true); }} style={{ background: 'none', border: 'none', color: leftTab === 'bookmark' && tocOverlayOpen ? '#d15158' : '#fff', cursor: 'pointer', fontSize: 'clamp(16px, 3.2vw, 18px)' }} title="更多">…</button>
                  <div style={{ fontSize: 'clamp(10px, 1.6vw, 12px)', color: leftTab === 'bookmark' && tocOverlayOpen ? '#d15158' : '#ccc', marginTop: '6px' }}>更多</div>
                </div>
              </div>

              {/* 书签提示气泡：覆盖显示，不影响布局与交互 */}
              {bookmarkToastVisible && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '8px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    padding: '6px 12px',
                    borderRadius: '16px',
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    color: '#fff',
                    fontSize: '12px',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                    pointerEvents: 'none'
                  }}
                >
                  {bookmarkToastText}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
};
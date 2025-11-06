import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { IBook } from '../types';
// @ts-ignore
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { bookService } from '../services';

export const Reader: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [book, setBook] = useState<IBook | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pdf, setPdf] = useState<any>(null);
  type TocNode = { title: string; page?: number; children?: TocNode[]; expanded?: boolean };
  const [toc, setToc] = useState<TocNode[]>([]);
  const tocItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // UI 可见与进度滑动状态
  const [uiVisible, setUiVisible] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPage, setSeekPage] = useState<number | null>(null);

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
      {/* 顶部工具栏：仅显示返回与书名 */}
      <div style={{
        height: '60px',
        backgroundColor: '#1a1a1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        color: 'white'
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none',
            border: 'none',
            color: 'white',
            cursor: 'pointer',
            fontSize: '16px'
          }}
        >
          ← 返回
        </button>
        <div style={{ fontSize: '18px', fontWeight: '500' }}>
          {book?.title}
        </div>
        <div style={{ width: '80px' }} />
      </div>

      {/* 主体区域：左侧目录 + 中间渲染区 */}
      <div style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden'
      }}>
        {/* 左侧目录 */}
        <div style={{
          width: '280px',
          backgroundColor: '#1f1f1f',
          color: 'white',
          overflowY: 'auto',
          padding: '12px 8px',
          borderRight: '1px solid #333'
        }}>
          <div style={{ fontSize: '14px', marginBottom: '8px', opacity: 0.8 }}>目录</div>
          {toc.length === 0 ? (
            <div style={{ fontSize: '13px', opacity: 0.6 }}>无目录信息</div>
          ) : (
            <div>{renderTocTree(toc, 0)}</div>
          )}
        </div>
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
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
            }}
          />

          {/* 顶部左侧页码气泡：中央点击显示时常驻；拖动时显示预览 */}
          {(uiVisible || isSeeking) && (
            <div
              style={{
                position: 'absolute',
                top: '10px',
                left: '10px',
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
          )}
        </div>
      </div>

      {/* 底部控制栏：中央点击时显示；滑动时始终显示进度条 */}
      {(uiVisible || isSeeking) && (
        <div
          style={{
            height: '100px',
            backgroundColor: '#1a1a1a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '20px',
            color: 'white',
            position: 'relative'
          }}
        >
          <button
            onClick={() => {
              const page = findCurrentChapterPage(toc);
              if (typeof page === 'number' && page < currentPage) {
                goToPage(page);
              } else {
                prevPage(); // 目录缺失或无更早章节时回退到按页
              }
            }}
            disabled={currentPage <= 1}
            style={{
              padding: '10px 16px',
              backgroundColor: currentPage <= 1 ? '#555' : '#d15158',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
              fontSize: '14px'
            }}
          >
            上一章
          </button>

          {/* 进度滑条 */}
          <div style={{ width: '56%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', margin: '0 40px' }}>
            <input
              type="range"
              min={1}
              max={totalPages}
              value={isSeeking && seekPage !== null ? seekPage : currentPage}
              onMouseDown={() => setIsSeeking(true)}
              onTouchStart={() => setIsSeeking(true)}
              onInput={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                setSeekPage(v);
              }}
              onMouseUp={async (e) => {
                const v = Number((e.target as HTMLInputElement).value);
                setIsSeeking(false);
                setSeekPage(null);
                await goToPage(v);
              }}
              onTouchEnd={async (e) => {
                const v = Number((e.target as HTMLInputElement).value);
                setIsSeeking(false);
                setSeekPage(null);
                await goToPage(v);
              }}
              style={{ width: '100%' }}
            />
            {/* 底部不再显示页码说明，页码在顶部左侧预览气泡里显示 */}
          </div>

          <button
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
                nextPage(); // 目录缺失或无更后章节时回退到按页
              }
            }}
            disabled={currentPage >= totalPages}
            style={{
              padding: '10px 16px',
              backgroundColor: currentPage >= totalPages ? '#555' : '#d15158',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
              fontSize: '14px'
            }}
          >
            下一章
          </button>
        </div>
      )}
    </div>
  );
};
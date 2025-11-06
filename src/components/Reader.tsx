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
  const [toc, setToc] = useState<Array<{ title: string; page?: number }>>([]);
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

      // 加载目录（Outline）——支持字符串和数组 dest，递归扁平化但保留不可跳转项
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
        const flatten = async (
          nodes: any[] | undefined,
          acc: Array<{ title: string; page?: number }>
        ) => {
          if (!nodes || !Array.isArray(nodes)) return acc;
          for (const n of nodes) {
            const title = n?.title || '无标题';
            const page = await resolvePage(n);
            acc.push({ title, page });
            const children = n?.items || n?.children;
            if (children && Array.isArray(children)) await flatten(children, acc);
          }
          return acc;
        };
        const flat = await flatten(outline as any[], []);
        setToc(flat || []);
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
            toc.map((item, idx) => (
              <div
                key={idx}
                onClick={() => item.page && goToPage(item.page)}
                style={{
                  padding: '8px',
                  borderRadius: '6px',
                  cursor: item.page ? 'pointer' : 'default',
                  backgroundColor: 'transparent'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#2a2a2a';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <div style={{ fontSize: '13px' }}>{item.title}</div>
                {item.page && (
                  <div style={{ fontSize: '12px', opacity: 0.7 }}>第 {item.page} 页</div>
                )}
              </div>
            ))
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
              // 跳到上一章：取 < currentPage 的最大章节页
              const pages = toc
                .map(t => t.page)
                .filter((p): p is number => typeof p === 'number')
                .sort((a, b) => a - b);
              let target = pages[0];
              for (const p of pages) { if (p < currentPage) target = p; else break; }
              if (typeof target === 'number' && target < currentPage) goToPage(target);
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
              // 跳到下一章：取 > currentPage 的最小章节页
              const pages = toc
                .map(t => t.page)
                .filter((p): p is number => typeof p === 'number')
                .sort((a, b) => a - b);
              const target = pages.find(p => p > currentPage);
              if (typeof target === 'number') goToPage(target);
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
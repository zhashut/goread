import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { IBook } from '../types';
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
      const loadedPdf = await pdfjs.getDocument({ data: fileData }).promise;
      setPdf(loadedPdf);

      // 渲染当前页面
      await renderPage(targetBook.current_page, loadedPdf);
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
      {/* 顶部工具栏 */}
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
        <div style={{ fontSize: '14px' }}>
          {currentPage} / {totalPages}
        </div>
      </div>

      {/* PDF渲染区域 */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
        padding: '20px'
      }}>
        <canvas
          ref={canvasRef}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
          }}
        />
      </div>

      {/* 底部控制栏 */}
      <div style={{
        height: '80px',
        backgroundColor: '#1a1a1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '20px',
        color: 'white'
      }}>
        <button
          onClick={prevPage}
          disabled={currentPage <= 1}
          style={{
            padding: '10px 20px',
            backgroundColor: currentPage <= 1 ? '#555' : '#d15158',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
            fontSize: '14px'
          }}
        >
          上一页
        </button>
        
        <div style={{ fontSize: '16px', minWidth: '100px', textAlign: 'center' }}>
          第 {currentPage} 页，共 {totalPages} 页
        </div>
        
        <button
          onClick={nextPage}
          disabled={currentPage >= totalPages}
          style={{
            padding: '10px 20px',
            backgroundColor: currentPage >= totalPages ? '#555' : '#d15158',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
            fontSize: '14px'
          }}
        >
          下一页
        </button>
      </div>
    </div>
  );
};
import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import * as pdfjs from "pdfjs-dist";
import { IBook } from "../types";
import { bookService } from "../services";

interface BookCardProps {
  book: IBook;
  onClick: () => void;
}

const BookCard: React.FC<BookCardProps> = ({ book, onClick }) => {
  return (
    <div
      className="book-card"
      onClick={onClick}
      style={{
        width: "160px",
        height: "240px",
        margin: "10px",
        borderRadius: "8px",
        overflow: "hidden",
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
        cursor: "pointer",
        transition: "transform 0.2s ease",
        backgroundColor: "#fff",
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
          height: "200px",
          backgroundColor: "#f5f5f5",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
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
      <div
        style={{
          padding: "12px",
          height: "40px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <div
          style={{
            fontSize: "14px",
            fontWeight: "500",
            color: "#333",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            width: "100%",
          }}
        >
          {book.title}
        </div>
      </div>
    </div>
  );
};

export const Bookshelf: React.FC = () => {
  const [books, setBooks] = useState<IBook[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    loadBooks();
  }, []);

  const loadBooks = async () => {
    try {
      setLoading(true);
      // 初始化数据库
      await bookService.initDatabase();
      // 获取所有书籍
      const allBooks = await bookService.getAllBooks();
      setBooks(allBooks);
    } catch (error) {
      console.error("Failed to load books:", error);
      // 如果数据库未初始化，可能是第一次运行，继续显示空状态
      setBooks([]);
    } finally {
      setLoading(false);
    }
  };

  const handleBookClick = (book: IBook) => {
    navigate(`/reader/${book.id}`);
  };

  const handleImportBook = async () => {
    try {
      // 动态导入Tauri插件
      const [{ open }, { readFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs")
      ]);

      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "PDF",
            extensions: ["pdf"],
          },
        ],
      });

      if (selected && !Array.isArray(selected)) {
        const filePath = typeof selected === 'string' ? selected : (selected as any).path;
        const fileName = typeof selected === 'string' ? selected.split('\\').pop()?.split('/').pop() : (selected as any).name;
        
        const fileData = await readFile(filePath);

        // 使用PDF.js解析PDF信息
        const pdfjs = await import("pdfjs-dist");
        const pdf = await pdfjs.getDocument({ data: fileData }).promise;

        // 生成封面（第一页）
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.5 });

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise;

        const coverImage = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];

        // 添加书籍到数据库
        const title = fileName?.replace(/\.pdf$/i, "") || 'Unknown';
        await bookService.addBook(
          filePath,
          title,
          coverImage,
          pdf.numPages
        );

        // 重新加载书籍列表
        await loadBooks();
        
        alert(`成功导入书籍: ${title}`);
      }
    } catch (error) {
      console.error("Failed to import book:", error);
      alert("导入书籍失败，请重试");
    }
  };

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
        padding: "20px",
        minHeight: "100vh",
        backgroundColor: "#fafafa",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "30px",
        }}
      >
        <h1
          style={{
            fontSize: "24px",
            fontWeight: "600",
            color: "#333",
            margin: 0,
          }}
        >
          我的书架
        </h1>
        <button
          onClick={handleImportBook}
          style={{
            padding: "10px 20px",
            backgroundColor: "#d15158",
            color: "white",
            border: "none",
            borderRadius: "6px",
            fontSize: "14px",
            fontWeight: "500",
            cursor: "pointer",
            transition: "background-color 0.2s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "#b8474e";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "#d15158";
          }}
        >
          导入书籍
        </button>
      </div>

      {books.length === 0 ? (
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
          <div style={{ fontSize: "18px", marginBottom: "10px" }}>暂无书籍</div>
          <div style={{ fontSize: "14px" }}>
            点击上方按钮导入您的第一本PDF书籍
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          {books.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              onClick={() => handleBookClick(book)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

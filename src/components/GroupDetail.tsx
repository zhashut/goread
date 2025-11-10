import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { IBook, IGroup } from '../types';
import { groupService } from '../services';

const BookCardMini: React.FC<{ book: IBook; onClick: () => void }>=({ book, onClick }) => {
  const progress = book.total_pages > 0 ? Math.min(100, Math.round((book.current_page / book.total_pages) * 1000) / 10) : 0;
  return (
    <div className="book-card" onClick={onClick} style={{ width: '160px', margin: '12px', cursor: 'pointer', transition: 'transform 0.2s ease', backgroundColor: 'transparent' }}
      onMouseEnter={(e)=>{ e.currentTarget.style.transform = 'translateY(-4px)'; }}
      onMouseLeave={(e)=>{ e.currentTarget.style.transform = 'translateY(0)'; }}>
      <div style={{ width: '100%', height: '230px', backgroundColor: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', border: '1px solid #e5e5e5', borderRadius: '4px', boxShadow: '0 2px 6px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
        {book.cover_image ? (
          <img src={`data:image/jpeg;base64,${book.cover_image}`} alt={book.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ color: '#999', fontSize: '14px', textAlign: 'center' }}>暂无封面</div>
        )}
      </div>
      <div style={{ marginTop: '8px' }}>
        <div style={{ fontSize: '14px', fontWeight: 500, color: '#333', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any, overflow: 'hidden', textAlign: 'left' }}>{book.title}</div>
        <div style={{ marginTop: '4px', fontSize: '12px', color: '#888', textAlign: 'left' }}>已读 {progress}%</div>
      </div>
    </div>
  );
};

export const GroupDetail: React.FC = () => {
  const navigate = useNavigate();
  const { groupId } = useParams();
  const id = Number(groupId);
  const [group, setGroup] = useState<IGroup | null>(null);
  const [books, setBooks] = useState<IBook[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const allGroups = await groupService.getAllGroups();
        const g = (allGroups || []).find(x => x.id === id) || null;
        setGroup(g);
        const list = await groupService.getBooksByGroup(id);
        setBooks(list || []);
      } catch (e) {
        setBooks([]);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [id]);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#fafafa', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: '#333', fontSize: '18px', cursor: 'pointer', marginRight: '12px' }} title="返回">{'<'}</button>
        <div style={{ fontSize: '18px', fontWeight: 600, color: '#333' }}>{group?.name || '分组'}</div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh', color: '#666' }}>加载中…</div>
      ) : books.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh', color: '#999' }}>该分组暂无书籍</div>
      ) : (
        <div style={{ padding: '12px 8px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {books.map(b => (
            <BookCardMini key={b.id} book={b} onClick={()=> navigate(`/reader/${b.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
};
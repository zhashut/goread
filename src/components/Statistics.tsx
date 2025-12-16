import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAppNav } from '../router/useAppNav';
import { statsService } from '../services';
import { IStatsSummary, IDailyStats, IRangeStats, IBookReadingStats } from '../types';
import { HtmlCover } from './covers/HtmlCover';
import { MarkdownCover } from './covers/MarkdownCover';
import { getSafeAreaInsets } from '../utils/layout';

// 根据书名判断书籍格式
const getBookFormat = (title: string): 'html' | 'markdown' | 'other' => {
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.endsWith('.html') || lowerTitle.endsWith('.htm')) return 'html';
  if (lowerTitle.endsWith('.md') || lowerTitle.endsWith('.markdown')) return 'markdown';
  return 'other';
};

// 时间维度类型
type RangeType = 'day' | 'week' | 'month' | 'year';

// 热力图范围（天数）
type HeatmapRange = 90 | 180 | 365;

// 工具函数：格式化秒数为可读时间
const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
  const hours = seconds / 3600;
  if (hours < 10) return `${hours.toFixed(1)}小时`;
  return `${Math.floor(hours)}小时`;
};

// 工具函数：格式化秒数为简短形式
const formatShortDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = seconds / 3600;
  return `${hours.toFixed(1)}h`;
};


// 格式化日期显示
const formatDateRange = (startDate: string, endDate: string, rangeType: RangeType): string => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  switch (rangeType) {
    case 'day':
      return `${start.getMonth() + 1}月${start.getDate()}日`;
    case 'week':
      return `${start.getMonth() + 1}月${start.getDate()}日 - ${end.getMonth() + 1}月${end.getDate()}日`;
    case 'month':
      return `${start.getFullYear()}年${start.getMonth() + 1}月`;
    case 'year':
      return `${start.getFullYear()}年`;
    default:
      return '';
  }
};

// 获取范围标题
const getRangeTitle = (rangeType: RangeType): string => {
  const titles: Record<RangeType, string> = {
    day: '今日时长',
    week: '本周时长',
    month: '本月时长',
    year: '年度时长'
  };
  return titles[rangeType];
};

// 获取当前时间段索引（用于默认选中）
const getCurrentBarIndex = (rangeType: RangeType): number => {
  const now = new Date();
  switch (rangeType) {
    case 'day':
      // 0-6点=0, 6-12点=1, 12-18点=2, 18-24点=3
      return Math.floor(now.getHours() / 6);
    case 'week':
      // 周一=0, ..., 周日=6
      const day = now.getDay();
      return day === 0 ? 6 : day - 1;
    case 'month':
      // 计算当前是第几周 (0-based)
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const dayOfMonth = now.getDate();
      const firstDayOfWeek = firstDay.getDay() || 7;
      return Math.floor((dayOfMonth + firstDayOfWeek - 2) / 7);
    case 'year':
      // 当前月份 (0-11)
      return now.getMonth();
    default:
      return 0;
  }
};

// 格式化书籍的阅读时间显示（根据 rangeType）
// last_read 是时间戳字符串（秒）
const formatBookTime = (timestampStr: string, rangeType: RangeType): string => {
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || timestamp === 0) return '-';
  
  // 将秒时间戳转换为毫秒
  const date = new Date(timestamp * 1000);
  
  switch (rangeType) {
    case 'day':
      // 日视图：显示具体小时分钟 如 "12:30"
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    case 'week':
      // 周视图：显示周几
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return weekdays[date.getDay()];
    case 'month':
      // 月视图：显示几月几号
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    case 'year':
      // 年视图：显示完整日期
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    default:
      return '-';
  }
};

// 计算热力图颜色等级
const getHeatLevel = (seconds: number): number => {
  if (seconds === 0) return 0;
  if (seconds < 900) return 1;   // < 15分钟
  if (seconds < 1800) return 2;  // < 30分钟
  if (seconds < 3600) return 3;  // < 1小时
  return 4;                       // >= 1小时
};

// 样式常量
const COLORS = {
  primary: '#e53935',
  primaryLight: '#ffcdd2',
  primaryBg: '#ffebee',
  bgColor: '#f7f8fa',
  cardBg: '#ffffff',
  textMain: '#333333',
  textSub: '#999999',
  borderColor: '#eeeeee',
  heatLevels: ['#ebedf0', '#ffcdd2', '#ef9a9a', '#e57373', '#e53935']
};

export const Statistics: React.FC = () => {
  const nav = useAppNav();
  
  // 状态
  const [summary, setSummary] = useState<IStatsSummary>({ total_time_seconds: 0, streak_days: 0, finished_books: 0 });
  const [rangeType, setRangeType] = useState<RangeType>('day');
  const [rangeOffset, setRangeOffset] = useState(0);
  const [rangeStats, setRangeStats] = useState<IRangeStats | null>(null);
  const [dayHourStats, setDayHourStats] = useState<number[]>([0, 0, 0, 0]);
  const [books, setBooks] = useState<IBookReadingStats[]>([]);
  const [heatmapRange, setHeatmapRange] = useState<HeatmapRange>(90);
  const [dailyStats, setDailyStats] = useState<IDailyStats[]>([]);
  const [selectedBarIndex, setSelectedBarIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  
  const toastTimerRef = useRef<number>(0);

  // 显示 Toast
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 2000);
  }, []);

  // 加载概览数据
  const loadSummary = useCallback(async () => {
    try {
      const data = await statsService.getStatsSummary();
      setSummary(data);
    } catch (e) {
      console.error('Failed to load stats summary:', e);
    }
  }, []);

  // 加载范围统计数据
  const loadRangeStats = useCallback(async () => {
    try {
      if (rangeType === 'day') {
        // 日视图使用特殊的按小时统计
        const today = new Date();
        today.setDate(today.getDate() - rangeOffset);
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const hourStats = await statsService.getDayStatsByHour(dateStr);
        setDayHourStats(hourStats);
        
        // 获取该日期的书籍列表
        const booksData = await statsService.getBooksByDateRange(dateStr, dateStr);
        setBooks(booksData);
        
        // 获取前一天的统计数据用于计算环比
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        const yesterdayHourStats = await statsService.getDayStatsByHour(yesterdayStr);
        const previousTotalSeconds = yesterdayHourStats.reduce((a, b) => a + b, 0);
        
        // 构造 rangeStats 用于显示
        setRangeStats({
          labels: ['0-6点', '6-12点', '12-18点', '18-24点'],
          values: hourStats,
          start_date: dateStr,
          end_date: dateStr,
          total_seconds: hourStats.reduce((a, b) => a + b, 0),
          previous_total_seconds: previousTotalSeconds
        });
      } else {
        const data = await statsService.getReadingStatsByRange(rangeType, rangeOffset);
        setRangeStats(data);
        
        // 加载该范围内的书籍
        const booksData = await statsService.getBooksByDateRange(data.start_date, data.end_date);
        setBooks(booksData);
      }
    } catch (e) {
      console.error('Failed to load range stats:', e);
    }
  }, [rangeType, rangeOffset]);

  // 加载热力图数据
  const loadHeatmapData = useCallback(async () => {
    try {
      const data = await statsService.getDailyStats(heatmapRange);
      setDailyStats(data);
    } catch (e) {
      console.error('Failed to load heatmap data:', e);
    }
  }, [heatmapRange]);

  // 初始化加载
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([loadSummary(), loadRangeStats(), loadHeatmapData()]);
      setLoading(false);
    };
    init();
  }, [loadSummary, loadRangeStats, loadHeatmapData]);

  // 切换范围类型时重新加载，并设置默认选中的柱子
  useEffect(() => {
    setRangeOffset(0);
    // 默认选中当前时间段
    setSelectedBarIndex(getCurrentBarIndex(rangeType));
  }, [rangeType]);

  // 初始化时设置默认选中
  useEffect(() => {
    if (selectedBarIndex === null) {
      setSelectedBarIndex(getCurrentBarIndex(rangeType));
    }
  }, []);

  // rangeOffset 变化时重新加载
  useEffect(() => {
    loadRangeStats();
  }, [rangeOffset, loadRangeStats]);

  // 热力图范围变化时重新加载
  useEffect(() => {
    loadHeatmapData();
  }, [heatmapRange, loadHeatmapData]);

  // 生成热力图数据
  const generateHeatmapData = useCallback(() => {
    const days: { date: string; seconds: number }[] = [];
    const today = new Date();
    const statsMap = new Map(dailyStats.map(s => [s.date, s.total_seconds]));

    for (let i = heatmapRange - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      days.push({
        date: dateStr,
        seconds: statsMap.get(dateStr) || 0
      });
    }

    return days;
  }, [dailyStats, heatmapRange]);

  // 热力图点击处理
  const handleHeatboxClick = useCallback((date: string, seconds: number) => {
    const d = new Date(date);
    const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`;
    if (seconds > 0) {
      showToast(`${dateStr} 阅读了 ${formatDuration(seconds)}`);
    } else {
      showToast(`${dateStr} 无阅读记录`);
    }
  }, [showToast]);

  // 计算环比
  const getTrendText = (): { text: string; isUp: boolean } => {
    if (!rangeStats || rangeStats.previous_total_seconds === 0) {
      return { text: '-', isUp: true };
    }
    const diff = rangeStats.total_seconds - rangeStats.previous_total_seconds;
    const percent = Math.abs(Math.round((diff / rangeStats.previous_total_seconds) * 100));
    if (diff >= 0) {
      return { text: `↑ ${percent}%`, isUp: true };
    }
    return { text: `↓ ${percent}%`, isUp: false };
  };

  // 计算平均值
  const getAverage = (): string => {
    if (!rangeStats) return '-';
    const count = rangeStats.labels.length;
    const avg = rangeStats.total_seconds / count;
    return formatDuration(Math.round(avg));
  };

  const heatmapData = generateHeatmapData();
  const weeksCount = Math.ceil(heatmapRange / 7);
  const trend = getTrendText();
  const chartValues = rangeType === 'day' ? dayHourStats : (rangeStats?.values || []);
  const maxChartValue = Math.max(...chartValues, 1);

  return (
    <>
      <style>{`
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
      <div style={{ 
        backgroundColor: COLORS.bgColor, 
        minHeight: '100vh',
        height: '100vh',
        paddingBottom: `calc(${getSafeAreaInsets().bottom} + 40px)`,
        overflowY: 'auto',
        overflowX: 'hidden',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        WebkitOverflowScrolling: 'touch'
      } as React.CSSProperties}
        className="hide-scrollbar"
      >
      {/* 顶部导航栏 */}
      <div style={{
        background: COLORS.cardBg,
        padding: `calc(${getSafeAreaInsets().top} + 16px) 16px 16px 16px`,
        display: 'flex',
        alignItems: 'center',
        fontSize: 18,
        fontWeight: 600,
        position: 'sticky',
        top: 0,
        zIndex: 100,
        boxShadow: '0 1px 0 rgba(0,0,0,0.05)'
      }}>
        <button
          onClick={() => nav.goBack()}
          style={{
            background: 'transparent',
            border: 'none',
            color: COLORS.textMain,
            fontSize: 25,
            cursor: 'pointer',
            marginRight: 20,
            padding: 0,
            boxShadow: 'none',
            borderRadius: 0,
            outline: 'none',
            WebkitAppearance: 'none',
            MozAppearance: 'none',
            appearance: 'none',
          }}
        >
          {'<'}
        </button>
        <span style={{ fontSize: 18, fontWeight: 600, color: COLORS.textMain }}>阅读统计</span>
      </div>

      {/* 核心数据概览卡片 */}
      <div style={{
        background: COLORS.cardBg,
        margin: 16,
        padding: '24px 16px',
        borderRadius: 16,
        boxShadow: '0 4px 12px rgba(0,0,0,0.02)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <h3 style={{ fontSize: 26, color: COLORS.textMain, marginBottom: 4, fontWeight: 700 }}>
            {Math.floor(summary.total_time_seconds / 3600)}
            <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 2, color: COLORS.textSub }}>h</span>
          </h3>
          <p style={{ fontSize: 12, color: COLORS.textSub }}>总时长</p>
        </div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <h3 style={{ fontSize: 26, color: COLORS.textMain, marginBottom: 4, fontWeight: 700 }}>
            {summary.streak_days}
            <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 2, color: COLORS.textSub }}>天</span>
          </h3>
          <p style={{ fontSize: 12, color: COLORS.textSub }}>连续阅读</p>
        </div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <h3 style={{ fontSize: 26, color: COLORS.textMain, marginBottom: 4, fontWeight: 700 }}>
            {summary.finished_books}
            <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 2, color: COLORS.textSub }}>本</span>
          </h3>
          <p style={{ fontSize: 12, color: COLORS.textSub }}>已读完</p>
        </div>
      </div>

      {/* 主控 Tab */}
      <div style={{
        display: 'flex',
        background: '#e0e0e0',
        margin: '0 16px 20px',
        padding: 4,
        borderRadius: 10
      }}>
        {(['day', 'week', 'month', 'year'] as RangeType[]).map((type) => (
          <div
            key={type}
            onClick={() => setRangeType(type)}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '8px 0',
              fontSize: 13,
              color: rangeType === type ? COLORS.textMain : '#666',
              cursor: 'pointer',
              borderRadius: 8,
              transition: 'all 0.25s',
              fontWeight: rangeType === type ? 700 : 500,
              background: rangeType === type ? COLORS.cardBg : 'transparent',
              boxShadow: rangeType === type ? '0 2px 4px rgba(0,0,0,0.1)' : 'none',
              transform: rangeType === type ? 'scale(1.02)' : 'none'
            }}
          >
            {{ day: '日', week: '周', month: '月', year: '年' }[type]}
          </div>
        ))}
      </div>

      {/* 图表卡片 */}
      <div style={{
        background: COLORS.cardBg,
        margin: '0 16px 20px',
        padding: '20px 16px',
        borderRadius: 16,
        boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
        position: 'relative',
        minHeight: 100
      }}>
        {loading && (
          <div style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(255,255,255,0.8)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 16
          }}>
            <div style={{
              width: 24, height: 24,
              border: '3px solid #eee',
              borderTopColor: COLORS.primary,
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite'
            }} />
          </div>
        )}
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textMain, display: 'flex', alignItems: 'center' }}>
              {getRangeTitle(rangeType)}
            </div>
            <div style={{ fontSize: 12, color: COLORS.textSub, marginTop: 4 }}>
              {rangeStats ? formatDateRange(rangeStats.start_date, rangeStats.end_date, rangeType) : ''}
            </div>
          </div>
        </div>

        {/* 柱状图 */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          height: 180,
          paddingBottom: 5,
          borderBottom: '1px dashed #eee'
        }}>
          {(rangeStats?.labels || []).map((label, index) => {
            const value = chartValues[index] || 0;
            const heightPercent = maxChartValue > 0 ? (value / maxChartValue) * 100 : 0;
            const isSelected = selectedBarIndex === index;
            
            return (
              <div
                key={label}
                onClick={() => setSelectedBarIndex(isSelected ? null : index)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  flex: 1,
                  height: '100%',
                  position: 'relative',
                  cursor: 'pointer'
                }}
              >
                <span style={{
                  fontSize: 10,
                  color: isSelected ? COLORS.primary : COLORS.textSub,
                  marginBottom: 6,
                  fontWeight: isSelected ? 700 : 500,
                  opacity: isSelected ? 1 : 0,
                  transition: 'all 0.2s',
                  transform: isSelected ? 'translateY(0)' : 'translateY(5px)'
                }}>
                  {formatShortDuration(value)}
                </span>
                <div style={{
                  width: isSelected ? 12 : 10,
                  borderRadius: 6,
                  backgroundColor: isSelected ? COLORS.primary : COLORS.primaryLight,
                  transition: 'height 0.6s ease, background-color 0.2s, width 0.2s',
                  height: `${Math.max(heightPercent, value > 0 ? 2 : 0)}%`,
                  boxShadow: isSelected ? '0 4px 10px rgba(229, 57, 53, 0.3)' : 'none'
                }} />
                <span style={{ marginTop: 12, fontSize: 10, color: COLORS.textSub }}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        {/* 统计摘要 */}
        <div style={{ display: 'flex', gap: 20, marginTop: 20, paddingTop: 15, borderTop: '1px solid #f9f9f9' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.textMain }}>
              {formatDuration(rangeStats?.total_seconds || 0)}
            </span>
            <span style={{ fontSize: 10, color: COLORS.textSub, marginTop: 2 }}>总计</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ 
              fontSize: 15, 
              fontWeight: 700, 
              color: trend.isUp ? '#4caf50' : '#f44336' 
            }}>
              {trend.text}
            </span>
            <span style={{ fontSize: 10, color: COLORS.textSub, marginTop: 2 }}>环比</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.textMain }}>
              {getAverage()}
            </span>
            <span style={{ fontSize: 10, color: COLORS.textSub, marginTop: 2 }}>平均</span>
          </div>
        </div>
      </div>

      {/* 书籍列表卡片 */}
      <div style={{
        background: COLORS.cardBg,
        margin: '0 16px 20px',
        padding: '20px 16px',
        borderRadius: 16,
        boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
        position: 'relative'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textMain }}>该时段阅读</div>
        </div>
        
        <div style={{
          maxHeight: 380,
          overflowY: 'auto',
          scrollbarWidth: 'none'
        }} className="hide-scrollbar">
          {books.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 20, color: COLORS.textSub, fontSize: 12 }}>
              暂无阅读记录
            </div>
          ) : (
            books.map((book) => (
              <div
                key={book.book_id}
                style={{
                  display: 'flex',
                  padding: '16px 0',
                  borderBottom: `1px solid ${COLORS.borderColor}`
                }}
              >
                <div style={{
                  width: 44,
                  height: 62,
                  backgroundColor: '#eee',
                  borderRadius: 4,
                  marginRight: 14,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  color: '#999',
                  flexShrink: 0,
                  border: '1px solid #e0e0e0'
                }}>
                  {(() => {
                    const format = getBookFormat(book.title);
                    // HTML 格式使用 HtmlCover
                    if (format === 'html') {
                      return <HtmlCover style={{ width: '100%', height: '100%' }} />;
                    }
                    // Markdown 格式使用 MarkdownCover
                    if (format === 'markdown') {
                      return <MarkdownCover style={{ width: '100%', height: '100%' }} />;
                    }
                    // 有封面图片的书籍
                    if (book.cover_image && book.cover_image.trim() !== '') {
                      return (
                        <img 
                          src={book.cover_image.startsWith('data:') ? book.cover_image : `data:image/jpeg;base64,${book.cover_image}`} 
                          alt={book.title} 
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const parent = target.parentElement;
                            if (parent) {
                              parent.style.background = '#666';
                              parent.style.color = '#fff';
                              parent.innerText = book.title.substring(0, 2);
                            }
                          }}
                        />
                      );
                    }
                    // 无封面时显示书名缩写
                    return (
                      <span style={{ 
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12, 
                        fontWeight: 600, 
                        color: '#fff',
                        background: '#666',
                        textAlign: 'center',
                        padding: 4
                      }}>
                        {book.title.substring(0, 2)}
                      </span>
                    );
                  })()}
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: COLORS.textMain }}>
                    {book.title}
                  </div>
                  <div style={{ 
                    fontSize: 12, 
                    color: COLORS.textSub, 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center' 
                  }}>
                    <span>已读 {book.progress} • {formatBookTime(book.last_read, rangeType)}</span>
                    <span style={{
                      background: COLORS.primaryBg,
                      color: COLORS.primary,
                      padding: '3px 8px',
                      borderRadius: 6,
                      fontSize: 10,
                      fontWeight: 600
                    }}>
                      {formatDuration(book.total_duration)}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 热力图卡片 */}
      <div style={{
        background: COLORS.cardBg,
        margin: '0 16px 20px',
        padding: '20px 16px',
        borderRadius: 16,
        boxShadow: '0 2px 8px rgba(0,0,0,0.02)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textMain, display: 'flex', alignItems: 'center' }}>
            阅读热力图
            <span style={{ fontSize: 12, color: COLORS.textSub, marginLeft: 8, fontWeight: 400 }}>
              ({heatmapRange === 90 ? '近3个月' : heatmapRange === 180 ? '近半年' : '近1年'})
            </span>
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#f5f5f5', padding: 3, borderRadius: 8 }}>
            {([90, 180, 365] as HeatmapRange[]).map((range) => (
              <div
                key={range}
                onClick={() => setHeatmapRange(range)}
                style={{
                  fontSize: 10,
                  color: heatmapRange === range ? COLORS.primary : COLORS.textSub,
                  padding: '4px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  background: heatmapRange === range ? '#fff' : 'transparent',
                  fontWeight: heatmapRange === range ? 700 : 400,
                  boxShadow: heatmapRange === range ? '0 1px 3px rgba(0,0,0,0.08)' : 'none'
                }}
              >
                {{ 90: '3月', 180: '6月', 365: '1年' }[range]}
              </div>
            ))}
          </div>
        </div>

        {/* 热力图网格 */}
        <div style={{ width: '100%', overflow: 'hidden' }}>
          <div style={{
            display: 'grid',
            gridTemplateRows: 'repeat(7, 1fr)',
            gridAutoFlow: 'column',
            gridTemplateColumns: `repeat(${weeksCount}, 1fr)`,
            gap: 3,
            width: '100%'
          }}>
            {heatmapData.map((day, index) => (
              <div
                key={index}
                onClick={() => handleHeatboxClick(day.date, day.seconds)}
                style={{
                  aspectRatio: '1 / 1',
                  borderRadius: 2,
                  backgroundColor: COLORS.heatLevels[getHeatLevel(day.seconds)],
                  cursor: 'pointer'
                }}
              />
            ))}
          </div>
        </div>

        {/* 图例 */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'flex-end', 
          alignItems: 'center', 
          fontSize: 10, 
          color: '#999', 
          marginTop: 10 
        }}>
          <span>少</span>
          {COLORS.heatLevels.map((color, i) => (
            <span
              key={i}
              style={{ width: 8, height: 8, background: color, margin: '0 3px', borderRadius: 1 }}
            />
          ))}
          <span>多</span>
        </div>
      </div>

      {/* Toast */}
      <div style={{
        position: 'fixed',
        bottom: 40,
        left: '50%',
        transform: `translateX(-50%) translateY(${toast ? 0 : 20}px)`,
        background: 'rgba(0,0,0,0.8)',
        color: 'white',
        padding: '8px 16px',
        borderRadius: 20,
        fontSize: 12,
        opacity: toast ? 1 : 0,
        transition: 'all 0.3s',
        pointerEvents: 'none',
        zIndex: 999
      }}>
        {toast}
      </div>

      {/* 全局样式 - 动画和滚动条隐藏 */}
      <style>{`
        @keyframes spin {
          100% { transform: rotate(360deg); }
        }
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
    </>
  );
};

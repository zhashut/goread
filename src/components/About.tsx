import React, { useEffect, useState } from 'react';
import { useAppNav } from '../router/useAppNav';
import { getSafeAreaInsets } from '../utils/layout';
import { PageHeader } from './PageHeader';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';

interface LibraryInfo {
  name: string;
  author: string;
  version: string;
  description: string;
  githubUrl: string;
}

const LIBRARIES: LibraryInfo[] = [
  {
    name: 'YESPDF',
    author: 'aaronzzx',
    version: '2.2.5',
    description: '开源 Android PDF 阅读器，本应用的 UI 样式与交互逻辑均致敬并参考自该项目。',
    githubUrl: 'https://github.com/aaronzzx/YESPDF',
  },
  {
    name: 'pdfium-render',
    author: 'ajrcarey',
    version: '0.8.36',
    description: 'PDFium 的高级 Rust 绑定，用于 PDF 渲染',
    githubUrl: 'https://github.com/ajrcarey/pdfium-render',
  },
  {
    name: 'foliate-js',
    author: 'johnfactotum',
    version: 'latest',
    description: '电子书阅读器核心库（EPUB/MOBI/FB2）',
    githubUrl: 'https://github.com/johnfactotum/foliate-js',
  },
  {
    name: 'dnd-kit',
    author: 'clauderic',
    version: '6.3.1',
    description: '现代、轻量、高性能的 React 拖拽工具包',
    githubUrl: 'https://github.com/clauderic/dnd-kit',
  },
  {
    name: 'md-editor-rt',
    author: 'imzbf',
    version: '4.20.2',
    description: 'React Markdown 编辑器，支持代码高亮、图表等',
    githubUrl: 'https://github.com/imzbf/md-editor-rt',
  },
  {
    name: 'html2canvas',
    author: 'niklasvh',
    version: '1.4.1',
    description: '使用 JavaScript 实现网页截图',
    githubUrl: 'https://github.com/niklasvh/html2canvas',
  },
];

export const About: React.FC = () => {
  const nav = useAppNav();
  const safeArea = getSafeAreaInsets();
  const [version, setVersion] = useState<string>('0.1.0');
  const [donateModalVisible, setDonateModalVisible] = useState(false);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {
        setVersion('0.1.0');
      });
  }, []);

  const handleOpenLink = async (url: string) => {
    try {
      await openUrl(url);
    } catch (error) {
      console.error('Failed to open link with opener:', error);
      // 降级处理：尝试使用 window.open
      try {
        const w = window.open(url, '_blank');
        if (!w) {
          window.location.href = url;
        }
      } catch {
        window.location.href = url;
      }
    }
  };

  const styles = {
    container: {
      backgroundColor: '#f7f7f7',
      minHeight: '100vh',
      height: '100vh',
      overflow: 'auto',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      color: '#212121',
      WebkitTapHighlightColor: 'transparent',
      // 隐藏滚动条
      scrollbarWidth: 'none' as const,
      msOverflowStyle: 'none',
      WebkitOverflowScrolling: 'touch',
    } as React.CSSProperties & {
      scrollbarWidth?: string;
      msOverflowStyle?: string;
      WebkitOverflowScrolling?: string;
    },

    brandSection: {
      backgroundColor: '#ffffff',
      padding: '40px 0',
      textAlign: 'center' as const,
      marginBottom: '10px',
    },
    appIcon: {
      width: '80px',
      height: '80px',
      backgroundColor: '#e53935',
      borderRadius: '16px',
      margin: '0 auto 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'white',
      fontSize: '32px',
      fontWeight: 'bold',
      boxShadow: '0 4px 10px rgba(229, 57, 53, 0.3)',
    },
    appName: {
      fontSize: '24px',
      color: '#e53935',
      fontWeight: 600,
      letterSpacing: '1px',
      margin: 0,
      textTransform: 'uppercase' as const,
    },
    appVersion: {
      fontSize: '14px',
      color: '#757575',
      marginTop: '8px',
      fontWeight: 300,
    },
    sectionTitle: {
      padding: '16px 16px 8px 16px',
      fontSize: '14px',
      fontWeight: 'bold',
      color: '#212121',
    },
    listGroup: {
      backgroundColor: '#ffffff',
      marginBottom: '10px',
    },
    listItem: {
      display: 'flex',
      alignItems: 'center',
      padding: '16px',
      textDecoration: 'none',
      color: 'inherit',
      position: 'relative' as const,
      cursor: 'pointer',
      borderBottom: '1px solid #eeeeee',
    },
    listItemNoBorder: {
      borderBottom: 'none',
    },
    itemIcon: {
      width: '24px',
      height: '24px',
      marginRight: '16px',
      fill: '#212121',
      flexShrink: 0,
    },
    itemText: {
      fontSize: '16px',
      flexGrow: 1,
    },
    libContent: {
      width: '100%',
    },
    libHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '4px',
    },
    libName: {
      fontSize: '16px',
      color: '#212121',
    },
    libAuthor: {
      fontSize: '12px',
      color: '#757575',
    },
    libDesc: {
      fontSize: '13px',
      color: '#757575',
      lineHeight: 1.4,
      margin: 0,
    },
    modal: {
      display: donateModalVisible ? 'flex' : 'none',
      position: 'fixed' as const,
      zIndex: 1000,
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
      backgroundColor: 'rgba(0,0,0,0.5)',
      backdropFilter: 'blur(4px)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    modalContent: {
      backgroundColor: 'white',
      padding: '24px',
      borderRadius: '12px',
      textAlign: 'center' as const,
      width: '70%',
      maxWidth: '300px',
      boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
    },
    qrImage: {
      width: '200px',
      height: '200px',
      marginBottom: '10px',
    },
  };

  return (
    <>
      <style>{`
        .about-container::-webkit-scrollbar {
          display: none;
        }
      `}</style>
      <div style={styles.container} className="about-container">
        {/* 顶部导航栏 */}
        <PageHeader
          title="关于"
          onBack={() => nav.goBack()}
          sticky
        />

      {/* 品牌区域 */}
      <div style={styles.brandSection}>
        <div style={styles.appIcon}>
          <svg style={{ width: '48px', height: '48px', fill: 'white' }} viewBox="0 0 24 24">
            <path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z" />
          </svg>
        </div>
        <h2 style={styles.appName}>GOREAD</h2>
        <div style={styles.appVersion}>Version {version}</div>
      </div>

      {/* 概览栏目 */}
      <div style={styles.sectionTitle}>概览</div>
      <div style={styles.listGroup}>
        <div
          style={styles.listItem}
          onClick={() => handleOpenLink('https://github.com/zhashut/goread/releases')}
        >
          <svg style={styles.itemIcon} viewBox="0 0 24 24">
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
          </svg>
          <span style={styles.itemText}>检查更新</span>
        </div>

        <div
          style={styles.listItem}
          onClick={() => handleOpenLink('https://github.com/zhashut/goread/issues/new')}
        >
          <svg style={styles.itemIcon} viewBox="0 0 24 24">
            <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
          </svg>
          <span style={styles.itemText}>反馈</span>
        </div>

        <div
          style={styles.listItem}
          onClick={() => setDonateModalVisible(true)}
        >
          <svg style={styles.itemIcon} viewBox="0 0 24 24">
            <path d="M20 6h-2.18c.11-.31.18-.65.18-1 0-1.66-1.34-3-3-3-1.05 0-1.96.54-2.5 1.35l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-2.02.89-2.02 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v6z" />
          </svg>
          <span style={styles.itemText}>捐赠</span>
        </div>

        <div
          style={styles.listItem}
          onClick={() => handleOpenLink('https://github.com/zhashut/goread')}
        >
          <svg style={styles.itemIcon} viewBox="0 0 24 24">
            <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
          </svg>
          <span style={styles.itemText}>源码</span>
        </div>

        <div
          style={{ ...styles.listItem, ...styles.listItemNoBorder }}
          onClick={() => handleOpenLink('https://github.com/zhashut')}
        >
          <svg style={styles.itemIcon} viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.66-.22.66-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02.8-.22 1.65-.33 2.5-.33.85 0 1.7.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.16.58.67.48C19.14 20.16 22 16.42 22 12c0-5.52-4.48-10-10-10z" />
          </svg>
          <span style={styles.itemText}>GitHub</span>
        </div>
      </div>

      {/* 开源库栏目 */}
      <div style={styles.sectionTitle}>开源库</div>
      <div style={styles.listGroup}>
        {LIBRARIES.map((lib, index) => (
          <div
            key={lib.name}
            style={{
              ...styles.listItem,
              ...(index === LIBRARIES.length - 1 ? styles.listItemNoBorder : {}),
            }}
            onClick={() => handleOpenLink(lib.githubUrl)}
          >
            <div style={styles.libContent}>
              <div style={styles.libHeader}>
                <span style={styles.libName}>{lib.name}</span>
                <span style={styles.libAuthor}>{lib.author}</span>
              </div>
              <p style={styles.libDesc}>{lib.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 底部安全区域 */}
      <div style={{ height: safeArea.bottom }} />

      {/* 捐赠弹窗 */}
      {donateModalVisible && (
        <div
          style={styles.modal}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setDonateModalVisible(false);
            }
          }}
        >
          <div style={styles.modalContent}>
            <h3 style={{ marginTop: 0, color: '#333' }}>支持作者</h3>
            <img
              src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=ReplaceWithYourWxCode"
              alt="捐赠二维码"
              style={styles.qrImage}
            />
            <p style={{ color: '#666', fontSize: '12px', margin: 0 }}>
              截图进入微信选择图片扫码~
            </p>
          </div>
        </div>
      )}
      </div>
    </>
  );
};

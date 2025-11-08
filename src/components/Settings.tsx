import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReaderSettings, saveReaderSettings, ReaderSettings } from '../services';

export const Settings: React.FC = () => {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<ReaderSettings>(getReaderSettings());

  useEffect(() => {
    // 防抖保存
    const id = setTimeout(() => {
      saveReaderSettings(settings);
    }, 100);
    return () => clearTimeout(id);
  }, [settings]);

  const Row: React.FC<{ label: string; right?: React.ReactNode }>=({ label, right }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 4px', borderBottom: '1px solid #eee' }}>
      <div style={{ color: '#333', fontSize: '15px' }}>{label}</div>
      <div>{right}</div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#fafafa', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: '#333', fontSize: '18px', cursor: 'pointer', marginRight: '12px' }} title="返回">{'<'}</button>
        <div style={{ fontSize: '18px', fontWeight: 600, color: '#333' }}>设置</div>
      </div>

      <div style={{ backgroundColor: '#fff', borderRadius: '8px', padding: '4px 16px', margin: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        <Row label="音量键翻页" right={
          <input className="settings-toggle" type="checkbox" checked={settings.volumeKeyTurnPage} onChange={(e)=> setSettings(s=>({ ...s, volumeKeyTurnPage: e.target.checked }))} />
        } />
        <Row label="点击翻页" right={
          <input className="settings-toggle" type="checkbox" checked={settings.clickTurnPage} onChange={(e)=> setSettings(s=>({ ...s, clickTurnPage: e.target.checked }))} />
        } />
        <Row label="显示状态栏" right={
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.showStatusBar}
            onChange={(e)=> {
              const checked = e.target.checked;
              setSettings(s=>({ ...s, showStatusBar: checked }));
              // 仅在移动端浏览器尝试切换全屏；桌面 Tauri/Web 不触发，避免窗口最大化
              const ua = navigator.userAgent || '';
              const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
              const isTauri = typeof (window as any).__TAURI__ !== 'undefined';
              if (isMobile && !isTauri) {
                if (checked) {
                  document.exitFullscreen?.().catch(()=>{});
                } else {
                  document.documentElement.requestFullscreen?.().catch(()=>{});
                }
              }
            }}
          />
        } />
        <Row label="翻页动画" right={
          <input className="settings-toggle" type="checkbox" checked={settings.pageTransition} onChange={(e)=> setSettings(s=>({ ...s, pageTransition: e.target.checked }))} />
        } />

        <Row label="最近显示数量" right={
          <select value={settings.recentDisplayCount} onChange={(e)=> setSettings(s=>({ ...s, recentDisplayCount: Number(e.target.value) }))} style={{ padding: '6px 8px' }}>
            {[5,7,9,12,15].map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        } />

        <div style={{ padding: '12px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#333', fontSize: '15px' }}>滚动速度</span>
            <span style={{ color: '#999', fontSize: '12px' }}>{settings.scrollSpeed} px/s</span>
          </div>
          {(() => {
            const min = 60, max = 300;
            const val = settings.scrollSpeed;
            const pct = Math.max(0, Math.min(100, Math.round(((val - min) / (max - min)) * 100)));
            const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #e0e0e0 ${pct}%, #e0e0e0 100%)`;
            return (
              <input className="settings-range" type="range" min={min} max={max} step={10} value={val}
                onChange={(e)=> setSettings(s=>({ ...s, scrollSpeed: Number(e.target.value) }))}
                style={{ width: '100%', background: track }} />
            );
          })()}
        </div>

        <div style={{ padding: '12px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#333', fontSize: '15px' }}>页面间隙</span>
            <span style={{ color: '#999', fontSize: '12px' }}>{settings.pageGap} px</span>
          </div>
          {(() => {
            const min = 0, max = 48;
            const val = settings.pageGap;
            const pct = Math.max(0, Math.min(100, Math.round(((val - min) / (max - min)) * 100)));
            const track = `linear-gradient(to right, #d15158 0%, #d15158 ${pct}%, #e0e0e0 ${pct}%, #e0e0e0 100%)`;
            return (
              <input className="settings-range" type="range" min={min} max={max} step={2} value={val}
                onChange={(e)=> setSettings(s=>({ ...s, pageGap: Number(e.target.value) }))}
                style={{ width: '100%', background: track }} />
            );
          })()}
        </div>
      </div>
    </div>
  );
};
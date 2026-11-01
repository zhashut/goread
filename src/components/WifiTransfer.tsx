import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

/** WiFi 传书服务信息（与后端 WifiServerInfo 对应） */
type WifiServerInfo = {
  running: boolean;
  port: number;
  urls: string[];
};

/** 接收到的文件信息（与后端 ReceivedFile 对应） */
export type ReceivedFile = {
  name: string;
  path: string;
  size: number;
  /** 目标分组 ID（网页端选择「导入到分组」时携带；null/缺省表示不分组） */
  group_id?: number | null;
};

/**
 * 服务启停请求串行队列。
 *
 * 保证 start/stop 严格按调用顺序到达后端，避免 React StrictMode 双挂载
 * 与快速切换 Tab 时「卸载 stop 晚于重挂载 start 到达」的竞态导致服务被误停。
 */
let transferQueue: Promise<unknown> = Promise.resolve();

/** 将一次服务操作追加到串行队列并返回其 Promise */
const enqueueTransfer = <T,>(op: () => Promise<T>): Promise<T> => {
  const run = transferQueue.then(op, op);
  // 队列本身吞掉错误，避免中断后续操作；错误由调用方通过返回的 run 处理
  transferQueue = run.catch(() => undefined);
  return run;
};

/** 主题玫红色（与「有度」参考图一致，用于地址文字与拷贝按钮） */
const ACCENT = "#e2556b";

interface WifiTransferProps {
  /** 用户点击「导入」时，将接收文件路径交给导入分组流程 */
  onImportPaths: (paths: string[]) => void;
  /** 已接收文件列表（由父级持有，跨 Tab 保留） */
  received: ReceivedFile[];
}

/** 格式化文件大小展示 */
const formatSize = (n: number): string => {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};

/**
 * WiFi 传书页——UI 样式与布局 1:1 对齐「有度」局域网传输页参考图：
 * 「待导入的文件」行 → 标题 → 注意事项 → 地球图标 → 白色地址卡片 →
 * WiFi 图标 → 拷贝大按钮；浅灰底，无多余元素。
 * 服务随界面生命周期启停（挂载自动开启、卸载自动停止），无手动开关。
 *
 * @param props.onImportPaths 将接收文件路径交给上层复用导入分组流程
 * @param props.received 已接收文件列表（父级持有）
 * @returns WiFi 传书页组件
 */
export const WifiTransfer: React.FC<WifiTransferProps> = ({
  onImportPaths,
  received,
}) => {
  const { t } = useTranslation("bookshelf");
  // 服务地址列表（挂载时由 wifi_transfer_start 返回）
  const [urls, setUrls] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  // 挂载时自动开启服务；卸载（切换 Tab/离开导入页）时自动停止
  useEffect(() => {
    let cancelled = false;
    enqueueTransfer(() => invoke<WifiServerInfo>("wifi_transfer_start"))
      .then((info) => {
        if (cancelled) return;
        if (!info.running || info.urls.length === 0) {
          // 理论上不会出现：启动失败时后端返回错误而非 running=false；
          // 保留兜底提示以防异常情形
          alert(t("wifi.startFailed"));
          return;
        }
        setUrls(info.urls);
      })
      .catch((e) => {
        alert(`${t("wifi.startFailed")}\n${String(e)}`);
      });
    return () => {
      cancelled = true;
      enqueueTransfer(() => invoke<WifiServerInfo>("wifi_transfer_stop")).catch(
        () => {}
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时清理复制反馈定时器
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  /** 复制地址，按钮短暂显示「已复制」反馈 */
  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  }, []);

  /** 将已接收文件路径交给导入分组流程 */
  const importReceived = useCallback(() => {
    const paths = received.map((r) => r.path);
    if (paths.length > 0) {
      onImportPaths(paths);
    }
  }, [received, onImportPaths]);

  // 主地址（优先 192.168 私网地址，由后端排序）
  const primaryUrlText = urls[0] ?? "";

  return (
    <div
      style={{
        minHeight: "100%",
        background: "#f5f5f5",
        padding: "24px 24px 32px 24px",
        boxSizing: "border-box",
      }}
    >
      {/* 待导入的文件行：左标题右状态（参考图样式，无分割线） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 15, color: "#333" }}>
          {t("wifi.pendingFiles")}
        </span>
        <span style={{ fontSize: 13, color: "#b5b5b5" }}>
          {received.length === 0
            ? t("wifi.noUploads")
            : t("wifi.uploadedCount", { count: received.length })}
        </span>
      </div>

      {/* 已接收文件列表与导入入口（有文件时才显示） */}
      {received.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {received.map((f, idx) => (
              <div
                key={`${f.path}-${idx}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 14px",
                  borderBottom: "1px solid #f0f0f0",
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    color: "#333",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    marginRight: 8,
                  }}
                >
                  {f.name}
                </span>
                <span style={{ color: "#b5b5b5", flexShrink: 0 }}>
                  {formatSize(f.size)}
                </span>
              </div>
            ))}
          </div>
          <button
            className="wifi-import-btn"
            onClick={importReceived}
            style={{
              marginTop: 14,
              width: "100%",
              height: 50,
              border: "none",
              borderRadius: 25,
              background: ACCENT,
              color: "#fff",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            {t("wifi.importReceived", { count: received.length })}
          </button>
        </div>
      )}

      {/* 地址区域（服务启动就绪后显示） */}
      {primaryUrlText && (
        <>
          {/* 标题（与上方行保持参考图的大间距） */}
          <div
            style={{
              marginTop: 56,
              textAlign: "center",
              fontSize: 17,
              fontWeight: 600,
              color: "#1a1a1a",
            }}
          >
            {t("wifi.addressTitle")}
          </div>

          {/* 注意事项（含支持格式说明，灰色小字居中） */}
          <div
            style={{
              marginTop: 10,
              textAlign: "center",
              fontSize: 13,
              color: "#9a9a9a",
              lineHeight: 1.75,
            }}
          >
            {t("wifi.addressNote")}
          </div>

          {/* 地球图标（灰色实心风格） */}
          <div
            style={{
              marginTop: 26,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden>
              <circle cx="12" cy="12" r="10.2" fill="#8f8f8f" />
              {/* 大陆块（白色剪影） */}
              <path
                d="M4.5 8.2c1.4-.6 2.6-.2 3.2.7.5.8 1.6.9 2.3.4.8-.5 1.9-.3 2.3.5.4.8-.1 1.6-1 1.9-.9.3-1.3 1.1-1.1 1.9.2.8-.3 1.6-1.2 1.7-1 .1-1.7-.6-2.1-1.5-.4-1-1.2-1.6-1.9-2.2-.6-.5-1-1.6-.5-2.4z"
                fill="#f2f2f2"
              />
              <path
                d="M15.2 6.1c.9-.3 1.9.1 2.4.9.5.9 1.5 1 2.1.6-.5-1.6-1.5-3-2.9-3.9-.6.7-1.2 1.7-1.6 2.4z"
                fill="#f2f2f2"
              />
              <path
                d="M13.6 14.6c.9-.4 1.9-.1 2.4.7.5.9.1 2-.8 2.5-.6.4-.9 1-.8 1.7 1.9-.9 3.4-2.5 4.1-4.5-.7-.6-1.7-.9-2.6-.7-1 .2-1.9.1-2.3.3z"
                fill="#f2f2f2"
              />
              {/* 经纬线 */}
              <ellipse
                cx="12"
                cy="12"
                rx="4.4"
                ry="10.2"
                fill="none"
                stroke="#f2f2f2"
                strokeWidth="0.8"
                opacity="0.7"
              />
              <line x1="1.8" y1="12" x2="22.2" y2="12" stroke="#f2f2f2" strokeWidth="0.8" opacity="0.7" />
              <path d="M2.6 7.6c2.6 1.3 6 2 9.4 2s6.8-.7 9.4-2" fill="none" stroke="#f2f2f2" strokeWidth="0.8" opacity="0.7" />
              <path d="M2.6 16.4c2.6-1.3 6-2 9.4-2s6.8.7 9.4 2" fill="none" stroke="#f2f2f2" strokeWidth="0.8" opacity="0.7" />
            </svg>
          </div>

          {/* 地址卡片：白底大圆角，玫红地址文字，点击亦可复制 */}
          <div
            onClick={() => copyUrl(primaryUrlText)}
            style={{
              marginTop: 24,
              background: "#fff",
              borderRadius: 22,
              padding: "18px 16px",
              textAlign: "center",
              fontSize: 15,
              fontWeight: 500,
              color: ACCENT,
              cursor: "pointer",
              wordBreak: "break-all",
            }}
          >
            {primaryUrlText}
          </div>

          {/* WiFi 图标（黑色实心弧） */}
          <div
            style={{
              marginTop: 26,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <svg width="62" height="62" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M1.6 8.6C7.4 3.4 16.6 3.4 22.4 8.6"
                stroke="#1a1a1a"
                strokeWidth="2.6"
                strokeLinecap="round"
              />
              <path
                d="M4.8 12.4c4.1-3.6 10.3-3.6 14.4 0"
                stroke="#1a1a1a"
                strokeWidth="2.6"
                strokeLinecap="round"
              />
              <path
                d="M8.1 16.1c2.2-1.9 5.6-1.9 7.8 0"
                stroke="#1a1a1a"
                strokeWidth="2.6"
                strokeLinecap="round"
              />
              <circle cx="12" cy="19.6" r="1.7" fill="#1a1a1a" />
            </svg>
          </div>

          {/* 拷贝大按钮 */}
          <button
            className="wifi-copy-btn"
            onClick={() => copyUrl(primaryUrlText)}
            style={{
              marginTop: 26,
              width: "100%",
              height: 52,
              border: "none",
              borderRadius: 26,
              background: ACCENT,
              color: "#fff",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            {copied ? t("wifi.copied") : t("wifi.copyUrl")}
          </button>
        </>
      )}
    </div>
  );
};

import React, { useState, useRef } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { log } from "../../services";
import { CropRect, InteractionType, ResizeHandle } from "./types";

interface CropOverlayProps {
  visible: boolean;
  capturedImage: string | null;
  onClose: () => void;
  onSaveSuccess?: () => void;
  onSaveError?: (msg: string) => void;
}

export const CropOverlay: React.FC<CropOverlayProps> = ({
  visible,
  capturedImage,
  onClose,
  onSaveSuccess,
  onSaveError,
}) => {
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [interactionState, setInteractionState] = useState<{
    type: InteractionType;
    handle?: ResizeHandle;
    startX: number;
    startY: number;
    startRect?: CropRect;
  }>({ type: 'none', startX: 0, startY: 0 });

  const imageRef = useRef<HTMLImageElement>(null);

  if (!visible || !capturedImage) return null;

  const handleSaveCrop = async () => {
    if (!capturedImage || !imageRef.current) return;
    try {
      const img = imageRef.current;
      // 如果没有裁切框，默认使用全图
      const currentRect = cropRect || {
        x: 0,
        y: 0,
        w: img.width,
        h: img.height
      };

      const canvas = document.createElement("canvas");
      const scaleX = img.naturalWidth / img.width;
      const scaleY = img.naturalHeight / img.height;
      
      canvas.width = currentRect.w * scaleX;
      canvas.height = currentRect.h * scaleY;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(
          img,
          currentRect.x * scaleX,
          currentRect.y * scaleY,
          currentRect.w * scaleX,
          currentRect.h * scaleY,
          0,
          0,
          canvas.width,
          canvas.height
        );
        
        const dataUrl = canvas.toDataURL("image/png");
        const base64Data = dataUrl.split(',')[1];
        const binaryString = atob(base64Data);
        const len = binaryString.length;
        const binaryData = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          binaryData[i] = binaryString.charCodeAt(i);
        }
        
        // Detect mobile
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        await log("Is mobile: " + isMobile);
        
        let savePath = null;
        
        if (!isMobile) {
            await log("Opening save dialog...");
            savePath = await save({
                filters: [{
                    name: 'Image',
                    extensions: ['png', 'jpg']
                }],
                defaultPath: `goread_capture_${Date.now()}.png`
            });
            await log("Save dialog result: " + savePath);
            
            if (!savePath) {
                await log("User cancelled save dialog");
                return; // User cancelled
            }
        }
        
        await log("Invoking save_image_to_gallery with path: " + savePath);
        const result = await invoke('save_image_to_gallery', {
            data: Array.from(binaryData),
            filename: `goread_capture_${Date.now()}.png`,
            path: savePath
        });
        await log("Save result: " + result);
        
        if (onSaveSuccess) {
          onSaveSuccess();
        }
      }
    } catch (e) {
      await log("Save failed", 'error', e);
      if (onSaveError) {
        let msg = "未知错误";
        if (typeof e === 'string') msg = e;
        else if (e instanceof Error) msg = e.message;
        else msg = JSON.stringify(e);
        onSaveError(msg);
      } else {
        // 即使没有提供错误回调，也不要弹出 alert，避免打断用户体验
        console.error("Save failed:", e);
      }
    } finally {
      // 无论保存成功与否（包括用户取消），都退出裁切视图
      onClose();
    }
  };

  const getEventPos = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    if ('touches' in e) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
  };

  const handleInteractionStart = (
    e: React.MouseEvent | React.TouchEvent, 
    type: InteractionType, 
    handle?: ResizeHandle
  ) => {
    if ('touches' in e && e.touches.length > 1) return;

    if (!imageRef.current) return;
    const { x, y } = getEventPos(e);
    
    if (type === 'creating') {
      const rect = imageRef.current.getBoundingClientRect();
      const relX = x - rect.left;
      const relY = y - rect.top;
      setCropRect({ x: relX, y: relY, w: 0, h: 0 });
      setInteractionState({
        type,
        startX: relX,
        startY: relY,
      });
    } else {
      e.stopPropagation();
      setInteractionState({
        type,
        handle,
        startX: x,
        startY: y,
        startRect: cropRect ? { ...cropRect } : undefined
      });
    }
  };

  const handleInteractionMove = (e: React.MouseEvent | React.TouchEvent) => {
    const state = interactionState;
    if (state.type === 'none' || !imageRef.current) return;
    e.preventDefault();

    const { x: clientX, y: clientY } = getEventPos(e);
    const imgRect = imageRef.current.getBoundingClientRect();
    
    const relX = Math.max(0, Math.min(clientX - imgRect.left, imgRect.width));
    const relY = Math.max(0, Math.min(clientY - imgRect.top, imgRect.height));

    if (state.type === 'creating') {
      const startX = state.startX;
      const startY = state.startY;
      
      const newX = Math.min(startX, relX);
      const newY = Math.min(startY, relY);
      const w = Math.abs(relX - startX);
      const h = Math.abs(relY - startY);
      
      setCropRect({ x: newX, y: newY, w, h });
    } else if (state.type === 'moving' && state.startRect) {
      const dx = clientX - state.startX;
      const dy = clientY - state.startY;
      
      let newX = state.startRect.x + dx;
      let newY = state.startRect.y + dy;
      
      newX = Math.max(0, Math.min(newX, imgRect.width - state.startRect.w));
      newY = Math.max(0, Math.min(newY, imgRect.height - state.startRect.h));
      
      setCropRect({ ...state.startRect, x: newX, y: newY });
    } else if (state.type === 'resizing' && state.startRect && state.handle) {
      const oldRect = state.startRect;
      
      let newX = oldRect.x;
      let newY = oldRect.y;
      let newW = oldRect.w;
      let newH = oldRect.h;
      
      const oldRight = oldRect.x + oldRect.w;
      const oldBottom = oldRect.y + oldRect.h;

      if (state.handle.includes('w')) {
        const constrainedX = Math.min(relX, oldRight - 10);
        newX = constrainedX;
        newW = oldRight - constrainedX;
      }
      if (state.handle.includes('e')) {
        const constrainedX = Math.max(relX, newX + 10);
        newW = constrainedX - newX;
      }
      if (state.handle.includes('n')) {
        const constrainedY = Math.min(relY, oldBottom - 10);
        newY = constrainedY;
        newH = oldBottom - constrainedY;
      }
      if (state.handle.includes('s')) {
        const constrainedY = Math.max(relY, newY + 10);
        newH = constrainedY - newY;
      }

      setCropRect({ x: newX, y: newY, w: newW, h: newH });
    }
  };

  const handleInteractionEnd = () => {
    setInteractionState({ type: 'none', startX: 0, startY: 0 });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "#000",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        touchAction: "none",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseMove={handleInteractionMove}
      onTouchMove={handleInteractionMove}
      onMouseUp={handleInteractionEnd}
      onTouchEnd={handleInteractionEnd}
      onMouseLeave={handleInteractionEnd}
    >
      {/* 顶部栏 */}
      <div
        style={{
          height: "56px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0 16px",
          backgroundColor: "#000",
          color: "#fff",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          zIndex: 10,
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{
            background: "none",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px",
            opacity: 0.8,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        <span style={{ fontSize: "18px", fontWeight: 500 }}>裁切</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleSaveCrop();
          }}
          style={{
            background: "none",
            border: "none",
            color: "#d15158",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px",
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>
      </div>
      
      {/* 图片区域 */}
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#121212",
          userSelect: "none",
          padding: "32px",
        }}
        onMouseDown={(e) => handleInteractionStart(e, 'creating')}
        onTouchStart={(e) => handleInteractionStart(e, 'creating')}
      >
        <img
          ref={imageRef}
          src={capturedImage}
          alt="Capture"
          onLoad={(e) => {
            const img = e.currentTarget;
            setCropRect({
              x: 0,
              y: 0,
              w: img.width,
              h: img.height
            });
          }}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            display: "block",
            pointerEvents: "none",
          }}
          draggable={false}
        />
        
      {/* 裁切框与遮罩 */}
        {cropRect && imageRef.current && (
           <div
             style={{
               position: "absolute",
               left: imageRef.current.offsetLeft + cropRect.x,
               top: imageRef.current.offsetTop + cropRect.y,
               width: cropRect.w,
               height: cropRect.h,
               border: "2px solid #fff",
               boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
               pointerEvents: "auto", // 允许交互
               cursor: "move",
               boxSizing: "border-box", // 防止边框导致尺寸溢出
             }}
             onMouseDown={(e) => handleInteractionStart(e, 'moving')}
             onTouchStart={(e) => handleInteractionStart(e, 'moving')}
           >
             {/* 裁切手柄 */}
             {[
               { h: 'nw', top: '-8px', left: '-8px', cursor: 'nw-resize' },
               { h: 'ne', top: '-8px', left: 'calc(100% - 8px)', cursor: 'ne-resize' },
               { h: 'sw', top: 'calc(100% - 8px)', left: '-8px', cursor: 'sw-resize' },
               { h: 'se', top: 'calc(100% - 8px)', left: 'calc(100% - 8px)', cursor: 'se-resize' },
             ].map((item) => (
               <div
                 key={item.h}
                 style={{
                   position: "absolute",
                   top: item.top,
                   left: item.left,
                   width: "16px",
                   height: "16px",
                   backgroundColor: "#fff",
                   border: "2px solid #d15158",
                   borderRadius: "50%",
                   cursor: item.cursor,
                   zIndex: 10,
                   boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
                   boxSizing: "border-box",
                 }}
                 onMouseDown={(e) => handleInteractionStart(e, 'resizing', item.h as ResizeHandle)}
                 onTouchStart={(e) => handleInteractionStart(e, 'resizing', item.h as ResizeHandle)}
               />
             ))}
           </div>
        )}
      </div>
    </div>
  );
};

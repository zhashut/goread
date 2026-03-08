import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  READER_FONT_CONTROL_EDGE_OFFSET,
  READER_FONT_SLIDER_HEIGHT,
  READER_FONT_SLIDER_ICON_PADDING,
  READER_FONT_SLIDER_PADDING_Y,
  READER_FONT_SLIDER_RADIUS,
  READER_FONT_SLIDER_THUMB_SIZE,
  READER_FONT_SLIDER_TOP,
  READER_FONT_SLIDER_TRACK_WIDTH,
  READER_FONT_SLIDER_WIDTH,
} from "../../constants/ui";
import { READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN } from "../../constants/font";

type FontSizeControlProps = {
  visible: boolean;
  fontSize: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onSetByRatio: (ratio: number) => void;
};

type FontIconButtonProps = {
  symbolId: "icon-font-large" | "icon-font-small";
  size: number;
  fill: string;
  onClick: () => void;
};

const FontIconButton: React.FC<FontIconButtonProps> = ({ symbolId, size, fill, onClick }) => {
  const [pressed, setPressed] = useState(false);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        setPressed(true);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        setPressed(false);
      }}
      onPointerCancel={(e) => {
        e.stopPropagation();
        setPressed(false);
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        setPressed(false);
      }}
      style={{
        padding: READER_FONT_SLIDER_ICON_PADDING,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "none",
        outline: "none",
        WebkitAppearance: "none",
        appearance: "none",
        opacity: pressed ? 0.7 : 1,
        transform: pressed ? "scale(0.9)" : "scale(1)",
        transition: "opacity 0.08s ease, transform 0.08s ease",
      }}
    >
      <svg width={size} height={size} fill={fill} style={{ display: "block" }} aria-hidden="true" role="presentation">
        <use xlinkHref={`#${symbolId}`} />
      </svg>
    </button>
  );
};

export const FontSizeControl: React.FC<FontSizeControlProps> = ({
  visible,
  fontSize,
  onIncrease,
  onDecrease,
  onSetByRatio,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);

  const ratio = useMemo(() => {
    const span = READER_FONT_SIZE_MAX - READER_FONT_SIZE_MIN;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (fontSize - READER_FONT_SIZE_MIN) / span));
  }, [fontSize]);

  const handleTrackPoint = useCallback(
    (clientY: number) => {
      const trackEl = trackRef.current;
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      const y = Math.max(rect.top, Math.min(rect.bottom, clientY));
      const nextRatio = 1 - (y - rect.top) / Math.max(1, rect.height);
      onSetByRatio(nextRatio);
    },
    [onSetByRatio]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      handleTrackPoint(e.clientY);
    },
    [handleTrackPoint]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
      e.preventDefault();
      handleTrackPoint(e.clientY);
    },
    [handleTrackPoint]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      return;
    }
  }, []);

  if (!visible) return null;

  return (
    <>
      <svg
        aria-hidden="true"
        focusable="false"
        style={{ display: "none" }}
      >
        <symbol id="icon-font-small" viewBox="0 0 24 24">
          <path d="M4 17h2v-7h3V8H4V6h10v2h-3v9h2v2H4v-2z" transform="translate(4, 0)" />
        </symbol>
        <symbol id="icon-font-large" viewBox="0 0 24 24">
          <path d="M2 17h2v-7h5V8H2V5h14v3h-5v9h2v2H2v-2z" transform="translate(3, -1)" />
        </symbol>
      </svg>

      <div
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: READER_FONT_CONTROL_EDGE_OFFSET,
          top: READER_FONT_SLIDER_TOP,
          width: READER_FONT_SLIDER_WIDTH,
          height: READER_FONT_SLIDER_HEIGHT,
          boxSizing: "border-box",
          backgroundColor: "#2c2c2c",
          border: "1px solid #3d3d3d",
          borderRadius: `${READER_FONT_SLIDER_RADIUS}px`,
          boxShadow: "0 4px 10px rgba(0,0,0,0.5)",
          zIndex: 11,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `${READER_FONT_SLIDER_PADDING_Y}px 0`,
        }}
      >
        <FontIconButton
          symbolId="icon-font-large"
          size={20}
          fill="#ccc"
          onClick={onIncrease}
        />

        <div
          ref={trackRef}
          role="slider"
          aria-valuemin={READER_FONT_SIZE_MIN}
          aria-valuemax={READER_FONT_SIZE_MAX}
          aria-valuenow={fontSize}
          tabIndex={-1}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{
            flex: 1,
            width: "100%",
            display: "flex",
            justifyContent: "center",
            position: "relative",
            margin: "8px 0",
            cursor: "pointer",
            touchAction: "none",
          }}
        >
          <div
            style={{
              width: READER_FONT_SLIDER_TRACK_WIDTH,
              height: "100%",
              background: "#3d3d3d",
              borderRadius: 2,
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 0,
              width: READER_FONT_SLIDER_TRACK_WIDTH,
              height: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
              background: "#d15158",
              borderRadius: 2,
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
              left: "50%",
              transform: "translate(-50%, 50%)",
              width: READER_FONT_SLIDER_THUMB_SIZE,
              height: READER_FONT_SLIDER_THUMB_SIZE,
              background: "#fff",
              borderRadius: "50%",
              boxShadow: "0 2px 4px rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
        </div>

        <FontIconButton
          symbolId="icon-font-small"
          size={14}
          fill="#777"
          onClick={onDecrease}
        />
      </div>
    </>
  );
};

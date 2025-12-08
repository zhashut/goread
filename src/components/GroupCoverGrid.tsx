import React from "react";
import MarkdownCover from "./MarkdownCover";
import { MARKDOWN_COVER_PLACEHOLDER } from "../constants/ui";

/**
 * 通用分组封面 2x2 网格，样式与“全部”栏目一致。
 * 传入最多 4 张 base64 封面（不足时以空白占位）。
 */
export const GroupCoverGrid: React.FC<{ covers: string[]; variant?: "default" | "compact"; tileRatio?: string }> = ({ covers, variant = "default", tileRatio }) => {
  const isCompact = variant === "compact";
  // 模拟 gap=4, padding=4 的效果：外层 padding=2，每个格子 padding=2 => 总边缘=4, 中间=4
  const halfGap = 2;

  // 计算 padding-bottom 比例，默认 3/4
  let pb = "133.33%";
  if (tileRatio) {
    const parts = tileRatio.split("/");
    if (parts.length === 2) {
      const w = parseFloat(parts[0]);
      const h = parseFloat(parts[1]);
      if (w && h) {
        pb = `${(h / w) * 100}%`;
      }
    }
  }

  const outerStyle = {
    width: "100%",
    position: "relative" as const,
    paddingBottom: pb,
    height: 0,
    background: "#fff",
    border: isCompact ? "1px solid #eeeeee" : "1px solid #e5e5e5",
    borderRadius: isCompact ? 8 : 4,
    boxShadow: isCompact ? "none" : "0 2px 6px rgba(0,0,0,0.06)",
    overflow: "hidden" as const,
    boxSizing: "content-box" as const,
  };

  return (
    <div style={outerStyle}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          padding: halfGap,
          display: "flex",
          flexWrap: "wrap",
          boxSizing: "border-box",
        }}
      >
        {Array.from({ length: 4 }).map((_, idx) => {
          const img = covers[idx];
          return (
            <div
              key={idx}
              style={{
                width: "50%",
                height: "50%",
                padding: halfGap,
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#fff",
                  border: "1px solid #dcdcdc",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                {img
                  ? img === MARKDOWN_COVER_PLACEHOLDER
                    ? <MarkdownCover />
                    : (
                      <img
                        src={`data:image/jpeg;base64,${img}`}
                        alt={`cover-${idx}`}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          objectPosition: "center",
                        }}
                      />
                    )
                  : (
                    <div style={{ width: "100%", height: "100%", background: "#fff" }} />
                  )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default GroupCoverGrid;

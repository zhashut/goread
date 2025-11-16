import React from "react";

/**
 * 通用分组封面 2x2 网格，样式与“全部”栏目一致。
 * 传入最多 4 张 base64 封面（不足时以空白占位）。
 */
export const GroupCoverGrid: React.FC<{ covers: string[]; variant?: "default" | "compact"; tileRatio?: string }> = ({ covers, variant = "default", tileRatio }) => {
  const isCompact = variant === "compact";
  const pad = isCompact ? 4 : 4; // 减小默认 padding 从 6px 到 4px，使内容区域更接近书籍卡片
  const gap = isCompact ? 4 : 4; // 相应减小 gap
  const outerStyle = {
    width: "100%",
    background: "#fff",
    border: isCompact ? "1px solid #eeeeee" : "1px solid #e5e5e5",
    borderRadius: isCompact ? 8 : 4,
    boxShadow: isCompact ? "none" : "0 2px 6px rgba(0,0,0,0.06)",
    overflow: "hidden" as const,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gridTemplateRows: "1fr 1fr",
    gap,
    padding: pad,
    // 外层统一采用 3/4 比例，与书籍卡片封面一致（可被 tileRatio 覆盖）
    aspectRatio: tileRatio || "3 / 4",
    boxSizing: "border-box" as const,
  };

  return (
    <div style={outerStyle}>
      {Array.from({ length: 4 }).map((_, idx) => {
        const img = covers[idx];
        return (
          <div
            key={idx}
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
            {img ? (
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
            ) : (
              <div style={{ width: "100%", height: "100%", background: "#fff" }} />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default GroupCoverGrid;
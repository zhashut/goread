import React from "react";

/**
 * 通用分组封面 2x2 网格，样式与“全部”栏目一致。
 * 传入最多 4 张 base64 封面（不足时以空白占位）。
 */
export const GroupCoverGrid: React.FC<{ covers: string[]; variant?: "default" | "compact"; tileRatio?: string }> = ({ covers, variant = "default", tileRatio }) => {
  const outerStyle =
    variant === "compact"
      ? {
          width: "100%",
          background: "#fff",
          border: "1px solid #eeeeee",
          borderRadius: 8,
          boxShadow: "none",
          overflow: "hidden" as const,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          padding: 4,
        }
      : {
          width: "100%",
          background: "#fff",
          border: "1px solid #e5e5e5",
          borderRadius: 4,
          boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
          overflow: "hidden" as const,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          padding: 6,
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
              aspectRatio: tileRatio || (variant === "compact" ? "3 / 4" : "2 / 3"),
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
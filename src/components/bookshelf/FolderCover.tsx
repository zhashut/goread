import React from "react";

/**
 * 文件夹卡片封面组件（书架分组卡片专用）。
 *
 * 功能描述：
 * - 外壳保持 GroupCoverGrid 默认样式的几何尺寸（3:4 比例），保证与书籍卡片对齐、
 *   选择模式圆标按钮定位一致；配色改为浅黄底、无描边、大圆角，贴近参考图扁平卡片；
 * - 中央渲染双层黄色填充文件夹图标（背板浅黄 + 前板金黄），不展示分组内任何书籍内容。
 *
 * 参数说明：无外部 props（外壳尺寸随父容器宽度自适应）。
 *
 * 返回值类型及用途：React.FC，渲染双层黄色文件夹占位卡片。
 */
export const FolderCover: React.FC = () => {
  // 外壳样式：尺寸与 GroupCoverGrid 默认 variant 保持一致（tileRatio 3/4 => paddingBottom 133.33%），配色为浅黄扁平卡片
  const outerStyle: React.CSSProperties = {
    width: "100%",
    position: "relative",
    paddingBottom: "133.33%",
    height: 0,
    background: "#FFF7E1",
    borderRadius: 8,
    overflow: "hidden",
    boxSizing: "content-box",
  };

  return (
    <div style={outerStyle}>
      {/* 图标容器：绝对定位铺满后水平垂直居中，图标宽度按卡片比例自适应 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxSizing: "border-box",
        }}
      >
        <svg
          width="60%"
          height="60%"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* 背板：文件夹整体轮廓（含左上标签耳），浅黄色 */}
          <path
            d="M3.5 6.5C3.5 5.4 4.4 4.5 5.5 4.5H9.3C9.8 4.5 10.3 4.7 10.6 5.1L11.8 6.5H18.5C19.6 6.5 20.5 7.4 20.5 8.5V17.5C20.5 18.6 19.6 19.5 18.5 19.5H5.5C4.4 19.5 3.5 18.6 3.5 17.5V6.5Z"
            fill="#FBD97A"
          />
          {/* 前板：前盖略宽且底边下探，形成双层层次，金黄色 */}
          <path
            d="M3 10.2C3 9.6 3.5 9.2 4 9.2H20C20.5 9.2 21 9.6 21 10.2V18C21 19.1 20.1 20 19 20H5C3.9 20 3 19.1 3 18V10.2Z"
            fill="#F5B840"
          />
        </svg>
      </div>
    </div>
  );
};

export default FolderCover;

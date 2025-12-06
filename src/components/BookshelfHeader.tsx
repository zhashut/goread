import React from "react";
import {
  TOP_BAR_MARGIN_BOTTOM,
  TOP_BAR_TAB_PADDING_BOTTOM,
  TOP_BAR_ICON_GAP,
} from "../constants/ui";

interface BookshelfHeaderProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /**
   * Alignment of the left container's content.
   * - "flex-end": for Tabs (text aligns to bottom)
   * - "center": for Selection Mode (icon + text aligns to center)
   * Default: "flex-end"
   */
  leftAlign?: "flex-end" | "center";
  /**
   * Ref for the left container (useful for measuring tab positions)
   */
  leftContainerRef?: React.RefObject<HTMLDivElement>;
}

export const BookshelfHeader: React.FC<BookshelfHeaderProps> = ({
  left,
  right,
  leftAlign = "flex-end",
  leftContainerRef,
}) => {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: `${TOP_BAR_MARGIN_BOTTOM}px`,
      }}
    >
      {/* Left Section (Tabs or Back Button) */}
      <div
        ref={leftContainerRef}
        style={{
          display: "flex",
          alignItems: leftAlign,
          position: "relative",
          paddingBottom: `${TOP_BAR_TAB_PADDING_BOTTOM}px`,
        }}
      >
        {left}
      </div>

      {/* Right Section (Actions) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          position: "relative",
          gap: `${TOP_BAR_ICON_GAP}px`,
          // The right section is vertically centered in the container.
          // The container height is determined by the Left Section (Content + Padding).
        }}
      >
        {right}
      </div>
    </div>
  );
};

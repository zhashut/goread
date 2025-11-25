import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface SortableItemProps {
  id: number | string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export const SortableItem: React.FC<SortableItemProps> = ({
  id,
  children,
  style,
  className,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const combinedStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : "auto",
    position: "relative",
    touchAction: "none",
    ...style,
  };

  return (
    <div
      ref={setNodeRef}
      style={combinedStyle}
      className={className}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

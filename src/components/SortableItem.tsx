import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface SortableItemProps {
  id: number | string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  disabled?: boolean;
}

export const SortableItem: React.FC<SortableItemProps> = ({
  id,
  children,
  style,
  className,
  disabled,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !!disabled });

  const combinedStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : "auto",
    position: "relative",
    touchAction: "manipulation",
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

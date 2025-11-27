import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BookCard } from "./BookCard";
import { IBook } from "../types";

interface SortableBookItemProps {
  id: number | string;
  book: IBook;
  onClick: () => void;
  onLongPress: () => void;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
  width?: number | string;
}

export const SortableBookItem: React.FC<SortableBookItemProps> = (props) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : "auto",
    position: "relative",
    touchAction: "none", // 防止触摸滚动干扰拖拽
    width: "100%",
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <BookCard {...props} />
    </div>
  );
};

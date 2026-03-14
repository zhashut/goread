import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IBook } from "../../../types";
import { bookService, logError } from "../../../services";
import {
  READER_FONT_SIZE_DEFAULT,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_FONT_SIZE_STEP,
} from "../../../constants/font";

type UseBookFontSizeOptions = {
  book: IBook | null;
  isExternal: boolean;
  supported: boolean;
  setBook: React.Dispatch<React.SetStateAction<IBook | null>>;
};

export const useBookFontSize = ({
  book,
  isExternal,
  supported,
  setBook,
}: UseBookFontSizeOptions) => {
  const { t } = useTranslation("reader");

  const initial = useMemo(() => {
    if (!supported) return READER_FONT_SIZE_DEFAULT;
    if (isExternal) return READER_FONT_SIZE_DEFAULT;
    const raw = book?.font_size;
    if (typeof raw === "number") return raw;
    return READER_FONT_SIZE_DEFAULT;
  }, [supported, isExternal, book?.font_size]);

  const [fontSize, setFontSizeState] = useState<number>(initial);
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => {
    setFontSizeState(initial);
  }, [initial, book?.id, isExternal]);

  const clampAndStep = useCallback((next: number) => {
    const clamped = Math.max(READER_FONT_SIZE_MIN, Math.min(READER_FONT_SIZE_MAX, next));
    const stepped =
      READER_FONT_SIZE_MIN +
      Math.round((clamped - READER_FONT_SIZE_MIN) / READER_FONT_SIZE_STEP) * READER_FONT_SIZE_STEP;
    return Math.max(READER_FONT_SIZE_MIN, Math.min(READER_FONT_SIZE_MAX, stepped));
  }, []);

  const persist = useCallback(
    async (next: number) => {
      if (isExternal) return;
      if (!book?.id) return;
      try {
        await bookService.updateBookFontSize(book.id, next);
      } catch (error) {
        await logError("[Reader] update font size failed", { error: String(error) });
      }
    },
    [book?.id, isExternal]
  );

  const setFontSize = useCallback(
    (next: number) => {
      if (!supported) return;
      const finalSize = clampAndStep(next);
      setFontSizeState(finalSize);
      setToastMsg(t("fontSize", { size: finalSize }));

      if (!isExternal) {
        setBook((prev) => {
          if (!prev) return prev;
          return { ...prev, font_size: finalSize };
        });
      }

      void persist(finalSize);
    },
    [supported, clampAndStep, persist, isExternal, setBook]
  );

  const setByRatio = useCallback(
    (ratio: number) => {
      const clamped = Math.max(0, Math.min(1, ratio));
      const next = READER_FONT_SIZE_MIN + clamped * (READER_FONT_SIZE_MAX - READER_FONT_SIZE_MIN);
      setFontSize(next);
    },
    [setFontSize]
  );

  const increase = useCallback(() => setFontSize(fontSize + READER_FONT_SIZE_STEP), [setFontSize, fontSize]);
  const decrease = useCallback(() => setFontSize(fontSize - READER_FONT_SIZE_STEP), [setFontSize, fontSize]);

  return {
    fontSize,
    setFontSize,
    setByRatio,
    increase,
    decrease,
    toastMsg,
    clearToast: () => setToastMsg(""),
  };
};


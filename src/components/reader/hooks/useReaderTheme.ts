import { useMemo, useCallback } from "react";
import type { IBook } from "../../../types";
import type { ReaderSettings, ReaderTheme } from "../../../services";
import { getBookFormat } from "../../../services/formats";
import { bookService } from "../../../services";

interface UseReaderThemeParams {
    book: IBook | null;
    isExternal: boolean;
    externalPath: string | null;
    settings: ReaderSettings;
    setBook: React.Dispatch<React.SetStateAction<IBook | null>>;
}

export const useReaderTheme = ({
    book,
    isExternal,
    externalPath,
    settings,
    setBook,
}: UseReaderThemeParams) => {
    const globalTheme: ReaderTheme = (settings.theme || "light") as ReaderTheme;

    const effectiveTheme: ReaderTheme = (book?.theme as ReaderTheme | null) || globalTheme;

    const settingsWithTheme: ReaderSettings = {
        ...settings,
        theme: effectiveTheme,
    };

    const isThemeSupported = useMemo(() => {
        const format = (isExternal && externalPath
            ? getBookFormat(externalPath)
            : book?.file_path
                ? getBookFormat(book.file_path)
                : null);
        return format === "epub" || format === "pdf" || format === "txt";
    }, [isExternal, externalPath, book?.file_path]);

    const bookThemeForUi: "light" | "dark" | null | undefined =
        !isExternal && isThemeSupported && book
            ? ((book.theme as "light" | "dark" | null | undefined) ?? null)
            : undefined;

    const handleChangeBookTheme = useCallback(
        async (theme: "light" | "dark" | null) => {
            if (!book || isExternal) return;
            try {
                await bookService.updateBookTheme(book.id, theme);
                setBook((prev) => {
                    if (!prev || prev.id !== book.id) return prev;
                    return { ...prev, theme };
                });
            } catch {
            }
        },
        [book, isExternal, setBook],
    );

    return {
        effectiveTheme,
        settingsWithTheme,
        isThemeSupported,
        bookThemeForUi,
        handleChangeBookTheme,
    };
};

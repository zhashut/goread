import { useEffect, useRef } from "react";
import { IBook } from "../../../types";
import { statsService } from "../../../services";
import { READING_INACTIVITY_THRESHOLD_MS } from "../../../constants/interactions";

/**
 * 管理阅读时长统计的 Hook
 * 负责记录阅读时间，检测用户是否活跃，并定期保存阅读会话
 */
export const useReadingSession = (book: IBook | null, isExternal: boolean) => {
    const sessionStartRef = useRef<number>(0);
    const lastSaveTimeRef = useRef<number>(0);
    const readingSessionIntervalRef = useRef<number | null>(null);
    const isSessionPausedRef = useRef<boolean>(false);
    const lastActiveTimeRef = useRef<number>(0);

    // 标记用户活跃（翻页、滚动等操作调用）
    const markReadingActive = () => {
        lastActiveTimeRef.current = Date.now();
    };

    useEffect(() => {
        if (isExternal) return;
        if (!book?.id) return;

        const now = Date.now();
        sessionStartRef.current = now;
        lastSaveTimeRef.current = now;
        lastActiveTimeRef.current = now;
        isSessionPausedRef.current = false;

        const stopSessionTimer = () => {
            if (readingSessionIntervalRef.current) {
                window.clearInterval(readingSessionIntervalRef.current);
                readingSessionIntervalRef.current = null;
            }
        };

        const saveSession = async () => {
            const currentTime = Date.now();
            const totalElapsed = currentTime - lastSaveTimeRef.current;
            if (totalElapsed <= 0 || !book?.id) {
                lastSaveTimeRef.current = currentTime;
                return;
            }

            const idleElapsed = currentTime - lastActiveTimeRef.current;
            const inactivityCutoff =
                lastActiveTimeRef.current + READING_INACTIVITY_THRESHOLD_MS;
            const effectiveEndTime =
                idleElapsed >= READING_INACTIVITY_THRESHOLD_MS
                    ? inactivityCutoff
                    : currentTime;

            if (effectiveEndTime <= lastSaveTimeRef.current) {
                lastSaveTimeRef.current = currentTime;
                return;
            }

            const duration = Math.floor(
                (effectiveEndTime - lastSaveTimeRef.current) / 1000
            );

            if (duration >= 5) {
                const today = new Date();
                const readDate = `${today.getFullYear()}-${String(
                    today.getMonth() + 1
                ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

                try {
                    await statsService.saveReadingSession(
                        book.id,
                        duration,
                        Math.floor(lastSaveTimeRef.current / 1000),
                        readDate
                    );
                } catch (e) {
                    console.warn("Failed to save reading session:", e);
                }
            }

            lastSaveTimeRef.current = currentTime;
        };

        const startSessionTimer = () => {
            if (readingSessionIntervalRef.current) {
                return;
            }
            readingSessionIntervalRef.current = window.setInterval(
                saveSession,
                30000
            );
        };

        startSessionTimer();

        const handleVisibilityChange = () => {
            if (document.hidden) {
                saveSession();
                stopSessionTimer();
                isSessionPausedRef.current = true;
            } else {
                const ts = Date.now();
                sessionStartRef.current = ts;
                lastSaveTimeRef.current = ts;
                lastActiveTimeRef.current = ts;
                isSessionPausedRef.current = false;
                startSessionTimer();
            }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            saveSession();
            stopSessionTimer();
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [book?.id, isExternal]);

    return { markReadingActive };
};

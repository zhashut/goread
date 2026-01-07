import { useEffect, useRef, useCallback } from "react";
import { IBook } from "../../../types";
import { statsService, logError } from "../../../services";
import { READING_INACTIVITY_THRESHOLD_MS } from "../../../constants/interactions";

// 单次会话最大时长（30分钟），超过后强制结束
const MAX_SESSION_DURATION_MS = 30 * 60 * 1000;
// 定时器间隔（30秒）
const SESSION_INTERVAL_MS = 30 * 1000;

/**
 * 管理阅读时长统计的 Hook
 * 负责记录阅读时间，检测用户是否活跃，并定期保存阅读会话
 */
export const useReadingSession = (book: IBook | null, isExternal: boolean) => {
    const sessionStartRef = useRef<number>(0);
    const lastSaveTimeRef = useRef<number>(0);
    const readingSessionIntervalRef = useRef<number | null>(null);
    const lastActiveTimeRef = useRef<number>(0);
    const pausedDueToInactivityRef = useRef<boolean>(false);

    const bookIdRef = useRef(book?.id);
    bookIdRef.current = book?.id;

    // 停止定时器
    const stopSessionTimer = useCallback(() => {
        if (readingSessionIntervalRef.current) {
            window.clearInterval(readingSessionIntervalRef.current);
            readingSessionIntervalRef.current = null;
        }
    }, []);

    // 保存当前会话（同步版本，避免在定时器中使用 async）
    const saveSessionSync = useCallback(() => {
        const currentTime = Date.now();
        const totalElapsed = currentTime - lastSaveTimeRef.current;
        const currentBookId = bookIdRef.current;

        if (totalElapsed <= 0 || !currentBookId) {
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

            // 使用 fire-and-forget 模式，避免 async 问题
            statsService.saveReadingSession(
                currentBookId,
                duration,
                Math.floor(lastSaveTimeRef.current / 1000),
                readDate
            ).catch((e) => {
                 logError('保存阅读会话失败', { error: String(e), bookId: currentBookId, duration });
            });
        }

        lastSaveTimeRef.current = currentTime;
    }, []);

    // 启动定时器
    const startSessionTimer = useCallback(() => {
        if (readingSessionIntervalRef.current) {
            return;
        }
        pausedDueToInactivityRef.current = false;
        readingSessionIntervalRef.current = window.setInterval(() => {
            const now = Date.now();
            const idleTime = now - lastActiveTimeRef.current;
            const sessionDuration = now - sessionStartRef.current;

            // 会话时长上限或无操作超时：保存并停止
            if (sessionDuration >= MAX_SESSION_DURATION_MS || idleTime >= READING_INACTIVITY_THRESHOLD_MS) {
                saveSessionSync();
                stopSessionTimer();
                pausedDueToInactivityRef.current = true;
                return;
            }

            saveSessionSync();
        }, SESSION_INTERVAL_MS);
    }, [saveSessionSync, stopSessionTimer]);

    // 标记用户活跃（翻页、滚动等操作调用）
    const markReadingActive = useCallback(() => {
        lastActiveTimeRef.current = Date.now();

        // 如果因无操作暂停且当前在前台，重启定时器
        if (pausedDueToInactivityRef.current && !document.hidden) {
            const now = Date.now();
            sessionStartRef.current = now;
            lastSaveTimeRef.current = now;
            startSessionTimer();
        }
    }, [startSessionTimer]);

    useEffect(() => {
        if (isExternal) return;
        if (!book?.id) return;

        const now = Date.now();
        sessionStartRef.current = now;
        lastSaveTimeRef.current = now;
        lastActiveTimeRef.current = now;
        pausedDueToInactivityRef.current = false;

        // 只在前台时启动定时器
        if (!document.hidden) {
            startSessionTimer();
        }

        // 统一的后台处理函数
        const handleBackground = () => {
            saveSessionSync();
            stopSessionTimer();
        };

        // 统一的前台处理函数
        const handleForeground = () => {
            const ts = Date.now();
            sessionStartRef.current = ts;
            lastSaveTimeRef.current = ts;
            lastActiveTimeRef.current = ts;
            pausedDueToInactivityRef.current = false;
            startSessionTimer();
        };

        // visibilitychange 事件
        const handleVisibilityChange = () => {
            if (document.hidden) {
                handleBackground();
            } else {
                handleForeground();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            saveSessionSync();
            stopSessionTimer();
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [book?.id, isExternal, startSessionTimer, stopSessionTimer, saveSessionSync]);

    return { markReadingActive };
};

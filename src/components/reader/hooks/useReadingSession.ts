import { useEffect, useRef, useCallback } from "react";
import { IBook } from "../../../types";
import { statsService, appLifecycleService } from "../../../services";
import { READING_INACTIVITY_THRESHOLD_MS } from "../../../constants/interactions";

// 单次会话最大时长（30分钟），超过后强制结束
const MAX_SESSION_DURATION_MS = 30 * 60 * 1000;
// 定时器间隔（30秒）
const SESSION_INTERVAL_MS = 30 * 1000;

/**
 * 管理阅读时长统计的 Hook
 * 负责记录阅读时间，检测用户是否活跃，并定期保存阅读会话
 * 
 * 优化特性：
 * - 接入 appLifecycleService，在应用进入后台时停止定时器
 * - 无操作超过阈值后自动停止定时器，节省后台 CPU
 * - 会话时长上限机制，防止异常长时间运行
 */
export const useReadingSession = (book: IBook | null, isExternal: boolean) => {
    const sessionStartRef = useRef<number>(0);
    const lastSaveTimeRef = useRef<number>(0);
    const readingSessionIntervalRef = useRef<number | null>(null);
    const lastActiveTimeRef = useRef<number>(0);
    // 是否因为无操作而暂停了定时器
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

    // 保存当前会话
    const saveSession = useCallback(async () => {
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

            try {
                await statsService.saveReadingSession(
                    currentBookId,
                    duration,
                    Math.floor(lastSaveTimeRef.current / 1000),
                    readDate
                );
            } catch (e) {
                console.warn("Failed to save reading session:", e);
            }
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

            // 检查会话时长上限
            if (sessionDuration >= MAX_SESSION_DURATION_MS) {
                saveSession();
                stopSessionTimer();
                pausedDueToInactivityRef.current = true;
                return;
            }

            // 检查无操作超时
            if (idleTime >= READING_INACTIVITY_THRESHOLD_MS) {
                saveSession();
                stopSessionTimer();
                pausedDueToInactivityRef.current = true;
                return;
            }

            saveSession();
        }, SESSION_INTERVAL_MS);
    }, [saveSession, stopSessionTimer]);

    // 标记用户活跃（翻页、滚动等操作调用）
    const markReadingActive = useCallback(() => {
        lastActiveTimeRef.current = Date.now();

        // 如果因无操作暂停，在前台时重启定时器
        if (pausedDueToInactivityRef.current && appLifecycleService.isForeground) {
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
        if (appLifecycleService.isForeground) {
            startSessionTimer();
        }

        // 监听应用生命周期
        const handleLifecycleChange = (isForeground: boolean) => {
            if (isForeground) {
                // 恢复前台：重置时间点，启动定时器
                const ts = Date.now();
                sessionStartRef.current = ts;
                lastSaveTimeRef.current = ts;
                lastActiveTimeRef.current = ts;
                pausedDueToInactivityRef.current = false;
                startSessionTimer();
            } else {
                // 进入后台：保存会话，停止定时器
                saveSession();
                stopSessionTimer();
            }
        };

        const unsubscribe = appLifecycleService.onStateChange(handleLifecycleChange);

        return () => {
            saveSession();
            stopSessionTimer();
            unsubscribe();
        };
    }, [book?.id, isExternal, startSessionTimer, stopSessionTimer, saveSession]);

    return { markReadingActive };
};

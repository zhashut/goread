import { useEffect, useState } from "react";
import {
  loadNasConnections,
  NAS_CONNECTIONS_CHANGED_EVENT,
  NasConnection,
} from "../../../utils/nasConnections";

/**
 * NAS 连接列表 Hook（书架动态页签使用）
 *
 * 读取共享连接存储，并监听连接变更事件自动刷新，
 * 使书架页签随「导入-NAS」页面的连接增删实时同步。
 *
 * 返回值：nasConnections 当前 NAS 连接列表
 */
export const useNasConnections = () => {
  const [nasConnections, setNasConnections] =
    useState<NasConnection[]>(loadNasConnections);

  // 监听连接变更广播，刷新本地状态（导入页增删连接时书架页签实时跟随）
  useEffect(() => {
    const onChanged = () => {
      setNasConnections(loadNasConnections());
    };
    window.addEventListener(NAS_CONNECTIONS_CHANGED_EVENT, onChanged as EventListener);
    return () => {
      window.removeEventListener(NAS_CONNECTIONS_CHANGED_EVENT, onChanged as EventListener);
    };
  }, []);

  return nasConnections;
};

import React, { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BottomBar, type BottomBarAction } from "../components/bookshelf/BottomBar";
import { useAppNav } from "../router/useAppNav";
import { ensurePermissionForImport } from "../utils/storagePermission";
import { Toast } from "../components/Toast";

/** 全局底部菜单栏基础高度（图标22 + 上下padding 8/7 + 间距3 + 文字约13 + 顶部分隔线1，取55整） */
export const GLOBAL_NAV_BAR_H = 55;

/** 全局底部菜单栏显隐事件：detail 为 true 表示要求显示，false 表示要求隐藏（如书架选择模式） */
export const GLOBAL_NAV_VISIBLE_EVENT = "goread:globalbar:visible";

/** 全局底部菜单栏"书架"入口点击事件（书架页监听，用于关闭分组覆盖层） */
export const GLOBAL_NAV_BOOKSHELF_EVENT = "goread:globalbar:bookshelf";

/**
 * 根据路由路径解析当前高亮的菜单入口
 * @param pathname 当前路由路径（不含查询参数）
 * @returns 高亮入口标识；非主界面路由返回 undefined（全部默认色）
 */
const resolveActiveKey = (pathname: string): BottomBarAction | undefined => {
  if (pathname === "/") return "bookshelf";
  if (pathname === "/import" || pathname.startsWith("/import/")) return "import";
  if (pathname === "/statistics") return "statistics";
  if (pathname === "/settings") return "settings";
  if (pathname === "/about") return "about";
  return undefined;
};

/**
 * 判定当前路由是否展示全局底部菜单栏
 * 阅读器与搜索页为沉浸式界面，不展示菜单栏
 * @param pathname 当前路由路径
 * @returns 是否展示
 */
const isNavRoute = (pathname: string): boolean =>
  !pathname.startsWith("/reader") && pathname !== "/search";

/**
 * 全局底部菜单栏
 *
 * 功能描述：挂载于 MainLayout，跨页面固定展示"书架/导入/统计/设置/关于"五个入口，
 *          按当前路由自动高亮对应入口；阅读器/搜索等沉浸页自动隐藏；
 *          书架选择模式等页面级互斥场景通过 GLOBAL_NAV_VISIBLE_EVENT 事件控制显隐。
 *
 * 参数说明：无参数（内部依赖路由上下文与全局事件）。
 *
 * 返回值类型：React.FC，渲染固定底部菜单栏；不可见时渲染 null。
 */
export const GlobalBottomBar: React.FC = () => {
  const location = useLocation();
  const nav = useAppNav();
  const { t } = useTranslation('bookshelf');

  // 页面级互斥显隐（书架选择模式等），默认显示
  const [pageVisible, setPageVisible] = useState(true);
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => {
    const handleVisible = (e: Event) => {
      setPageVisible(Boolean((e as CustomEvent<boolean>).detail));
    };
    window.addEventListener(GLOBAL_NAV_VISIBLE_EVENT, handleVisible);
    return () => window.removeEventListener(GLOBAL_NAV_VISIBLE_EVENT, handleVisible);
  }, []);

  const routeVisible = isNavRoute(location.pathname);
  const activeKey = resolveActiveKey(location.pathname);

  /**
   * 底部菜单入口统一处理
   * 导入入口先执行存储权限检查（失败时提示并停留当前页）；
   * 书架入口在书架页内触发联动（关闭分组覆盖层），在其它页则回退整个历史栈返回书架根部；
   * 目标页与当前页一致时不重复跳转
   * @param action 被点击的菜单入口标识
   */
  const handleAction = async (action: BottomBarAction) => {
    if (action === "bookshelf") {
      if (location.pathname === "/") {
        // 已在书架：通知书架页关闭分组覆盖层（保持原入口行为）
        window.dispatchEvent(new CustomEvent(GLOBAL_NAV_BOOKSHELF_EVENT));
        return;
      }
      // 从其它页返回书架根部：回退整个历史栈，恢复书架原有状态
      nav.toBookshelf("recent", { resetStack: true });
      return;
    }
    if (action === "import") {
      if (location.pathname === "/import" || location.pathname.startsWith("/import/")) {
        // 扫描结果页已移除返回按钮，点击"导入"作为其唯一出口返回导入页
        if (location.pathname === "/import/results") nav.goBack();
        return;
      }
      const ok = await ensurePermissionForImport();
      if (!ok) {
        // 权限被拒绝，停留在当前页并提示
        setToastMsg(t('importNeedPermission'));
        return;
      }
      nav.toImport({ initialTab: "scan" });
      return;
    }
    if (action === "statistics") {
      if (location.pathname !== "/statistics") nav.toStatistics();
      return;
    }
    if (action === "settings") {
      if (location.pathname !== "/settings") nav.toSettings();
      return;
    }
    if (action === "about") {
      if (location.pathname !== "/about") nav.toAbout();
    }
  };

  if (!routeVisible || !pageVisible) return null;

  return (
    <>
      <BottomBar activeKey={activeKey} onAction={handleAction} />
      <Toast message={toastMsg} onClose={() => setToastMsg("")} />
    </>
  );
};

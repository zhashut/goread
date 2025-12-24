import { useState, useCallback, useEffect } from "react";
import { TocNode } from "../../reader/types";
import { IBookRenderer } from "../../../services/formats";
import { logError } from "../../../services";

export const findActiveNodeSignature = (
    current: number,
    progress: number,
    isPageFullyVisible: boolean,
    nodes: TocNode[]
): string | null => {
    // 1. 收集当前页的所有节点
    const nodesOnPage: { node: TocNode; level: number }[] = [];
    const traverse = (list: TocNode[], level: number) => {
        for (const node of list) {
            if (node.page === current) {
                nodesOnPage.push({ node, level });
            }
            if (node.children) traverse(node.children, level + 1);
        }
    };
    traverse(nodes, 0);

    if (nodesOnPage.length > 0) {
        if (isPageFullyVisible) {
            // 如果页面完全可见，选中该页最后一个节点（视为已阅读完该页内容）
            const target = nodesOnPage[nodesOnPage.length - 1];
            return `${target.node.title}|${target.node.page}|${target.level}`;
        }
        // 根据进度选择节点
        const index = Math.min(
            Math.floor(progress * nodesOnPage.length),
            nodesOnPage.length - 1
        );
        const target = nodesOnPage[index];
        return `${target.node.title}|${target.node.page}|${target.level}`;
    }

    // 2. 如果当前页无节点，查找当前页之前的最后一个节点
    let lastNode: { node: TocNode; level: number } | null = null;
    const traverseLast = (list: TocNode[], level: number) => {
        for (const node of list) {
            if (node.page && node.page < current) {
                lastNode = { node, level };
            }
            if (node.children) traverseLast(node.children, level + 1);
        }
    };
    traverseLast(nodes, 0);

    if (lastNode) {
        const n = lastNode as { node: TocNode; level: number };
        return `${n.node.title}|${n.node.page}|${n.level}`;
    }

    return null;
};

/**
 * 管理目录 (TOC) 的 Hook
 * 负责解析渲染器的目录数据，维护当前激活章节的签名
 */
export const useToc = (
    currentPage: number,
    readingMode: "horizontal" | "vertical",
    isDomRender: boolean
) => {
    const [toc, setToc] = useState<TocNode[]>([]);
    const [activeNodeSignature, setActiveNodeSignature] = useState<
        string | undefined
    >(undefined);

    // 横向模式下自动更新当前章节签名
    useEffect(() => {
        if (readingMode === "horizontal" && !isDomRender) {
            const sig = findActiveNodeSignature(currentPage, 1.0, true, toc);
            setActiveNodeSignature(sig || undefined);
        }
    }, [currentPage, readingMode, toc, isDomRender]);

    const loadToc = useCallback(
        async (
            renderer: IBookRenderer,
            pageCount: number,
            fallbackTitle?: string,
            filePath?: string
        ) => {
            try {
                const tocItems = await renderer.getToc();
                const toTocNode = (items: typeof tocItems): TocNode[] => {
                    return (items || []).map((item: any) => ({
                        title: String(item?.title || ""),
                        page:
                            typeof item?.location === "number" ? item.location : undefined,
                        anchor:
                            typeof item?.location === "string" ? item.location : undefined,
                        children: item?.children ? toTocNode(item.children) : [],
                        expanded: false,
                    }));
                };
                const parsed = toTocNode(tocItems);
                if (parsed.length > 0) {
                    setToc(parsed);
                } else {
                    // 无目录时创建默认条目
                    if (pageCount > 0) {
                        setToc([
                            {
                                title: fallbackTitle || "目录",
                                page: 1,
                                children: [],
                                expanded: true,
                            },
                        ]);
                    } else {
                        setToc([]);
                    }
                }
            } catch (e) {
                if (filePath) {
                    try {
                        await logError("pdf_get_outline failed", {
                            error: String(e),
                            filePath,
                        });
                    } catch { }
                }
                setToc([]);
            }
        },
        []
    );

    return {
        toc,
        setToc,
        activeNodeSignature,
        setActiveNodeSignature,
        loadToc,
    };
};

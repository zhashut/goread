/**
 * Mobi 生命周期 Hook
 * 负责文档加载、解析、TOC 构建、销毁
 */
import { log, logError } from '../../../index';
import { BookInfo, TocItem } from '../../types';
import { MobiBook, MobiTocItem } from '../types';
import { generateQuickBookId } from '../../../../utils/bookId';
import { readFileChunked } from '../../../../utils/chunkedFileReader';
import { mobiCacheService } from '../mobiCacheService';
import { mobiPreloader } from '../mobiPreloader';

export interface MobiLifecycleState {
    isReady: boolean;
    book: MobiBook | null;
    bookInfo: BookInfo | null;
    toc: TocItem[];
    sectionCount: number;
    bookId: string | null;
    filePath: string | null;
}

/** 加载文档选项 */
export interface MobiLoadDocumentOptions {
    /** 是否跳过 preloader 缓存存储（大文件导入时使用，避免内存累积） */
    skipPreloaderCache?: boolean;
}

export interface MobiLifecycleHook {
    state: MobiLifecycleState;
    loadDocument: (filePath: string, options?: MobiLoadDocumentOptions) => Promise<BookInfo>;
    ensureBookLoaded: () => Promise<void>;
    reset: () => Promise<void>;
}

export function useMobiLifecycle(): MobiLifecycleHook {
    const state: MobiLifecycleState = {
        isReady: false,
        book: null,
        bookInfo: null,
        toc: [],
        sectionCount: 0,
        bookId: null,
        filePath: null,
    };

    let _loadPromise: Promise<void> | null = null;
    // 是否跳过预加载缓存（用于大文件导入场景）
    let _skipPreloaderCache = false;

    /**
     * 从文件路径提取文件名
     */
    const _extractFileName = (filePath: string): string => {
        const parts = filePath.replace(/\\/g, '/').split('/');
        const fileName = parts[parts.length - 1];
        return fileName.replace(/\.(mobi|azw3|azw)$/i, '');
    };

    /**
     * 获取封面图片
     */
    const _getCoverImage = async (book: MobiBook): Promise<string | undefined> => {
        if (!book) return undefined;

        try {
            const coverBlob = await book.getCover();
            if (coverBlob) {
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = () => resolve(undefined);
                    reader.readAsDataURL(coverBlob);
                });
            }
        } catch (error) {
            await logError('[MobiRenderer] 获取封面失败', {
                error: String(error),
            }).catch(() => {});
        }
        return undefined;
    };

    /**
     * 将 MOBI 目录转换为通用格式
     */
    const _convertToc = (book: MobiBook, items: MobiTocItem[], level = 0): TocItem[] => {
        if (!book) {
            return [];
        }
        return items.map((item) => {
            let location = item.href || '';
            if (item.href && typeof book.splitTOCHref === 'function') {
                try {
                    const [index] = book.splitTOCHref(item.href);
                    if (typeof index === 'number') {
                        location = `section:${index}`;
                    }
                } catch {
                    location = item.href || '';
                }
            }
            return {
                title: item.label || '未命名章节',
                location,
                level,
                children: item.subitems ? _convertToc(book, item.subitems, level + 1) : undefined,
            };
        });
    };

    /**
     * 从 sections 内容中解析目录（回退策略）
     */
    const _buildTocFromSections = async (book: MobiBook): Promise<TocItem[]> => {
        if (!book) return [];

        const toc: TocItem[] = [];
        const validSections = book.sections.filter(s => s.linear !== 'no');

        await log(`[MobiRenderer] 开始从 ${validSections.length} 个 sections 解析目录`, 'info').catch(() => {});

        for (let i = 0; i < validSections.length; i++) {
            const section = validSections[i];
            try {
                // 获取 section 的 Document
                const doc = await section.createDocument();
                if (!doc) continue;

                // 查找标题元素
                const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');

                if (headings.length > 0) {
                    // 使用标题元素构建目录
                    headings.forEach((heading) => {
                        const text = heading.textContent?.trim();
                        if (text && text.length > 0 && text.length < 200) {
                            // 根据标题级别确定层级
                            const tagName = heading.tagName.toLowerCase();
                            const level = parseInt(tagName.charAt(1)) - 1; // h1=0, h2=1, etc.

                            // 构建锚点 href
                            let href = `section:${section.id}`;
                            if (heading.id) {
                                href = `section:${section.id}#${heading.id}`;
                            }

                            toc.push({
                                title: text,
                                location: href,
                                level: Math.min(level, 2), // 最多3级目录
                            });
                        }
                    });
                } else {
                    // 没有标题元素，尝试获取第一段文本作为章节标题
                    const firstP = doc.querySelector('p');
                    const text = firstP?.textContent?.trim();
                    if (text && text.length > 0 && text.length < 100) {
                        toc.push({
                            title: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
                            location: `section:${section.id}`,
                            level: 0,
                        });
                    } else if (validSections.length <= 20) {
                        // section 数量较少时，为每个 section 生成默认标题
                        toc.push({
                            title: `第 ${i + 1} 章`,
                            location: `section:${section.id}`,
                            level: 0,
                        });
                    }
                }
            } catch (error) {
                await logError(`[MobiRenderer] 解析 section ${section.id} 目录失败`, {
                    error: String(error),
                }).catch(() => {});
            }
        }

        // 如果解析出太多条目，只保留 h1/h2 级别或进行精简
        if (toc.length > 100) {
            await log(`[MobiRenderer] 目录条目过多(${toc.length})，进行精简`, 'info').catch(() => {});
            return toc.filter(item => item.level <= 1).slice(0, 100);
        }

        await log(`[MobiRenderer] 从 sections 解析出 ${toc.length} 个目录条目`, 'info').catch(() => {});
        return toc;
    };

    /**
     * 内部加载逻辑（使用分块读取避免大文件 OOM）
     */
    const _loadBook = async (filePath: string, existingBookId?: string): Promise<BookInfo> => {
        const startTime = Date.now();
        try {
            // 使用分块读取大文件
            const { arrayBuffer } = await readFileChunked({
                filePath,
                logPrefix: '[MobiLifecycle]',
            });

            // 动态导入 foiliate-js 的 mobi 模块
            // @ts-ignore - foliate-js
            const mobiModule: any = await import('../../../../lib/foliate-js/mobi.js');

            // 导入 fflate 用于解压缩
            // @ts-ignore
            const { unzlibSync } = await import('fflate');

            // 创建 MOBI 解析器并打开文件
            const mobi = new mobiModule.MOBI({ unzlib: unzlibSync });
            const file = new File([arrayBuffer], _extractFileName(filePath) + '.mobi', {
                type: 'application/x-mobipocket-ebook',
            });

            const book = await mobi.open(file) as MobiBook;
            state.book = book;

            // 打印原始 toc 数据用于调试
            await log(`[MobiRenderer] 原始目录数据`, 'info', {
                tocLength: book.toc?.length ?? 0,
                tocSample: JSON.stringify((book.toc || []).slice(0, 5)),
                landmarksLength: book.landmarks?.length ?? 0,
                landmarksSample: JSON.stringify((book.landmarks || []).slice(0, 3)),
            }).catch(() => {});

            // 提取目录
            let toc = _convertToc(book, book.toc || []);

            // 如果 toc 为空，尝试从 landmarks 构建目录作为回退
            if (toc.length === 0 && book.landmarks && book.landmarks.length > 0) {
                await log(`[MobiRenderer] toc 为空，尝试从 landmarks 构建目录`, 'info', {
                    landmarksCount: book.landmarks.length,
                }).catch(() => {});

                toc = book.landmarks.map((lm, i) => ({
                    title: lm.label || `章节 ${i + 1}`,
                    location: lm.href || '',
                    level: 0,
                }));
            }

            // 如果仍然为空，尝试从 sections 内容中解析目录
            if (toc.length === 0 && book.sections && book.sections.length > 0) {
                await log(`[MobiRenderer] toc 和 landmarks 都为空，尝试从 sections 解析目录`, 'info', {
                    sectionsCount: book.sections.length,
                }).catch(() => {});

                toc = await _buildTocFromSections(book);
            }

            await log(`[MobiRenderer] 最终目录数量: ${toc.length}`, 'info').catch(() => {});

            // 构建书籍信息
            const metadata = book.metadata || {};
            const bookInfo: BookInfo = {
                title: metadata.title || _extractFileName(filePath),
                author: Array.isArray(metadata.author) ? metadata.author.join(', ') : undefined,
                publisher: metadata.publisher,
                language: metadata.language,
                description: metadata.description,
                pageCount: book.sections?.filter(s => s.linear !== 'no').length || 1,
                format: 'mobi',
                coverImage: await _getCoverImage(book),
            };

            const sectionCount = bookInfo.pageCount || 1;

            // 使用传入的 existingBookId，或者生成新的 quickId (此处逻辑保持一致)
            // 如果是 fast path 进来的，bookId 已经确定
            // 如果是 slow path，我们也使用 quickBookId 以保持一致
            const bookId = existingBookId || generateQuickBookId(filePath);
            state.bookId = bookId;

            // 异步保存元数据到缓存
            mobiCacheService.saveMetadata(bookId, {
                bookInfo,
                toc,
                sectionCount,
            }).catch(err => logError('[MobiLifecycle] 保存元数据失败', err));

            state.isReady = true;
            state.bookInfo = bookInfo;
            state.toc = toc;
            state.sectionCount = sectionCount;

            await log(`[MobiRenderer] 文档加载完成`, 'info', {
                filePath,
                tocCount: toc.length,
                sectionsCount: book.sections?.length || 0,
                bookId
            }).catch(() => {});

            logError(`[MobiLifecycle] 书籍加载完成，总耗时: ${Date.now() - startTime}ms，章节数: ${sectionCount}`).catch(() => { });

            // 将已加载的书籍存入全局缓存，避免下次进入时重复加载
            // 大文件导入场景跳过缓存存储，避免内存累积导致 OOM
            if (!_skipPreloaderCache) {
                mobiPreloader.set(filePath, state.book);
            } else {
                logError(`[MobiLifecycle] 跳过预加载缓存存储（大文件导入模式）`).catch(() => { });
            }

            return bookInfo;
        } catch (error) {
             await logError(`[MobiRenderer] 加载失败`, {
                error: String(error),
                stack: (error as Error)?.stack,
                filePath,
            }).catch(() => {});
            throw error;
        }
    };

    /**
     * 加载 MOBI 文档
     * @param filePath 文件路径
     * @param options 加载选项
     */
    const loadDocument = async (filePath: string, options?: MobiLoadDocumentOptions): Promise<BookInfo> => {
        // 设置是否跳过缓存存储
        _skipPreloaderCache = options?.skipPreloaderCache || false;
        
        // 1. 生成 Quick ID
        const bookId = generateQuickBookId(filePath);
        state.bookId = bookId;
        state.filePath = filePath;

        // 2. 优先尝试从预加载缓存获取
        const preloadedBook = await mobiPreloader.get(filePath);
        if (preloadedBook) {
            await log(`[MobiLifecycle] 命中预加载缓存: ${filePath}`, 'info').catch(() => {});
            
            // 使用预加载的书籍对象
            state.book = preloadedBook;
            
            // 构建 toc
            let toc = _convertToc(preloadedBook, preloadedBook.toc || []);
            if (toc.length === 0 && preloadedBook.landmarks && preloadedBook.landmarks.length > 0) {
                toc = preloadedBook.landmarks.map((lm, i) => ({
                    title: lm.label || `章节 ${i + 1}`,
                    location: lm.href || '',
                    level: 0,
                }));
            }
            if (toc.length === 0 && preloadedBook.sections && preloadedBook.sections.length > 0) {
                toc = await _buildTocFromSections(preloadedBook);
            }
            
            // 构建书籍信息
            const metadata = preloadedBook.metadata || {};
            const bookInfo: BookInfo = {
                title: metadata.title || _extractFileName(filePath),
                author: Array.isArray(metadata.author) ? metadata.author.join(', ') : undefined,
                publisher: metadata.publisher,
                language: metadata.language,
                description: metadata.description,
                pageCount: preloadedBook.sections?.filter(s => s.linear !== 'no').length || 1,
                format: 'mobi',
                coverImage: await _getCoverImage(preloadedBook),
            };
            
            const sectionCount = bookInfo.pageCount || 1;
            
            state.isReady = true;
            state.bookInfo = bookInfo;
            state.toc = toc;
            state.sectionCount = sectionCount;
            
            // 异步保存元数据到缓存
            mobiCacheService.saveMetadata(bookId, {
                bookInfo,
                toc,
                sectionCount,
            }).catch(err => logError('[MobiLifecycle] 保存元数据失败', err));
            
            return bookInfo;
        }

        // 3. 检查元数据缓存 (Fast Path)
        const metadata = await mobiCacheService.getMetadata(bookId);
        if (metadata) {
             await log(`[MobiLifecycle] 命中元数据缓存: ${bookId}`, 'info').catch(() => {});
             
             // 恢复状态
             state.bookInfo = metadata.bookInfo;
             state.toc = metadata.toc;
             state.sectionCount = metadata.sectionCount;
             state.isReady = true; // 标记就绪，此时 book 为 null

             return metadata.bookInfo;
        }

        // 4. 缓存未命中，执行完整加载
        await log(`[MobiLifecycle] 元数据未命中，执行完整加载`, 'info').catch(() => {});
        const loadOp = _loadBook(filePath, bookId);
        _loadPromise = loadOp.then(() => {});
        return loadOp;
    };

    /**
     * 确保书籍已完全加载
     */
    const ensureBookLoaded = async (): Promise<void> => {
        if (state.book) return;
        if (!_loadPromise && state.filePath && state.bookId) {
            const loadOp = _loadBook(state.filePath, state.bookId);
            _loadPromise = loadOp.then(() => {});
        }
        if (_loadPromise) {
            await _loadPromise;
        }
    };

    /**
     * 重置/销毁
     */
    const reset = async () => {
        if (state.book) {
            try {
                state.book.destroy();
            } catch { }
            state.book = null;
        }

        state.isReady = false;
        state.bookInfo = null;
        state.toc = [];
        state.sectionCount = 0;
        state.bookId = null;
        state.filePath = null;
        _loadPromise = null;
    };

    return {
        state,
        loadDocument,
        ensureBookLoaded,
        reset,
    };
}

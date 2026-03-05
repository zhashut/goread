import type { IBookRenderer } from '../../formats/types';
import type { TTSVisibleStart } from '../types';
import { log, logError } from '../../index';

export type TTSDocumentData =
  | { type: 'dom'; doc: Document | Element }
  | { type: 'text'; text: string }
  | null;

export class TTSRendererAdapter {
  #renderer: IBookRenderer;

  constructor(renderer: IBookRenderer) {
    this.#renderer = renderer;
  }

  getDocumentData(): TTSDocumentData {
    const renderer = this.#renderer as any;
    const hasFn = typeof renderer.getTTSDocument === 'function';
    const currentPage = typeof renderer.getCurrentPage === 'function' ? renderer.getCurrentPage() : '?';
    const totalPages = typeof renderer.getPageCount === 'function' ? renderer.getPageCount() : '?';
    log(
      `[TTS] #getDocumentData: hasTTSDocument=${hasFn}, rendererType=${renderer?.constructor?.name ?? 'unknown'}, page=${currentPage}/${totalPages}`,
      'info',
    );
    if (hasFn) {
      const data = renderer.getTTSDocument();
      if (data) {
        const preview =
          data.type === 'text'
            ? `text(${data.text.length}字) "${data.text.substring(0, 50)}..."`
            : `dom(textLen=${(data.doc as Element).textContent?.length ?? 0})`;
        log(`[TTS] #getDocumentData 返回: type=${data.type}, ${preview}`, 'info');
      } else {
        log(`[TTS] #getDocumentData 返回: null (page=${currentPage})`, 'warn');
      }
      return data;
    }
    log('[TTS] #getDocumentData: 渲染器无 getTTSDocument 方法', 'warn');
    return null;
  }

  async getDocumentDataWithRetry(maxRetries: number, retryDelayMs: number): Promise<TTSDocumentData> {
    let docData = this.getDocumentData();
    if (!docData) {
      for (let i = 0; i < maxRetries; i++) {
        log(`[TTS] getTTSDocument 返回空，等待重试 (${i + 1}/${maxRetries})`, 'warn');
        await new Promise((r) => setTimeout(r, retryDelayMs));
        docData = this.getDocumentData();
        if (docData) break;
      }
      if (!docData) {
        log('[TTS] getTTSDocument 多次重试后仍为空', 'warn');
        return null;
      }
    }
    return docData;
  }

  getVisibleStart(): TTSVisibleStart | null {
    const renderer = this.#renderer as any;
    if (typeof renderer.getVisibleStartForTTS === 'function') {
      try {
        return renderer.getVisibleStartForTTS();
      } catch (err) {
        log(`[TTS] getVisibleStartForTTS() 异常，降级为从头开始: ${err}`, 'warn');
        return null;
      }
    }
    return null;
  }

  async advanceForTTS(onError?: (err: unknown) => void): Promise<boolean> {
    const renderer = this.#renderer as any;
    if (typeof renderer.advanceForTTS !== 'function') return false;
    try {
      return await renderer.advanceForTTS();
    } catch (err) {
      if (onError) {
        onError(err);
      } else {
        logError('[TTS] advanceForTTS error', err);
      }
      return false;
    }
  }
}

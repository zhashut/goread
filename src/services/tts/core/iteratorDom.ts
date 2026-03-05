import type { TTSVisibleStart } from '../types';
import { TTS } from '../../../lib/foliate-js/tts.js';
import { textWalker } from '../../../lib/foliate-js/text-walker.js';

export class DomSSMLIterator {
  #source: Document | Element;
  #onHighlight: (range: Range) => void;
  #tts: TTS | null = null;

  constructor(source: Document | Element, onHighlight: (range: Range) => void) {
    this.#source = source;
    this.#onHighlight = onHighlight;
  }

  start(visibleStart?: TTSVisibleStart | null): { ssml: string | null; usedFrom: boolean; fromError?: unknown } {
    const doc = 'body' in this.#source ? (this.#source as Document) : this.#wrapElementAsDoc(this.#source);

    this.#tts = new TTS(doc, textWalker, this.#onHighlight, 'sentence');

    let ssml: string | undefined;
    let usedFrom = false;
    let fromError: unknown;
    if (visibleStart?.type === 'range') {
      try {
        ssml = this.#tts.from(visibleStart.range);
        usedFrom = true;
      } catch (err) {
        fromError = err;
        ssml = undefined;
      }
    }
    if (!ssml) {
      ssml = this.#tts.start();
    }
    return { ssml: ssml ?? null, usedFrom, fromError };
  }

  next(): string | null {
    if (!this.#tts) return null;
    return this.#tts.next() ?? null;
  }

  getRangesSnapshot(): Map<string, Range> {
    return this.#tts?.getRanges() ?? new Map();
  }

  setMark(mark: string): void {
    this.#tts?.setMark(mark);
  }

  dispose(): void {
    this.#tts = null;
  }

  #wrapElementAsDoc(el: Element): any {
    const ownerDoc = el.ownerDocument!;
    return {
      body: el,
      createTreeWalker: (root: Node, whatToShow?: number, filter?: NodeFilter | null) =>
        ownerDoc.createTreeWalker(root, whatToShow, filter),
      createRange: () => ownerDoc.createRange(),
    };
  }
}

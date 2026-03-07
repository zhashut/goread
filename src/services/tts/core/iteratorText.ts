import type { TTSVisibleStart } from '../types';
import { TextBlockIterator } from '../ssmlParser';

export class TextSSMLIterator {
  #iter: TextBlockIterator;

  constructor(text: string) {
    this.#iter = new TextBlockIterator(text);
  }

  start(visibleStart?: TTSVisibleStart | null): string | null {
    if (visibleStart?.type === 'offset' && visibleStart.offset > 0) {
      return this.#iter.startFrom(visibleStart.offset);
    }
    return this.#iter.start();
  }

  next(): string | null {
    return this.#iter.next();
  }
}


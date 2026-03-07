export class PrefetchAdvanceManager {
  #prefetchedSSML: string | null = null;
  #prefetchPromise: Promise<void> | null = null;
  #advancePending: Promise<boolean> | null = null;

  prefetch(getNext: () => string | null, onEmptyPrefetch: () => void): void {
    if (this.#prefetchedSSML !== null || this.#prefetchPromise) return;

    this.#prefetchPromise = (async () => {
      const ssml = getNext();
      this.#prefetchedSSML = ssml ?? null;
      if (this.#prefetchedSSML === null && !this.#advancePending) {
        onEmptyPrefetch();
      }
    })();
  }

  async awaitPrefetch(): Promise<void> {
    if (!this.#prefetchPromise) return;
    await this.#prefetchPromise;
    this.#prefetchPromise = null;
  }

  consumePrefetched(): string | null {
    if (!this.#prefetchedSSML) return null;
    const ssml = this.#prefetchedSSML;
    this.#prefetchedSSML = null;
    return ssml;
  }

  setAdvancePending(promise: Promise<boolean>): void {
    this.#advancePending = promise;
  }

  async consumeAdvanceResult(): Promise<boolean> {
    if (!this.#advancePending) return false;
    const p = this.#advancePending;
    this.#advancePending = null;
    return await p;
  }

  clear(): void {
    this.#prefetchedSSML = null;
    this.#prefetchPromise = null;
    this.#advancePending = null;
  }

  get hasAdvancePending(): boolean {
    return !!this.#advancePending;
  }
}


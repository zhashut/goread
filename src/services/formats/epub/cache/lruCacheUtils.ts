export function isIdleExpired(lastAccessTime: number | undefined, timeToIdleSecs: number): boolean {
  if (timeToIdleSecs <= 0) return false;
  if (!lastAccessTime) return false;
  const now = Date.now();
  const idleMs = timeToIdleSecs * 1000;
  return now - lastAccessTime > idleMs;
}

export function evictOldestEntry<K, V>(
  map: Map<K, V>,
  options?: {
    canEvict?: (entry: V, key: K) => boolean;
    onEvict?: (entry: V, key: K) => void;
  }
): boolean {
  if (map.size === 0) return false;

  for (const [key, value] of map.entries()) {
    if (options?.canEvict && !options.canEvict(value, key)) {
      continue;
    }
    map.delete(key);
    if (options?.onEvict) {
      options.onEvict(value, key);
    }
    return true;
  }

  return false;
}

export function touchEntryAsMostRecentlyUsed<K, V>(
  map: Map<K, V>,
  key: K,
  update?: (entry: V) => void
): V | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (update) {
    update(entry);
  }
  map.delete(key);
  map.set(key, entry);
  return entry;
}


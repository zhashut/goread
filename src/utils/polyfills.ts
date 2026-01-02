if (!(Object as any).groupBy) {
  (Object as any).groupBy = (items: any[], callback: (item: any) => any) => {
    const result: Record<string, any[]> = {};
    for (const item of items) {
      const key = callback(item);
      const k = String(key);
      if (!result[k]) {
        result[k] = [];
      }
      result[k].push(item);
    }
    return result;
  };
}

if (!(Map as any).groupBy) {
  (Map as any).groupBy = (items: Iterable<any>, callback: (item: any) => any) => {
    const result = new Map<any, any[]>();
    if (!items) return result;
    for (const item of items) {
      const key = callback(item);
      const group = result.get(key);
      if (group) {
        group.push(item);
      } else {
        result.set(key, [item]);
      }
    }
    return result;
  };
}


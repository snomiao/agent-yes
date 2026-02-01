export function signleton<T>(fn: () => T): T {
  const key = String(fn);
  const g = globalThis as typeof globalThis & { __singleton_store?: Map<string, any>; };
  g.__singleton_store ??= new Map<string, any>();
  if (!g.__singleton_store.has(key)) g.__singleton_store.set(key, fn());
  return g.__singleton_store.get(key);
}

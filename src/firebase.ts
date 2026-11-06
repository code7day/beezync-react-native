export function getBeezyncId(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const s = source as { data?: unknown; bz_id?: unknown };
  const data = typeof s.data === 'object' && s.data !== null ? (s.data as Record<string, unknown>) : (s as Record<string, unknown>);
  const id = data.bz_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

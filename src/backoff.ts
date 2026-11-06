export function backoffDelay(attempt: number, min: number, max: number, random: () => number): number {
  const base = Math.min(max, min * 2 ** Math.max(0, attempt));
  const jittered = base * (0.8 + 0.4 * random());
  return Math.round(Math.min(max, Math.max(min, jittered)));
}

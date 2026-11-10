/** Seconds as `m:ss`, or `h:mm:ss` from one hour. A bad value (NaN, negative, Infinity) is `0:00`. */
export function formatVideoTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A position in `[0, duration]` for a touch at `x` on a track `width` wide. */
export function positionFromTouch(x: number, width: number, duration: number): number {
  if (!(width > 0) || !(duration > 0)) return 0;
  return Math.min(1, Math.max(0, x / width)) * duration;
}

/** A time moved by `delta` seconds and kept inside the video. An unknown duration (0) sets no upper limit. */
export function skipTime(current: number, delta: number, duration: number): number {
  const next = Math.max(0, current + delta);
  return duration > 0 ? Math.min(duration, next) : next;
}

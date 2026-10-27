/** "Oct 27 · 1:15 pm" in the phone's own time zone. */
export function fmtWhen(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}
/** A length, never mistakable for a clock time: "27 s", "19 min", "1 h 53". */
export function fmtLength(sec?: number): string {
  const s = Math.round(sec || 0);
  if (s <= 0) return "";
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

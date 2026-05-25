/** Converte "30s", "2m", "1h" ou numero em ms. */
export function parseIntervalMs(raw: string | undefined, fallbackMs = 60_000): number {
  const s = (raw ?? "").trim();
  if (!s) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/i.exec(s);
  if (!m) {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? fallbackMs : n * 1000;
  }
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "h") return Math.round(n * 3600_000);
  if (unit === "m") return Math.round(n * 60_000);
  return Math.round(n * 1000);
}

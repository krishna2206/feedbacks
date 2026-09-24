/** Locale-aware date helpers (pass the active i18n language). */
export function timeAgo(ts: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const diff = (Date.now() - ts) / 1000;
  if (diff < 45) return rtf.format(0, "second");
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), "hour");
  if (diff < 7 * 86400) return rtf.format(-Math.round(diff / 86400), "day");
  return shortDate(ts, locale);
}

export const clock = (ts: number, locale: string) => new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
export const shortDate = (ts: number, locale: string) => new Date(ts).toLocaleDateString(locale, { day: "numeric", month: "short" });

export function dayKey(ts: number) {
  return new Date(ts).toDateString();
}

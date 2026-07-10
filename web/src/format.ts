// SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone.
// Normalize to an ISO string the browser parses as UTC.
export function formatDate(iso: string): string {
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

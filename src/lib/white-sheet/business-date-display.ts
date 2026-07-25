/**
 * Present a canonical business_date (YYYY-MM-DD, Asia/Bangkok calendar day)
 * in Thai-readable form without changing the value sent to the backend.
 *
 * Parsing uses UTC noon so browser local timezone cannot shift the calendar day.
 */
export function formatBusinessDateThai(businessDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    utcNoon.getUTCFullYear() !== year
    || utcNoon.getUTCMonth() !== month - 1
    || utcNoon.getUTCDate() !== day
  ) {
    return null;
  }

  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utcNoon);
}

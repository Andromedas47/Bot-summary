export function formatThaiDate(dateStr: string): string {
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(dateStr + "T00:00:00"));
}

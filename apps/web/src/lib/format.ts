/** The API reports age as { years, estimated }, or occasionally a plain number/string. */
export type AgeValue = { years?: number | null; months?: number | null; days?: number | null; estimated?: boolean } | number | string | null | undefined;

export function ageText(a: AgeValue): string {
  if (a === null || a === undefined || a === "") return "";
  if (typeof a === "number" || typeof a === "string") return `${a} y`;
  const { years, months, days, estimated } = a;
  const base = typeof years === "number" ? (years >= 1 ? `${years} y` : typeof months === "number" && months >= 1 ? `${months} mo` : typeof days === "number" ? `${days} d` : "<1 y") : "";
  return base ? `${base}${estimated ? " (est.)" : ""}` : "";
}

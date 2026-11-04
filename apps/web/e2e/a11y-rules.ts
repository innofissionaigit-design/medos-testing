/**
 * A rule-based accessibility self-check that runs inside the page (Playwright `page.evaluate`). It is NOT a substitute for an
 * accessibility audit by a specialist with assistive technology: it only finds mechanical problems (missing names, labels, alt text,
 * landmarks, heading jumps, low text contrast, duplicate ids, keyboard traps in dialogs).
 */
export interface A11yIssue { rule: string; where: string; detail: string }

export function runA11yRules(): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}` : "";
    const txt = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${txt ? ` "${txt}"` : ""}`;
  };
  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el as HTMLElement);
    const r = (el as HTMLElement).getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0 && !el.closest("[aria-hidden='true']");
  };
  const add = (rule: string, el: Element | null, detail: string): void => { issues.push({ rule, where: el ? describe(el) : "page", detail }); };
  const textOf = (id: string): string => (document.getElementById(id)?.textContent ?? "").trim();
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map(textOf).join(" ").trim(); if (t) return t; }
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (el.labels && Array.from(el.labels).some((l) => (l.textContent ?? "").trim())) return "label";
      if (el.getAttribute("title")?.trim()) return el.getAttribute("title") as string;
      if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type) && el.value) return el.value;
      if (el instanceof HTMLInputElement && el.placeholder) return ""; // a placeholder is not a name
      return "";
    }
    const t = (el.textContent ?? "").trim();
    if (t) return t;
    if (el.querySelector("img[alt]:not([alt=''])")) return "img";
    return el.getAttribute("title")?.trim() ?? "";
  };

  if (!document.documentElement.lang) add("page-language", document.documentElement, "the <html> element has no lang attribute");
  if (!document.title.trim()) add("page-title", null, "the page has no title");
  if (!document.querySelector("main, [role='main']")) add("landmark-main", null, "no <main> landmark");
  if (document.querySelectorAll("h1").length !== 1) add("heading-h1", null, `${document.querySelectorAll("h1").length} <h1> elements (expected exactly 1)`);

  let prev = 0;
  for (const h of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(visible)) {
    const lvl = Number(h.tagName[1]);
    if (prev && lvl > prev + 1) add("heading-order", h, `heading jumps from h${prev} to h${lvl}`);
    prev = lvl;
  }
  for (const img of Array.from(document.querySelectorAll("img")).filter(visible)) if (!img.hasAttribute("alt")) add("image-alt", img, "image without an alt attribute");
  for (const el of Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea")).filter(visible)) if (!nameOf(el)) add("form-label", el, "form field without a label");
  for (const el of Array.from(document.querySelectorAll("button, [role=button]")).filter(visible)) if (!nameOf(el)) add("button-name", el, "button without a name");
  for (const el of Array.from(document.querySelectorAll("a[href]")).filter(visible)) if (!nameOf(el)) add("link-name", el, "link without a name");
  for (const el of Array.from(document.querySelectorAll("[tabindex]"))) if (Number(el.getAttribute("tabindex")) > 0) add("tabindex", el, "positive tabindex changes the natural keyboard order");
  const ids = new Map<string, number>();
  for (const el of Array.from(document.querySelectorAll("[id]"))) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) add("duplicate-id", document.getElementById(id), `id "${id}" used ${n} times`);
  for (const d of Array.from(document.querySelectorAll("[role=dialog], dialog")).filter(visible)) {
    if (!nameOf(d)) add("dialog-name", d, "dialog without an accessible name");
    if (!d.querySelector("button, [href], input, select, textarea, [tabindex]")) add("dialog-focusable", d, "dialog with nothing to focus");
  }
  for (const t of Array.from(document.querySelectorAll("table")).filter(visible)) {
    if (!t.querySelector("th")) add("table-headers", t, "data table without header cells");
  }

  // Text contrast (WCAG 2.1 AA: 4.5:1, or 3:1 for large text), measured against the nearest opaque background.
  const parse = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = (m[1] as string).split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const lum = ([r, g, b]: number[]): number => { const f = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number); };
  const bgOf = (el: Element): [number, number, number] => {
    for (let e: Element | null = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0.95) return [c[0], c[1], c[2]]; }
    return [255, 255, 255];
  };
  const seen = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("body *")).filter(visible)) {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim()).length > 0;
    if (!own) continue;
    const s = getComputedStyle(el as HTMLElement);
    const fg = parse(s.color); if (!fg) continue;
    const bg = bgOf(el);
    const a = fg[3];
    const mixed = [0, 1, 2].map((i) => Math.round((fg[i] as number) * a + bg[i]! * (1 - a)));
    const l1 = lum(mixed); const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const px = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) {
      const key = `${s.color}|${JSON.stringify(bg)}|${need}`;
      if (!seen.has(key)) { seen.add(key); add("color-contrast", el, `contrast ${ratio.toFixed(2)}:1 (needs ${need}:1), text ${s.color} on rgb(${bg.join(",")})`); }
    }
  }
  return issues;
}

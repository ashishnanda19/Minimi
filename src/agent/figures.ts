/**
 * The facts worth checking in an answer: prices, percentages and version numbers. Extracted the same way from
 * answers, memory and web snippets, so "does the source say this?" becomes a set lookup, not a judgement call.
 */

export type FigureKind = "money" | "percent" | "version";

export interface Figure {
  /** Exactly as written in the text, e.g. "$1,200" */
  raw: string;
  kind: FigureKind;
  /** Normalised so "$20", "$20.00" and "20 USD" compare equal. */
  value: string;
  index: number;
}

const SCALE: Record<string, number> = { k: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

function normalise(digits: string, scale?: string): string {
  const n = Number(digits.replace(/,/g, "")) * (scale ? SCALE[scale.toLowerCase()] ?? 1 : 1);
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : digits;
}

export const keyOf = (f: Pick<Figure, "kind" | "value">) => `${f.kind}:${f.value}`;

export function extractFigures(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(/(?:US\$|[$€£₹])\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s?(k|m|bn|million|billion)\b)?|(\d(?:[\d,]*\d)?(?:\.\d+)?)\s?(USD|EUR|GBP|INR|dollars?|euros?)\b/gi)) {
    out.push({ raw: m[0], kind: "money", value: normalise(m[1] ?? m[3]!, m[2]), index: m.index ?? 0 });
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) out.push({ raw: m[0], kind: "percent", value: normalise(m[1]!), index: m.index ?? 0 });
  for (const m of text.matchAll(/\bv(\d+(?:\.\d+){0,3})\b|\b(\d+\.\d+\.\d+)\b/g)) {
    out.push({ raw: m[0], kind: "version", value: m[1] ?? m[2]!, index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

export const figureKeys = (text: string): Set<string> => new Set(extractFigures(text).map(keyOf));

/** "4 seats x $20 = $80", "$20 + $5": a figure the model computed from quoted ones is not an invention. */
export function isDerived(figure: Figure, known: Figure[]): boolean {
  if (figure.kind !== "money") return false;
  const v = Number(figure.value);
  const nums = [...new Set(known.filter((k) => k.kind === "money").map((k) => Number(k.value)))].filter((n) => n > 0);
  const multiple = nums.some((n) => Number.isInteger(v / n) && v / n >= 2 && v / n <= 36);
  const sum = nums.some((a) => nums.some((b) => Math.abs(a + b - v) < 1e-9));
  const diff = nums.some((a) => nums.some((b) => a > b && Math.abs(a - b - v) < 1e-9));
  return multiple || sum || diff;
}

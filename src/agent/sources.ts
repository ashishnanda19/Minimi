import type { SourceRef } from "../store/db.js";
import type { EvidenceSource } from "./verify.js";

export interface SearchLogEntry {
  query: string;
  since?: string;
  ms: number;
  cached: boolean;
  results: number;
  error?: string;
}

/** Some models (gpt-oss) cite as 【1†L1-L3】 whatever the prompt says. Fold every such form into [1]. */
export const normalizeCitations = (text: string): string => text.replace(/【\s*(\d+)[^】]*】/g, "[$1]");

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * One registry per chat turn. Parallel tool calls all register here, so citation
 * numbers [1], [2]... are unique and stable within the answer. The model never
 * invents or renumbers them, which removes a whole class of citation errors.
 */
export class SourceRegistry {
  private readonly byUrl = new Map<string, SourceRef>();
  private readonly text = new Map<number, string>();
  readonly log: SearchLogEntry[] = [];

  register(item: { title: string; url: string; published?: string; text?: string }): number {
    const key = normalizeUrl(item.url);
    const existing = this.byUrl.get(key);
    if (existing) {
      if (!existing.published && item.published) existing.published = item.published;
      if (item.text && !(this.text.get(existing.id) ?? "").includes(item.text)) this.text.set(existing.id, `${this.text.get(existing.id) ?? ""} ${item.text}`.trim());
      return existing.id;
    }
    const id = this.byUrl.size + 1;
    this.byUrl.set(key, { id, title: item.title, url: item.url, published: item.published });
    if (item.text) this.text.set(id, item.text);
    return id;
  }

  /** Everything the model was shown, with the snippet text, so the answer can be checked against it. */
  evidence(): EvidenceSource[] {
    return this.all().map((s) => ({ id: s.id, url: s.url, title: s.title, published: s.published, text: this.text.get(s.id) ?? "" }));
  }

  all(): SourceRef[] {
    return [...this.byUrl.values()];
  }

  /** Only sources the answer actually cites, in citation order. Handles [1], [1][2] and [1, 2]. */
  cited(answer: string): SourceRef[] {
    const ids = new Set<number>();
    for (const m of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
      for (const n of m[1]!.split(",")) ids.add(Number(n.trim()));
    }
    return this.all().filter((s) => ids.has(s.id)).sort((a, b) => a.id - b.id);
  }
}

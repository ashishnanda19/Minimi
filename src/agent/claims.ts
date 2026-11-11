import { extractFigures } from "./figures.js";
import { hostOf } from "./sources.js";
import { formatDay, civilOf } from "./temporal.js";
import type { SourceRef, StoredMessage } from "../store/db.js";

/**
 * "Is your answer still correct?" is only answerable claim by claim. This turns an earlier answer into a checklist:
 * which entity, which figure, when it was said, where it came from. The checklist goes into the prompt, and after
 * the answer is written we check that every entity on it was actually addressed.
 */

export interface PriorClaim {
  entity: string;
  /** The sentence or table row that made the claim, citations stripped. */
  text: string;
  figures: string[];
  domains: string[];
  when: Date;
}

const OPENERS = new Set(["for", "the", "a", "an", "in", "on", "as", "if", "it", "this", "that", "here", "there", "today", "short", "so", "and", "but", "also", "note", "yes", "no", "overall", "currently", "based", "according", "my", "i", "you", "we"]);
const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

function entityOf(unit: string): string {
  // "For a small SaaS: Neon has ..." leads in with a label, while "Zoho CRM: Standard is ..." names the entity. Only the former starts with a filler word.
  const colon = unit.indexOf(":");
  if (colon > 0 && colon < 40 && OPENERS.has(unit.split(/\s+/)[0]!.replace(/\W/g, "").toLowerCase())) unit = unit.slice(colon + 1).trim();
  const tokens = unit.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/^[("'*_]+|[)"'*_:,;]+$/g, "");
    if (!/^[A-Z][A-Za-z0-9.+\-/'’]*$/.test(t) || OPENERS.has(t.toLowerCase())) continue;
    const parts = [t];
    for (let j = i + 1; j < tokens.length && parts.length < 3; j++) {
      const n = tokens[j]!.replace(/^[("'*_]+|[)"'*_:,;]+$/g, "");
      if (/^[A-Z][A-Za-z0-9.+\-/'’]*$/.test(n) && !OPENERS.has(n.toLowerCase())) parts.push(n);
      else break;
    }
    return parts.join(" ").replace(/['’]s$/, "");
  }
  return tokens.slice(0, 3).join(" ");
}

export function extractClaims(answer: string, sources: SourceRef[], when: Date): PriorClaim[] {
  const byId = new Map(sources.map((s) => [s.id, hostOf(s.url)]));
  const claims: PriorClaim[] = [];
  const units = answer
    .split("\n")
    .flatMap((line) => {
      if (/^\s*\|?\s*:?-{2,}/.test(line)) return []; // table separator row
      if (line.includes("|")) {
        const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
        return cells.length > 1 ? [cells.join(" ")] : [];
      }
      return line.split(/(?<=[.!?;])\s+/);
    });

  for (const raw of units) {
    const domains = [...raw.matchAll(CITATION)].flatMap((m) => m[1]!.split(",").map((n) => byId.get(Number(n.trim())))).filter((d): d is string => Boolean(d));
    const text = raw.replace(CITATION, "").replace(/\*\*|__|`/g, "").replace(/^[\s\-*•\d.)]+/, "").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
    const figures = [...new Set(extractFigures(text).map((f) => f.raw))];
    if (!figures.length || text.length < 8) continue;
    claims.push({ entity: entityOf(text), text: text.slice(0, 220), figures, domains: [...new Set(domains)], when });
  }
  return claims;
}

/** Newest claim per entity+figure set; capped so the prompt stays small. */
export function dedupeClaims(claims: PriorClaim[], max = 14): PriorClaim[] {
  const seen = new Map<string, PriorClaim>();
  for (const c of [...claims].sort((a, b) => b.when.getTime() - a.when.getTime())) {
    const key = `${c.entity.toLowerCase()}|${c.figures.join(",")}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()].slice(0, max);
}

export function gatherClaims(messages: StoredMessage[]): PriorClaim[] {
  return dedupeClaims(messages.filter((m) => m.role === "assistant").flatMap((m) => extractClaims(m.content, m.sources, m.createdAt)));
}

export function claimsBlock(claims: PriorClaim[], tz: string): string {
  return claims
    .map((c) => `[said ${formatDay(civilOf(c.when, tz))}] ${c.entity}: "${c.text}"${c.domains.length ? ` (src: ${c.domains.join(", ")})` : ""}`)
    .join("\n");
}

const key = (entity: string) => entity.toLowerCase().split(/\s+/)[0]!.replace(/[^a-z0-9]/g, "");

/** Entities from earlier claims that the new answer never mentions: those were silently skipped. */
export function uncoveredEntities(claims: PriorClaim[], answer: string): string[] {
  const text = answer.toLowerCase();
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const c of claims) {
    const k = key(c.entity);
    if (k.length < 3 || seen.has(k)) continue;
    seen.add(k);
    if (!text.includes(k)) missing.push(c.entity);
  }
  return missing;
}

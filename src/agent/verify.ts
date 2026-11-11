import { extractFigures, figureKeys, isDerived, keyOf, type Figure } from "./figures.js";
import { uncoveredEntities, type PriorClaim } from "./claims.js";
import { keywordsOf } from "./retrieval.js";

/**
 * Checks an answer against the evidence it was written from, with no model involved. Every price, percentage and
 * version number must be traceable to a source the answer cites, to what the user already said or was told, or be
 * simple arithmetic on those. Anything else is flagged, and the agent gets one chance to repair it.
 */

export interface EvidenceSource {
  id: number;
  url: string;
  title: string;
  published?: string;
  text: string;
}

export type FigureStatus = "supported" | "memory" | "derived" | "misattributed" | "unsupported";

export interface FigureCheck {
  figure: string;
  status: FigureStatus;
  cited: number[];
  foundIn: number[];
}

export interface VerificationReport {
  /** True when nothing needs the user's attention. */
  ok: boolean;
  figures: FigureCheck[];
  /** Citation numbers the answer uses that match no source. */
  dangling: number[];
  /** Dates the answer attributes to a source ("published 4 Nov") that no source shows. */
  unsupportedDates: string[];
  /** Entities from the earlier answer that this answer never addressed (re-verification only). */
  uncovered: string[];
  /** The agent searched and got results, but the answer cites none of them. */
  uncited: boolean;
  checked: number;
  verified: number;
}

export interface VerifyInput {
  answer: string;
  evidence: EvidenceSource[];
  /** Everything the user already knew: the question, earlier answers, the conversation record. */
  memoryText: string;
  priorClaims?: PriorClaim[];
  searched: boolean;
  /** Recall turns quote memory on purpose, so memory alone is enough support. */
  recall?: boolean;
  reverify?: boolean;
  now: Date;
}

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
/** Wording that frames a figure as something said earlier, not as the current state. */
const AS_OLD = /\b(you|i|we) (asked|said|told|answered|mentioned|gave|quoted|noted|highlighted|recommended|suggested|listed|stated|shortlisted)\b|\b(earlier|previously|before|originally|back then|at the time|at that time|a while back|last time|was|were|then)\b|→|->|\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
/** Verbs that attribute a date to a source. A bare "on" is not one: "On Tue 3 Nov you asked..." dates the conversation, not a web page. */
const DATE_VERB = /\b(published|dated|announced|released|launched|shipped|updated|posted)\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const idsIn = (text: string): number[] => [...text.matchAll(CITATION)].flatMap((m) => m[1]!.split(",").map((n) => Number(n.trim())));

/**
 * Sentences, bullets and table rows: the unit in which a citation is expected to sit beside its figure.
 * A full stop only ends a sentence when whitespace follows, so "$0.106" and "26.13.0" stay in one piece.
 */
function units(answer: string): { text: string }[] {
  return answer.split("\n").flatMap((line) =>
    line.includes("|") ? [{ text: line }] : line.split(/(?<=[.!?;])\s+/).filter((t) => t.trim()).map((text) => ({ text })),
  );
}

/** Dates written in text, as ISO strings (year inferred as the most recent that is not in the future). */
export function datesIn(text: string, now: Date): Set<string> {
  const out = new Set<string>();
  const add = (y: number | undefined, m: number, d: number) => {
    let year = y ?? now.getUTCFullYear();
    let t = Date.UTC(year, m, d);
    if (y === undefined && t > now.getTime() + 86_400_000) { year -= 1; t = Date.UTC(year, m, d); }
    if (new Date(t).getUTCDate() === d) out.add(new Date(t).toISOString().slice(0, 10));
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(+m[1]!, +m[2]! - 1, +m[3]!);
  const mon = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${mon})\\b(?:,?\\s+(\\d{4}))?`, "gi"))) add(m[3] ? +m[3] : undefined, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()), +m[1]!);
  for (const m of text.matchAll(new RegExp(`\\b(${mon})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"))) add(m[3] ? +m[3] : undefined, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()), +m[2]!);
  return out;
}

export function verifyAnswer(input: VerifyInput): VerificationReport {
  const { answer, evidence, memoryText, searched, now } = input;
  const evidenceKeys = new Map(evidence.map((e) => [e.id, figureKeys(`${e.title} ${e.text}`)]));
  const allEvidence = new Set([...evidenceKeys.values()].flatMap((s) => [...s]));
  // A remembered figure only vouches for a claim about the SAME thing: "$19" said about Neon must not excuse "$19" said about HubSpot.
  const memoryByKey = new Map<string, Set<string>[]>();
  for (const mu of units(memoryText)) {
    const words = new Set(keywordsOf(mu.text));
    for (const k of figureKeys(mu.text)) memoryByKey.set(k, [...(memoryByKey.get(k) ?? []), words]);
  }
  const memorySupports = (key: string, unitText: string) => {
    const candidates = memoryByKey.get(key);
    if (!candidates) return false;
    const mine = keywordsOf(unitText);
    return mine.length === 0 || candidates.some((words) => mine.some((w) => words.has(w))); // no content words ("I said $19 earlier"): nothing to contradict
  };
  const known: Figure[] = [...evidence.flatMap((e) => extractFigures(`${e.title} ${e.text}`)), ...extractFigures(memoryText)];
  const evidenceIds = new Set(evidence.map((e) => e.id));

  const figures: FigureCheck[] = [];
  const seen = new Set<string>();
  for (const u of units(answer)) {
    const cited = idsIn(u.text);
    for (const f of extractFigures(u.text)) {
      const dedupe = `${keyOf(f)}|${cited.join(",")}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const k = keyOf(f);
      const foundIn = evidence.filter((e) => evidenceKeys.get(e.id)!.has(k)).map((e) => e.id);
      let status: FigureStatus;
      if (cited.length && foundIn.some((id) => cited.includes(id))) status = "supported";
      else if (foundIn.length) status = cited.length ? "misattributed" : "supported";
      else if (memorySupports(k, u.text) && (input.recall || AS_OLD.test(u.text))) status = "memory";
      else if (isDerived(f, known)) status = "derived";
      else status = "unsupported";
      figures.push({ figure: f.raw, status, cited, foundIn });
    }
  }

  const dangling = [...new Set(idsIn(answer).filter((n) => !evidenceIds.has(n)))].sort((a, b) => a - b);

  const sourceDates = new Set<string>();
  for (const e of evidence) {
    if (e.published) sourceDates.add(e.published.slice(0, 10));
    for (const d of datesIn(e.text, now)) sourceDates.add(d);
  }
  const unsupportedDates: string[] = [];
  const conversationDates = datesIn(memoryText, now); // dates the user or the record already mention are not claims about a source
  if (evidence.length) {
    for (const u of units(answer)) {
      if (!DATE_VERB.test(u.text)) continue;
      const claimedCites = idsIn(u.text);
      if (!claimedCites.length) continue; // only dates attributed to a specific source are checkable
      for (const iso of datesIn(u.text, now)) if (!sourceDates.has(iso) && !conversationDates.has(iso) && !unsupportedDates.includes(iso)) unsupportedDates.push(iso);
    }
  }

  const uncovered = input.reverify && input.priorClaims?.length ? uncoveredEntities(input.priorClaims, answer) : [];
  const hasClaims = figures.length > 0 || (answer.length > 120 && !input.recall);
  const uncited = searched && evidence.length > 0 && hasClaims && idsIn(answer).length === 0;

  const good = (s: FigureStatus) => s === "supported" || s === "memory" || s === "derived";
  const bad = figures.filter((f) => !good(f.status));
  return {
    ok: bad.length === 0 && dangling.length === 0 && unsupportedDates.length === 0 && uncovered.length === 0 && !uncited,
    figures, dangling, unsupportedDates, uncovered, uncited,
    checked: figures.length,
    verified: figures.length - bad.length,
  };
}

/**
 * Fixes misattributed citations without a model: the checker knows which source actually states each figure, so a
 * wrong [8] becomes [3]. In a sentence with one figure the wrong numbers are replaced; with several, the right
 * source is added, so the other figures' citations stay. Cheaper and faster than asking a model to redo the answer.
 */
export function correctCitations(answer: string, report: VerificationReport): { answer: string; fixed: number } {
  const wrong = report.figures.filter((f) => f.status === "misattributed" && f.foundIn.length > 0 && f.foundIn.length <= 3);
  if (!wrong.length) return { answer, fixed: 0 };
  let out = answer;
  let fixed = 0;
  for (const u of units(answer)) {
    const here = wrong.filter((f) => u.text.includes(f.figure));
    if (!here.length || !CITATION.test(u.text)) continue;
    CITATION.lastIndex = 0;
    const figuresInUnit = new Set(extractFigures(u.text).map(keyOf)).size;
    const right = [...new Set(here.flatMap((f) => f.foundIn))].sort((a, b) => a - b);
    let text: string;
    if (figuresInUnit === 1) {
      let first = true;
      text = u.text.replace(CITATION, () => (first ? ((first = false), right.map((n) => `[${n}]`).join("")) : "")); // one clean group
    } else {
      const have = new Set(idsIn(u.text));
      const add = right.filter((n) => !have.has(n)).map((n) => `[${n}]`).join("");
      text = u.text.replace(/(\s*)([.;,:!?]*\s*)$/, `${add}$1$2`);
    }
    if (text !== u.text) { out = out.replace(u.text, text); fixed += here.length; }
  }
  return { answer: out, fixed };
}

/** One line per problem, written for the model that has to fix them. */
export function describeProblems(r: VerificationReport): string[] {
  const out: string[] = [];
  for (const f of r.figures) {
    if (f.status === "unsupported") out.push(`The figure "${f.figure}" appears in no source. If it came from an earlier answer of yours (see the earlier conversation), say so explicitly ("on <date> I said ${f.figure}") instead of presenting it as current. Otherwise remove it, or replace it with a figure the evidence supports, or say you could not verify it.`);
    if (f.status === "misattributed") out.push(`The figure "${f.figure}" is cited to ${f.cited.map((n) => `[${n}]`).join("")} but only appears in ${f.foundIn.map((n) => `[${n}]`).join("")}. Fix the citation.`);
  }
  for (const n of r.dangling) out.push(`Citation [${n}] does not exist. Use only the numbers in the evidence.`);
  for (const d of r.unsupportedDates) out.push(`The date ${d} is attributed to a source that does not show it. Remove the date or correct it.`);
  for (const e of r.uncovered) out.push(`"${e}" was in your earlier answer but this answer never addresses it. State whether it changed, is unchanged, or could not be verified.`);
  if (r.uncited) out.push("You searched but cited no source. Add [n] citations beside the facts they support.");
  return out;
}

import { extractFigures, figureKeys, isDerived, keyOf, type Figure } from "./figures.js";
import { uncoveredEntities, type PriorClaim } from "./claims.js";
import { keywordsOf, STOP } from "./retrieval.js";

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
  /** Said "nothing changed" on a turn that retrieved no web evidence at all (every search failed or found nothing). */
  unverifiedAbsence: boolean;
  /** "No change" claims contradicted by a source published inside the window that describes a change to the same thing. */
  overlooked: { subject: string; id: number; published: string; excerpt: string }[];
  /** Claims whose cited sources never mention the thing the claim is about (e.g. a Railway pricing claim citing a state government page). */
  weakCitations: { text: string; ids: number[]; subjects: string[]; pages: string[] }[];
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
  /** Start of the window the user asked about (YYYY-MM-DD). Sources published on or after it can contradict a "no change" claim. */
  windowStart?: string;
  now: Date;
}

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
/** Wording that frames a figure as something said earlier, not as the current state. */
const AS_OLD = /\b(you|i|we) (asked|said|told|answered|mentioned|gave|quoted|noted|highlighted|recommended|suggested|listed|stated|shortlisted)\b|\b(earlier|previously|before|originally|back then|at the time|at that time|a while back|last time|was|were|then)\b|→|->|\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
/** Verbs that attribute a date to a source. A bare "on" is not one: "On Tue 3 Nov you asked..." dates the conversation, not a web page. */
/** After one of these, a figure is a claim about NOW ("$19 -> $19", "still $14", "remains $5") and needs a source, not memory. */
const CURRENT_MARKER = /→|->|\bnow\b|\bcurrently\b|\btoday\b|\bremains?\b|\bstill\b|\bunchanged\b|\bas of\b|\bat present\b/i;
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

/** Sentences that report nothing changed. */
const NO_CHANGE = /\bno (pricing |price |plan )?(changes?|updates?)\b|\bunchanged\b|\b(has|have|had) not changed\b|\bnot (been )?(changed|updated)\b|\bremains?\b|\bstill (the same|costs?|starts?|from)\b|\bno (announced|reported) /i;
/** Language of something having moved: a source with these, about the same thing, is a change the answer must address. */
const CHANGE_WORDS = /\b(increas(e|ed|es|ing)|rais(e|ed|es|ing)|reduc(e|ed|es|ing|tion)|lower(ed|s|ing)|cut(s|ting)? (the )?(price|prices|pricing)|discontinu\w+|deprecat\w+|sunset\w*|introduc(e|ed|es|ing)|launch(ed|es|ing)|announc(e|ed|es|ing)|price (change|hike|increase|drop|cut)|new (pricing|price|plan|tier)|no longer|will (now )?(cost|increase|change|be)|effective (from )?\w+ \d{1,2})\b/i;

/** Words that make a change a change to what a customer pays or gets, not a railway reducing derailment risk. */
const PRODUCT_WORDS = /\b(pric(e|es|ing)|plans?|tiers?|costs?|free|paid|billing|credits?|quota|storage|seats?|subscription|per (month|user|seat|gb|hour)|usage|limits?)\b|[$€£]\s?\d/i;

/**
 * Position of a *product* change worth flagging, or undefined. The change must sit beside pricing or plan language, and
 * either beside a mention of `subject` in the text, or anywhere on a page that is itself the subject's (its address or title).
 */
function changeNear(page: { url: string; title: string; text: string }, subject: string, radius: number): number | undefined {
  const { text } = page;
  const lower = text.toLowerCase(), s = subject.toLowerCase();
  const isSubjectsPage = `${page.url} ${page.title}`.toLowerCase().includes(s);
  const mentions: number[] = [];
  for (let at = lower.indexOf(s); at >= 0; at = lower.indexOf(s, at + s.length)) mentions.push(at);
  if (!mentions.length && !isSubjectsPage) return undefined;
  for (const m of text.matchAll(new RegExp(CHANGE_WORDS.source, "gi"))) {
    const at = m.index ?? 0;
    if (!PRODUCT_WORDS.test(text.slice(Math.max(0, at - 90), at + 120))) continue;            // about something other than price or plan
    if (isSubjectsPage || mentions.some((x) => Math.abs(x - at) <= radius)) return at;
  }
  return undefined;
}

const NOT_SUBJECT = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*$/i;
const GENERIC_SUBJECT = new Set("total cost costs ownership hosting services service pricing price plan plans managed production industry overview summary assessment current recent latest monthly annual starting typical general basic free paid".split(" "));

/**
 * The names a sentence is about: capitalised words that are not the sentence's first word (unless it is a label like
 * "Railway: ..."), or CamelCase names like HubSpot. Generic words, months and weekdays are not subjects.
 */
export function subjectsOf(sentence: string, opts: { includeFirst?: boolean } = {}): string[] {
  const text = sentence.replace(CITATION, "").replace(/^[\s|*_\-•\d.)]+/, "");
  const out: string[] = [];
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9.+#-]{2,})\b(:?)/g)) {
    const w = m[1]!.replace(/[.-]+$/, "");
    const capitalised = /^[A-Z]/.test(w) || /[a-z][A-Z]/.test(w);
    const first = (m.index ?? 0) === 0;
    if (!capitalised || w.length < 4 || NOT_SUBJECT.test(w) || STOP.has(w.toLowerCase()) || GENERIC_SUBJECT.has(w.toLowerCase())) continue;
    if (first && !opts.includeFirst && m[2] !== ":" && !/[a-z][A-Z]/.test(w)) continue; // "Recent news ..." starts with a capital because it starts a sentence
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, 4);
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

/** Is the figure at `index` stated as the present state? True once a "now / still / → / unchanged" marker has appeared before it. */
function isCurrent(unit: string, index: number): boolean {
  const at = unit.search(CURRENT_MARKER);
  return at >= 0 && index > at;
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
      const dedupe = `${keyOf(f)}|${cited.join(",")}|${isCurrent(u.text, f.index)}`; // "$19 -> $19": the old and the current $19 are different claims
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const k = keyOf(f);
      const foundIn = evidence.filter((e) => evidenceKeys.get(e.id)!.has(k)).map((e) => e.id);
      let status: FigureStatus;
      if (cited.length && foundIn.some((id) => cited.includes(id))) status = "supported";
      else if (foundIn.length) status = cited.length ? "misattributed" : "supported";
      else if (memorySupports(k, u.text) && (input.recall || (AS_OLD.test(u.text) && !isCurrent(u.text, f.index)))) status = "memory";
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

  // A citation is only worth something if the page is about the thing claimed. "Railway pricing [6]" citing a
  // government site that never says "Railway" is decoration, not evidence.
  const weakCitations: VerificationReport["weakCitations"] = [];
  for (const u of units(answer)) {
    const ids = idsIn(u.text).filter((n) => evidenceIds.has(n));
    const subjects = subjectsOf(u.text);
    if (!ids.length || !subjects.length) continue;
    const pages = ids.map((id) => evidence.find((e) => e.id === id)!);
    const mentions = pages.some((e) => subjects.some((s) => `${e.url} ${e.title} ${e.text}`.toLowerCase().includes(s.toLowerCase())));
    if (!mentions) weakCitations.push({ text: u.text.replace(CITATION, "").replace(/\s+/g, " ").trim().slice(0, 100), ids, subjects, pages: pages.map((e) => e.url) });
  }

  // "No change found" is only safe if nothing in the window says otherwise.
  const overlooked: VerificationReport["overlooked"] = [];
  if (input.windowStart && input.reverify) {
    const recent = evidence.filter((e) => e.published && e.published.slice(0, 10) >= input.windowStart!);
    for (const u of units(answer)) {
      if (!NO_CHANGE.test(u.text)) continue;
      // The first word counts here: "Neon is unchanged" names its subject first, and a wrong guess cannot raise a false alarm because a source must also mention it alongside change language.
      for (const subject of subjectsOf(u.text, { includeFirst: true })) {
        for (const e of recent) {
          if (overlooked.some((o) => o.subject === subject && o.id === e.id)) continue;
          // The change language must sit next to the subject, or it is about something else on the same page ("Neon announced..." says nothing about Supabase).
          const near = changeNear(e, subject, 140);
          if (near === undefined) continue;
          const excerpt = e.text.slice(Math.max(0, near - 70), near + 90).replace(/\s+/g, " ").trim();
          const dated = [...datesIn(excerpt, now)];
          if (dated.length && dated.every((d) => d < input.windowStart!)) continue; // describes something that happened before the window
          overlooked.push({ subject, id: e.id, published: e.published!.slice(0, 10), excerpt });
        }
      }
    }
  }

  // Reassurance needs evidence. If the searches all failed, "no changes found" is an invention, however polite.
  const unverifiedAbsence = Boolean(input.reverify && evidence.length === 0 && units(answer).some((u) => NO_CHANGE.test(u.text) && !/\b(could not|couldn't|unable|can't|cannot|did not find|failed|unavailable)\b/i.test(u.text)));

  const uncovered = input.reverify && input.priorClaims?.length ? uncoveredEntities(input.priorClaims, answer) : [];
  const hasClaims = figures.length > 0 || (answer.length > 120 && !input.recall);
  const uncited = searched && evidence.length > 0 && hasClaims && idsIn(answer).length === 0;

  const good = (s: FigureStatus) => s === "supported" || s === "memory" || s === "derived";
  const bad = figures.filter((f) => !good(f.status));
  return {
    ok: bad.length === 0 && dangling.length === 0 && unsupportedDates.length === 0 && uncovered.length === 0 && weakCitations.length === 0 && overlooked.length === 0 && !unverifiedAbsence && !uncited,
    figures, dangling, unsupportedDates, uncovered, uncited, weakCitations, overlooked, unverifiedAbsence,
    checked: figures.length,
    verified: figures.length - bad.length,
  };
}

/**
 * Fixes misattributed citations without a model: the checker knows which source actually states each figure, so a
 * wrong [8] becomes [3]. In a sentence with one figure the wrong numbers are replaced; with several, the right
 * source is added, so the other figures' citations stay. Cheaper and faster than asking a model to redo the answer.
 */
export function correctCitations(answer: string, report: VerificationReport, evidence: EvidenceSource[] = []): { answer: string; fixed: number } {
  const wrong = report.figures.filter((f) => f.status === "misattributed" && f.foundIn.length > 0);
  let out = answer;
  let fixed = 0;
  for (const u of units(answer)) {
    // Several pages may state "$5"; the right one is the one that is also about the sentence's subject.
    const subjects = subjectsOf(u.text, { includeFirst: true });
    const pick = (f: (typeof wrong)[number]) => {
      if (f.foundIn.length <= 3) return f.foundIn;
      const about = f.foundIn.filter((id) => { const e = evidence.find((x) => x.id === id); return e && subjects.some((s) => `${e.url} ${e.title} ${e.text}`.toLowerCase().includes(s.toLowerCase())); });
      return about.length && about.length <= 3 ? about : [];
    };
    const here = wrong.filter((f) => u.text.includes(f.figure) && pick(f).length > 0);
    if (!here.length || !CITATION.test(u.text)) continue;
    CITATION.lastIndex = 0;
    const figuresInUnit = new Set(extractFigures(u.text).map(keyOf)).size;
    const right = [...new Set(here.flatMap(pick))].sort((a, b) => a - b);
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
  // A citation can state the right number about the wrong thing ("Railway $5 [2]" where [2] is PlanetScale's page).
  // The claim's subject and figures identify the page it should cite.
  const text = (e: EvidenceSource) => `${e.url} ${e.title} ${e.text}`.toLowerCase();
  for (const u of units(out)) {
    const ids = idsIn(u.text).filter((n) => evidence.some((e) => e.id === n));
    const subjects = subjectsOf(u.text, { includeFirst: true });
    if (!ids.length || !subjects.length) continue;
    const mentions = (e: EvidenceSource) => subjects.some((s) => text(e).includes(s.toLowerCase()));
    if (ids.some((n) => mentions(evidence.find((e) => e.id === n)!))) continue; // already cites a page about it
    const keys = new Set(extractFigures(u.text).map(keyOf));
    const right = evidence.filter((e) => mentions(e) && [...keys].every((k) => figureKeys(`${e.title} ${e.text}`).has(k))).map((e) => e.id);
    if (!right.length || right.length > 3) continue;
    let first = true;
    const replaced = u.text.replace(CITATION, () => (first ? ((first = false), right.map((n) => `[${n}]`).join("")) : ""));
    if (replaced !== u.text) { out = out.replace(u.text, replaced); fixed += 1; }
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
  if (r.unverifiedAbsence) out.push("No web evidence was retrieved this turn (the searches failed or found nothing), so you cannot say that nothing changed or that earlier figures are still current. Say plainly that you could not verify, and restate the earlier figures as what you said then, with the date.");
  for (const o of r.overlooked.slice(0, 3)) out.push(`You say nothing changed for ${o.subject}, but source [${o.id}] (published ${o.published}) says: "${o.excerpt}". Address that explicitly: state what changed, or explain why it is not a pricing change.`);
  for (const w of r.weakCitations) out.push(`For "${w.text}" you cited ${w.ids.map((n) => `[${n}]`).join("")}, but none of those pages (${w.pages.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }).join(", ")}) mention ${w.subjects.join(" or ")}. Cite a source that does, or say you found no evidence about ${w.subjects[0]}.`);
  if (r.uncited) out.push("You searched but cited no source. Add [n] citations beside the facts they support.");
  return out;
}

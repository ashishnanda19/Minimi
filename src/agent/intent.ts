/**
 * Decides, in code, whether the turn may or must use web search. The prompt already describes this, but a weak
 * model can ignore a prompt. A forced decision cannot be ignored: pure recall never pays for a search, and a
 * "has anything changed?" question can never be answered from stale memory.
 */

export type IntentKind = "chat" | "recall" | "reverify" | "change" | "lookup";

export interface Intent {
  kind: IntentKind;
  forbidSearch: boolean;
  requireSearch: boolean;
  /** The user refers back to something ("them", "that") and there is nothing in memory to refer to: ask, do not search. */
  clarify?: boolean;
}

const SMALL_TALK = /^(hi|hello|hey|thanks|thank you|thx|ok|okay|cool|great|nice|awesome|got it|perfect|good (morning|evening|night)|bye|cheers|lol|haha)\b[\s\S]{0,40}$/i;
const RECALL = /\bremind me (what|which|of|how|who|where|when|about|the|my)\b|\b(what|which|how much|who)\b[^?.]{0,60}\bdid (you|we) (recommend|suggest|say|tell|quote|answer|give|mention|conclude|pick|choose|decide)\b|\bwhat (was|were) (your|the) (answer|answers|recommendation|recommendations|suggestion|price|prices|shortlist)\b|\bwhat (did|do) you (say|remember|recall)\b|\b(you|we) (recommended|suggested|told me|said|shortlisted|concluded)\b[^?.]*\?|\b(what|which) (did|have|were|was) (i|we|you)\b.*\b(ask|asked|say|said|tell|told|discuss|discussed|talk|talked|mention|mentioned)\b|\bremind me (what|which|of)\b|\bwhat (was|were) (my|the) (first |last |previous |earlier )?(question|questions)\b|\bwhat have i (asked|said)\b|\bwhat did we (talk|discuss)\b/i;
/** Words that make a question about the *present*, so memory alone cannot answer it. */
const FRESH = /\b(still|changed?|changes|current(ly)?|now|today|anymore|any more|since|updates?d?|latest|correct|true|valid|right|accurate|verify|re-?check|double-?check|up to date|outdated)\b/i;
const REVERIFY = /\b(still (correct|true|right|valid|accurate|the same|holds?|applies)|is (that|this|it|your answer|what you said) (still )?(correct|true|right|accurate|valid)|(has|have) (any|anything|they|it|something)\b[^?.]*\b(changed|updated|moved|shipped)|(anything|something) (new|changed)|re-?(check|verify)|double-?check)\b/i;
const CHANGE = /\b(changed|changes|since|shipped|announced|released|launched|new (pricing|features?|release|plan|version)|updates?d?)\b/i;

const ANAPHORA = /\b(them|they|those|these|that one|that|it|its)\b/i;
const NOT_NAMES = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/gi;
/** A product or company name: a capitalised word that is not the first word, a weekday or a month, or CamelCase like HubSpot. */
const hasNamedEntity = (text: string) => {
  const t = text.replace(NOT_NAMES, "").replace(/^\W*\w+/, "");
  return /\b[A-Z][A-Za-z0-9.+#-]{2,}\b/.test(t) || /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(t);
};

export function classifyIntent(message: string, ctx: { hasDateRefs: boolean; hasPriorClaims: boolean; hasContext?: boolean }): Intent {
  const text = message.trim();
  const none = (kind: IntentKind): Intent => ({ kind, forbidSearch: false, requireSearch: false });

  if (text.length <= 60 && !text.includes("?") && SMALL_TALK.test(text)) return { kind: "chat", forbidSearch: true, requireSearch: false };
  if (RECALL.test(text) && !FRESH.test(text)) return { kind: "recall", forbidSearch: true, requireSearch: false };

  // A search is forced only when there is something specific to re-check. With no earlier claims ("has any of them
  // changed?" and no shortlist in memory) the right move is to ask which ones, not to search blindly.
  const reverify = REVERIFY.test(text);
  const change = CHANGE.test(text) && (ctx.hasPriorClaims || ctx.hasDateRefs);
  if ((reverify || change) && ctx.hasContext === false && !ctx.hasPriorClaims && ANAPHORA.test(text) && !hasNamedEntity(text)) {
    return { kind: reverify ? "reverify" : "change", forbidSearch: true, requireSearch: false, clarify: true };
  }
  if (reverify) return { kind: "reverify", forbidSearch: false, requireSearch: ctx.hasPriorClaims };
  if (change) return { kind: "change", forbidSearch: false, requireSearch: ctx.hasPriorClaims };
  return none("lookup");
}

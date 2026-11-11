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
}

const SMALL_TALK = /^(hi|hello|hey|thanks|thank you|thx|ok|okay|cool|great|nice|awesome|got it|perfect|good (morning|evening|night)|bye|cheers|lol|haha)\b[\s\S]{0,40}$/i;
const RECALL = /\b(what|which) (did|have|were|was) (i|we|you)\b.*\b(ask|asked|say|said|tell|told|discuss|discussed|talk|talked|mention|mentioned)\b|\bremind me (what|which|of)\b|\bwhat (was|were) (my|the) (first |last |previous |earlier )?(question|questions)\b|\bwhat have i (asked|said)\b|\bwhat did we (talk|discuss)\b/i;
/** Words that make a question about the *present*, so memory alone cannot answer it. */
const FRESH = /\b(still|changed?|changes|current(ly)?|now|today|anymore|any more|since|updates?d?|latest|correct|true|valid|right|accurate|verify|re-?check|double-?check|up to date|outdated)\b/i;
const REVERIFY = /\b(still (correct|true|right|valid|accurate|the same|holds?|applies)|is (that|this|it|your answer|what you said) (still )?(correct|true|right|accurate|valid)|(has|have) (any|anything|they|it|something)\b[^?.]*\b(changed|updated|moved|shipped)|(anything|something) (new|changed)|re-?(check|verify)|double-?check)\b/i;
const CHANGE = /\b(changed|changes|since|shipped|announced|released|launched|new (pricing|features?|release|plan|version)|updates?d?)\b/i;

export function classifyIntent(message: string, ctx: { hasDateRefs: boolean; hasPriorClaims: boolean }): Intent {
  const text = message.trim();
  const none = (kind: IntentKind): Intent => ({ kind, forbidSearch: false, requireSearch: false });

  if (text.length <= 60 && !text.includes("?") && SMALL_TALK.test(text)) return { kind: "chat", forbidSearch: true, requireSearch: false };
  if (RECALL.test(text) && !FRESH.test(text)) return { kind: "recall", forbidSearch: true, requireSearch: false };

  // A search is forced only when there is something specific to re-check. With no earlier claims ("has any of them
  // changed?" and no shortlist in memory) the right move is to ask which ones, not to search blindly.
  if (REVERIFY.test(text)) return { kind: "reverify", forbidSearch: false, requireSearch: ctx.hasPriorClaims };
  if (CHANGE.test(text) && (ctx.hasPriorClaims || ctx.hasDateRefs)) return { kind: "change", forbidSearch: false, requireSearch: ctx.hasPriorClaims };
  return none("lookup");
}

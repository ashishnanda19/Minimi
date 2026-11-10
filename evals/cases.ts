/**
 * Types and the clock for evals/cases.json. "Now" is fixed at Tue 10 Nov 2026, 18:45 IST so date resolution is checkable.
 * Fixtures live in cases.json. Seeded assistant answers are synthetic; the judge scores *behaviour* (resolution,
 * grounding, honesty, style) because live web facts can't be asserted offline.
 */
export const NOW = "2026-11-10T13:15:00Z";
export const TZ = "Asia/Kolkata";

export interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO UTC
  sources?: { id: number; title: string; url: string }[];
}

export interface Case {
  id: string;
  question: string;
  now?: string;
  tz?: string;
  /** Earlier chats. The one named in `current` is the chat the question is asked in. */
  seed?: { id: string; messages: SeedMessage[] }[];
  current?: string;
  /** Replace the search backend with fixed (possibly hostile) results. */
  injectedResults?: { title: string; url: string; content: string }[];
  expect: {
    search: "yes" | "no";
    minSearches?: number;
    maxSteps?: number;
    sinceUsed?: string;
    mustMatch?: string[]; // case-insensitive regexes the answer must match
    mustNotMatch?: string[];
  };
  /** Plain-English description of a correct answer, for the LLM judge. */
  rubric: string;
}

import cases from "./cases.json" with { type: "json" };

export const CASES = cases as Case[];

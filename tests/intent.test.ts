import { describe, expect, it } from "vitest";
import { classifyIntent } from "../src/agent/intent.js";

const ask = (message: string, hasDateRefs = false, hasPriorClaims = false) => classifyIntent(message, { hasDateRefs, hasPriorClaims });

describe("classifyIntent: what code decides about searching", () => {
  it("small talk never searches", () => {
    for (const m of ["thanks, that helped", "ok cool", "hey", "great, thank you!"]) expect(ask(m)).toMatchObject({ kind: "chat", forbidSearch: true });
  });
  it("a long or question-like message is not small talk", () => {
    expect(ask("thanks, but what is the latest Node version?").forbidSearch).toBe(false);
    expect(ask("ok?").kind).not.toBe("chat");
  });
  it("pure recall answers from the record and never pays for a search", () => {
    for (const m of ["What did I ask you on 3 November?", "remind me what I asked yesterday", "what did we discuss last week", "What was my first question?"]) {
      expect(ask(m, true), m).toMatchObject({ kind: "recall", forbidSearch: true, requireSearch: false });
    }
  });
  it("recall plus a freshness cue is NOT recall: it must be verified against the web", () => {
    const i = ask("What did I ask you on 3 November? Is your answer still correct today?", true, true);
    expect(i.kind).toBe("reverify");
    expect(i.forbidSearch).toBe(false);
    expect(i.requireSearch).toBe(true);
  });
  it("re-verification with earlier claims forces a search", () => {
    expect(ask("Is that still correct?", false, true)).toMatchObject({ kind: "reverify", requireSearch: true });
    expect(ask("has anything changed since?", true, true)).toMatchObject({ requireSearch: true });
    expect(ask("Has any of them changed pricing or shipped something big since?", true, true)).toMatchObject({ kind: "reverify", requireSearch: true });
  });
  it("with nothing to re-verify it does not search blindly: the agent should ask which ones", () => {
    const i = ask("Has any of them changed pricing since Monday?", true, false);
    expect(i.requireSearch).toBe(false);
    expect(i.forbidSearch).toBe(false);
  });
  it("'since' with a date but no earlier claims is an ordinary lookup, free to search", () => {
    const i = ask("What's been announced in the Postgres ecosystem since last Tuesday?", true, false);
    expect(i).toMatchObject({ kind: "change", forbidSearch: false, requireSearch: false });
  });
  it("everything else is a plain lookup", () => {
    expect(ask("Who is the current CEO of Microsoft?")).toMatchObject({ kind: "lookup", forbidSearch: false, requireSearch: false });
    expect(ask("What is the difference between a LEFT JOIN and an INNER JOIN?").forbidSearch).toBe(false);
  });
});

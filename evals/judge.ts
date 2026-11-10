import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

export const verdictSchema = z.object({
  dateResolution: z.number().int().min(1).max(5).nullable().describe("1-5, or null if no date was involved"),
  honesty: z.number().int().min(1).max(5).describe("5 = every claim is supported; nothing invented; uncertainty stated"),
  leadsWithAnswer: z.number().int().min(1).max(5).describe("5 = the first sentence answers the question"),
  usefulness: z.number().int().min(1).max(5).describe("5 = what a sharp colleague would say: concise, specific, no filler"),
  pass: z.boolean().describe("Does the answer satisfy the rubric?"),
  reason: z.string().describe("One or two sentences"),
});
export type Verdict = z.infer<typeof verdictSchema>;

export async function judge(model: LanguageModel, ctx: {
  calendar: string; memory: string; question: string; answer: string; queries: string[]; rubric: string; sources: string;
}): Promise<Verdict> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: verdictSchema }),
    system: "You are a strict evaluator of a web-search chat assistant. Judge ONLY the assistant's behaviour against the rubric, using the calendar as the ground truth for dates. You cannot verify live web facts, so do not penalise specific prices that are cited; do penalise claims with no citation, invented changes, wrong dates, and ignoring the rubric.",
    prompt: [
      `CALENDAR (ground truth):\n${ctx.calendar}`,
      `MEMORY AVAILABLE TO THE ASSISTANT:\n${ctx.memory || "(none)"}`,
      `USER QUESTION: ${ctx.question}`,
      `SEARCH QUERIES THE ASSISTANT RAN: ${ctx.queries.length ? ctx.queries.join(" | ") : "(none)"}`,
      `SOURCES CITED: ${ctx.sources || "(none)"}`,
      `ASSISTANT ANSWER:\n${ctx.answer}`,
      `RUBRIC: ${ctx.rubric}`,
    ].join("\n\n"),
  });
  return output;
}

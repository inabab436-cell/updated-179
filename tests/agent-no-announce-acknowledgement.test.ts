/**
 * Regression guard: the agent must never reply with "understood that you
 * want X" restatements ("تمام عرفت إنك عايز ده") or announce a future action
 * ("طلبك هيتسجل") instead of answering / acting now.
 *
 * Root cause this locks down: the prompt forbade *quoting* the customer's
 * message but not *paraphrasing* it as an acknowledgement, and nothing
 * forbade narrating an internal action. The model therefore opened turns
 * with intent-recaps that repeat information and stall the conversation.
 */
import { describe, expect, it } from "vitest";
import { AGENT_PROMPT_SECTIONS } from "@/lib/agent-prompt";

const output = AGENT_PROMPT_SECTIONS.find((s) => s.id === "output");
const rules = (output?.rules ?? []).join("\n");

describe("no acknowledge-and-announce replies", () => {
  it("lives in the output section (shape of the reply), not a new layer", () => {
    expect(output).toBeDefined();
    const ids = AGENT_PROMPT_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("forbids restating the customer's message as an 'I understood' acknowledgement", () => {
    expect(rules).toContain("NEVER ANNOUNCE UNDERSTANDING");
    expect(rules).toMatch(/Restating the customer's own message back at him as an acknowledgement is repetition/);
  });

  it("forbids announcing an action that has not run — the tool runs in the same turn", () => {
    expect(rules).toContain("NEVER ANNOUNCE AN ACTION");
    expect(rules).toMatch(/call its tool in this same turn/);
    expect(rules).toMatch(/report the FINISHED result/);
  });

  it("requires the understanding to show through the answer or the next step itself", () => {
    expect(rules).toMatch(/the reply proves it by giving the answer or taking the next step itself/);
  });
});

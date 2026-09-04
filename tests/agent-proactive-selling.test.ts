/**
 * Regression guard for PROACTIVE SELLING behaviour.
 *
 * Root cause these tests lock down: the prompt's many "do not repeat / do not
 * volunteer / stay silent" prohibitions were absolute, while the "take the next
 * step" guidance was permissive. The agent resolved that conflict by answering
 * and stopping. The fix makes proactive progress the default shape of a reply,
 * without keyword matching, regex, or a new prompt layer.
 */
import { describe, expect, it } from "vitest";
import { AGENT_PROMPT_SECTIONS, buildAgentPrompt } from "@/lib/agent-prompt";

const conversation = AGENT_PROMPT_SECTIONS.find((s) => s.id === "conversation");
const rules = (conversation?.rules ?? []).join("\n");
const prompt = buildAgentPrompt();

describe("proactive selling", () => {
  it("keeps the decision logic in the single existing section (no stacked prompt layer)", () => {
    expect(conversation).toBeDefined();
    const ids = AGENT_PROMPT_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // No new section was appended for this behaviour.
    expect(ids).toEqual(
      expect.arrayContaining(["identity", "voice", "understanding", "conversation", "selling", "order"]),
    );
  });

  it("1. makes taking the next purchase step the default, not waiting to be asked", () => {
    expect(rules).toContain("PROACTIVE BY DEFAULT");
    expect(rules).toContain("answering is never the whole reply");
    expect(rules).toMatch(/Waiting for the customer to ask to order/);
  });

  it("2. treats an agreement or positive reaction as advancing the sale, not as an end of turn", () => {
    expect(rules).toMatch(/short agreement, approval or positive reaction/);
    expect(rules).toMatch(/never a cue to re-recite the piece/);
  });

  it("3. resolves anti-repetition by moving forward instead of restating known facts", () => {
    expect(rules).toContain("THE ANTI-REPETITION RULES ARE SATISFIED BY MOVING FORWARD");
    expect(rules).toMatch(/re-describes or re-prices something already established/);
  });

  it("4. advances step by step towards order creation using the smallest missing field", () => {
    expect(rules).toMatch(/SMALLEST missing thing between this customer and a placed order/);
    expect(rules).toMatch(/only one step per reply/);
    // The order flow itself is untouched and still tool-driven.
    expect(prompt).toContain("create_order");
  });

  it("5. does not become pushy when there is no real buying signal", () => {
    expect(rules).toContain("PROACTIVE IS NOT PUSHY");
    expect(rules).toMatch(/changed the subject|change of subject/);
    expect(rules).toMatch(/Never repeat the same nudge twice/);
    // Stopping cleanly is still allowed, but only without a buying signal.
    expect(rules).toMatch(/No useful next step exists — and that is only true when/);
  });

  it("6. still forbids generic customer-service filler questions", () => {
    expect(rules).toContain("Generic closing questions are forbidden");
  });
});

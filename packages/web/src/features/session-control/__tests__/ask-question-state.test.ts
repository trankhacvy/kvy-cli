import { describe, expect, it } from "vitest";
import type { AskQuestionParsed } from "@/lib/tool-args";
import {
  type AskFreeTextAnswers,
  type AskSelections,
  allAskQuestionsAnswered,
  buildAskAnswerDecision,
  buildAskAnswers,
  buildChatAboutThisDecision,
  clearAskSelection,
  extractAskAnswers,
  setAskFreeText,
  toggleAskSelection,
} from "../ask-question-state";

const singleSelectQuestion: AskQuestionParsed = {
  question: "Which color?",
  options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
};

const multiSelectQuestion: AskQuestionParsed = {
  question: "Which frameworks?",
  multiSelect: true,
  options: [{ label: "React" }, { label: "Vue" }, { label: "Svelte" }],
};

describe("toggleAskSelection", () => {
  it("selects a single-select option, replacing any prior selection", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    expect(selections.get(0)).toEqual(new Set([0]));

    selections = toggleAskSelection(selections, 0, 1, false);
    expect(selections.get(0)).toEqual(new Set([1])); // replaced, not accumulated
  });

  it("re-picking the same single-select option twice leaves it selected", () => {
    // A single-select toggle always starts from a fresh empty set (radio-
    // button semantics — the prior pick is discarded regardless of which
    // option it was), so re-toggling the *same* index re-adds it rather
    // than deselecting it.
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    selections = toggleAskSelection(selections, 0, 0, false);
    expect(selections.get(0)).toEqual(new Set([0]));
  });

  it("accumulates multi-select options", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, true);
    selections = toggleAskSelection(selections, 0, 2, true);
    expect(selections.get(0)).toEqual(new Set([0, 2]));
  });

  it("removes one multi-select option without touching the others", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, true);
    selections = toggleAskSelection(selections, 0, 1, true);
    selections = toggleAskSelection(selections, 0, 0, true);
    expect(selections.get(0)).toEqual(new Set([1]));
  });

  it("does not mutate the input map (pure function)", () => {
    const selections: AskSelections = new Map();
    const next = toggleAskSelection(selections, 0, 0, false);
    expect(selections.size).toBe(0);
    expect(next.size).toBe(1);
  });

  it("keeps other questions' selections untouched", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    selections = toggleAskSelection(selections, 1, 1, true);
    expect(selections.get(0)).toEqual(new Set([0]));
    expect(selections.get(1)).toEqual(new Set([1]));
  });
});

describe("allAskQuestionsAnswered", () => {
  it("is false until every question has a selection", () => {
    const questions = [singleSelectQuestion, multiSelectQuestion];
    let selections: AskSelections = new Map();
    expect(allAskQuestionsAnswered(questions, selections)).toBe(false);

    selections = toggleAskSelection(selections, 0, 0, false);
    expect(allAskQuestionsAnswered(questions, selections)).toBe(false);

    selections = toggleAskSelection(selections, 1, 0, true);
    expect(allAskQuestionsAnswered(questions, selections)).toBe(true);
  });

  it("is true for an empty question list", () => {
    expect(allAskQuestionsAnswered([], new Map())).toBe(true);
  });
});

describe("buildAskAnswers / buildAskAnswerDecision", () => {
  it("builds a single label per single-select question", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 1, false);
    expect(buildAskAnswers([singleSelectQuestion], selections)).toEqual({
      "Which color?": "Blue",
    });
  });

  it("joins multiple selected labels with ', ' for a multi-select question", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, true);
    selections = toggleAskSelection(selections, 0, 2, true);
    expect(buildAskAnswers([multiSelectQuestion], selections)).toEqual({
      "Which frameworks?": "React, Svelte",
    });
  });

  it("buildAskAnswerDecision wraps the answers in the exact wire shape", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    expect(buildAskAnswerDecision([singleSelectQuestion], selections)).toEqual({
      kind: "allow",
      scope: "once",
      updatedInput: { answers: { "Which color?": "Red" } },
    });
  });
});

describe("extractAskAnswers", () => {
  it("reads the answers map back out of a matching allow decision", () => {
    expect(
      extractAskAnswers({
        kind: "allow",
        scope: "once",
        updatedInput: { answers: { "Which color?": "Blue" } },
      }),
    ).toEqual({ "Which color?": "Blue" });
  });

  it("returns undefined for a deny decision", () => {
    expect(extractAskAnswers({ kind: "deny", message: "no" })).toBeUndefined();
  });

  it("returns undefined for an allow decision with no updatedInput", () => {
    expect(extractAskAnswers({ kind: "allow", scope: "once" })).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(extractAskAnswers(undefined)).toBeUndefined();
  });
});

describe("setAskFreeText", () => {
  it("sets a free-text answer for a question", () => {
    let freeText: AskFreeTextAnswers = new Map();
    freeText = setAskFreeText(freeText, 0, "Hot chocolate");
    expect(freeText.get(0)).toBe("Hot chocolate");
  });

  it("clears the entry for an empty string, rather than storing it", () => {
    let freeText: AskFreeTextAnswers = new Map();
    freeText = setAskFreeText(freeText, 0, "Hot chocolate");
    freeText = setAskFreeText(freeText, 0, "");
    expect(freeText.has(0)).toBe(false);
  });

  it("does not mutate the input map (pure function)", () => {
    const freeText: AskFreeTextAnswers = new Map();
    const next = setAskFreeText(freeText, 0, "Tea");
    expect(freeText.size).toBe(0);
    expect(next.size).toBe(1);
  });

  it("keeps other questions' free text untouched", () => {
    let freeText: AskFreeTextAnswers = new Map();
    freeText = setAskFreeText(freeText, 0, "Tea");
    freeText = setAskFreeText(freeText, 1, "Coffee");
    expect(freeText.get(0)).toBe("Tea");
    expect(freeText.get(1)).toBe("Coffee");
  });
});

describe("clearAskSelection", () => {
  it("removes one question's selection without touching others", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    selections = toggleAskSelection(selections, 1, 1, true);
    selections = clearAskSelection(selections, 0);
    expect(selections.has(0)).toBe(false);
    expect(selections.get(1)).toEqual(new Set([1]));
  });

  it("does not mutate the input map (pure function)", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    const next = clearAskSelection(selections, 0);
    expect(selections.has(0)).toBe(true);
    expect(next.has(0)).toBe(false);
  });
});

describe("allAskQuestionsAnswered with free text", () => {
  it("counts a non-empty free-text answer as answered even with no selection", () => {
    const questions = [singleSelectQuestion, multiSelectQuestion];
    const selections: AskSelections = new Map();
    let freeText: AskFreeTextAnswers = new Map();
    expect(allAskQuestionsAnswered(questions, selections, freeText)).toBe(false);

    freeText = setAskFreeText(freeText, 0, "Purple");
    expect(allAskQuestionsAnswered(questions, selections, freeText)).toBe(false); // q2 still unanswered

    freeText = setAskFreeText(freeText, 1, "Angular");
    expect(allAskQuestionsAnswered(questions, selections, freeText)).toBe(true);
  });
});

describe("buildAskAnswers with free text", () => {
  it("prefers a question's free-text answer over its option selections", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false); // "Red"
    const freeText: AskFreeTextAnswers = new Map([[0, "Purple"]]);
    expect(buildAskAnswers([singleSelectQuestion], selections, freeText)).toEqual({
      "Which color?": "Purple",
    });
  });

  it("falls back to the option selection when free text is empty/absent", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 1, false); // "Blue"
    expect(buildAskAnswers([singleSelectQuestion], selections, new Map())).toEqual({
      "Which color?": "Blue",
    });
  });

  it("buildAskAnswerDecision wraps a free-text answer in the exact wire shape", () => {
    const selections: AskSelections = new Map();
    const freeText: AskFreeTextAnswers = new Map([[0, "Hot chocolate"]]);
    expect(buildAskAnswerDecision([singleSelectQuestion], selections, freeText)).toEqual({
      kind: "allow",
      scope: "once",
      updatedInput: { answers: { "Which color?": "Hot chocolate" } },
    });
  });
});

describe("buildChatAboutThisDecision", () => {
  it("is a message-less deny (bridge falls back to ASK_FALLBACK_REASON)", () => {
    expect(buildChatAboutThisDecision()).toEqual({ kind: "deny" });
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ElicitationEntry,
  fieldsOf,
  stepsOf,
  toContent,
  validateField,
  validateStep,
} from "../src/elicitation.ts";

function entry(properties: Record<string, unknown>, required: string[] = []): ElicitationEntry {
  return {
    kind: "elicitation",
    id: "e1",
    request: {
      mode: "form",
      message: "Please answer.",
      requestedSchema: { type: "object", properties, required },
    },
  } as unknown as ElicitationEntry;
}

const FORM = entry(
  {
    color: {
      type: "string",
      description: "Pick a color",
      oneOf: [
        { const: "red", title: "Red" },
        { const: "blue", title: "Blue", description: "Cool" },
      ],
    },
    color_other: {
      type: "string",
      _meta: { _askUserQuestionCustomAnswer: { questionId: "color" } },
    },
    tags: { type: "array", items: { enum: ["a", "b"] } },
    agree: { type: "boolean", title: "I agree" },
    count: { type: "integer", minimum: 1, maximum: 5 },
    name: { type: "string", minLength: 2, maxLength: 4 },
  },
  ["count"],
);

describe("fieldsOf", () => {
  it("reads every field type the schema can hold", () => {
    const fields = fieldsOf(FORM);
    assert.deepEqual(
      fields.map((f) => [f.key, f.kind]),
      [
        ["color", "single"],
        ["color_other", "text"],
        ["tags", "multi"],
        ["agree", "boolean"],
        ["count", "number"],
        ["name", "text"],
      ],
    );
    assert.deepEqual(fields[0]?.choices, [
      { value: "red", title: "Red", description: undefined },
      { value: "blue", title: "Blue", description: "Cool" },
    ]);
    assert.deepEqual(
      fields[2]?.choices.map((c) => c.value),
      ["a", "b"],
    );
    assert.equal(fields[4]?.required, true);
    assert.equal(fields[4]?.integer, true);
    assert.equal(fields[0]?.required, false);
  });

  it("has no fields for a url elicitation", () => {
    const url = {
      kind: "elicitation",
      id: "e",
      request: { mode: "url" },
    } as unknown as ElicitationEntry;
    assert.deepEqual(fieldsOf(url), []);
  });
});

describe("stepsOf", () => {
  it("puts a custom-answer box under its question instead of making it a step", () => {
    const steps = stepsOf(fieldsOf(FORM));
    assert.deepEqual(
      steps.map((s) => s.field.key),
      ["color", "tags", "agree", "count", "name"],
    );
    assert.equal(steps[0]?.note?.key, "color_other");
  });
});

describe("toContent", () => {
  it("parses numbers and drops the ones that do not parse", () => {
    const fields = fieldsOf(FORM);
    assert.deepEqual(toContent(fields, { count: "3", color: "red" }), { count: 3, color: "red" });
    assert.deepEqual(toContent(fields, { count: "x" }), {});
  });
});

describe("validateField", () => {
  const [, , , , count, name] = fieldsOf(FORM);

  it("rejects text that is not a number, a fraction for an integer and out-of-range values", () => {
    assert.equal(validateField(count!, "abc"), "Enter a number");
    assert.equal(validateField(count!, "2.5"), "Enter a whole number");
    assert.equal(validateField(count!, "0"), "Must be at least 1");
    assert.equal(validateField(count!, "9"), "Must be at most 5");
    assert.equal(validateField(count!, "3"), undefined);
  });

  it("checks the length of text", () => {
    assert.equal(validateField(name!, "a"), "Use at least 2 characters");
    assert.equal(validateField(name!, "abcde"), "Use at most 4 characters");
    assert.equal(validateField(name!, "abc"), undefined);
  });

  it("asks for a required field and lets an optional one stay empty", () => {
    assert.equal(validateField(count!, ""), "This is required");
    assert.equal(validateField(name!, undefined), undefined);
  });
});

describe("validateStep", () => {
  const steps = stepsOf(fieldsOf(FORM));
  it("accepts the pick or the free text as the answer to a required question", () => {
    const required = {
      field: { ...steps[0]!.field, required: true },
      note: steps[0]!.note,
    };
    assert.deepEqual(validateStep(required, {}), { color: "This is required" });
    assert.deepEqual(validateStep(required, { color: "red" }), {});
    assert.deepEqual(validateStep(required, { color_other: "green" }), {});
  });

  it("reports the field that is wrong", () => {
    assert.deepEqual(validateStep(steps[3]!, { count: "x" }), { count: "Enter a number" });
  });
});

import { test, expect } from "bun:test";
import { parsePlanFromText } from "../internal/agent/plan";

test("parsePlanFromText", () => {
  const text = '{"steps":[{"id":"step_1","title":"t","type":"command","needs_approval":false,"command":"echo hi"}]}' ;
  const plan = parsePlanFromText(text);
  expect(plan.steps.length).toBe(1);
});

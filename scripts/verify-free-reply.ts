import assert from "node:assert/strict";
import { buildFreeReply, canAnswerWithoutAI } from "../lib/inquiry/freeReply";
import type { AnswerPlan } from "../lib/inquiry/answerPlan";
const plan: AnswerPlan = { questionCount: 2, items: [
  { questionId: "Q1", topic: "SIZE", status: "ANSWERABLE", evidenceRefs: ["サイズ"], answerConstraints: [] },
  { questionId: "Q2", topic: "MATERIAL", status: "ANSWERABLE", evidenceRefs: ["素材"], answerConstraints: [] },
] };
const facts = [{ label: "サイズ", value: "幅50cm" }, { label: "素材", value: "木製" }, { label: "内部メモ", value: "掲載禁止" }];
assert.equal(canAnswerWithoutAI(plan, facts, false, "サイズと素材を教えてください。"), true);
assert.equal(canAnswerWithoutAI(plan, facts.slice(0, 1), false, "サイズと素材は？"), false);
assert.equal(canAnswerWithoutAI(plan, facts, true, "サイズと素材は？"), false);
assert.equal(canAnswerWithoutAI(plan, facts, false, "このサイズなら搬入できますか？"), false);
const draft = buildFreeReply(plan, facts, true);
assert.ok(draft.includes("幅50cm") && draft.includes("木製"));
assert.ok(!draft.includes("掲載禁止"));
const conflict: AnswerPlan = { ...plan, items: plan.items.map(i => ({ ...i, status: "CONFLICT" })) };
assert.equal(canAnswerWithoutAI(conflict, facts, false, "サイズと素材は？"), false);
assert.ok(!buildFreeReply(conflict, facts).includes("50cm"));
assert.ok(buildFreeReply(plan, facts).includes("確認が必要"));
console.log("9 passed, 0 failed");

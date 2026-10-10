import assert from "node:assert/strict";
import { test } from "node:test";
import { cases } from "./eval/fixtures.js";
import { patchProblem } from "./patchCheck.js";

const ctor = cases.find((c) => c.id === "v22-constructor-requires-new")!;
const fixed = ctor.beforeCode.replace("= Stripe(", "= new Stripe(");

test("a real fix passes", () => {
  assert.equal(patchProblem("app.js", ctor.beforeCode, fixed), null);
});

test("what used to pass the eval without fixing anything is rejected", () => {
  // A comment holding the strings the eval looks for.
  assert.match(patchProblem("app.js", ctor.beforeCode, "// new Stripe( TODO(api-dependabot)\n")!, /changes 5 of the file's 5 lines/);
  // The original with its syntax broken.
  assert.match(patchProblem("app.js", ctor.beforeCode, fixed.replace("{", ""))!, /doesn't parse/);
  // Nothing at all.
  assert.match(patchProblem("app.js", ctor.beforeCode, "\n")!, /empty/);
});

test("TypeScript and JSX parse as what they are", () => {
  assert.equal(patchProblem("a.ts", "let a = 1;\n", "let a: number = 1;\n"), null);
  assert.equal(patchProblem("a.tsx", "const v = <b/>;\n", "const v = <i/>;\n"), null);
  assert.match(patchProblem("a.ts", "let a = 1;\n", "let a: = 1;\n")!, /doesn't parse/);
});

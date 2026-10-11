import { mkdirSync, writeFileSync } from "node:fs";
import { generatePatch } from "../llmClient.js";
import { patchProblem } from "../patchCheck.js";
import { cases } from "./fixtures.js";
import { addedErrors, sdkRoot, typeErrors } from "./sdkTypes.js";

interface CaseResult {
  id: string;
  sample: number;
  pass: boolean;
  explanation: string;
  patchedCode: string;
  failures: string[];
  typeChecked: string | null; // the SDK version the patch was type-checked against
}

/** Type errors the patch adds, checked against the SDK release the change
 * shipped in. The original's errors (the breaking change itself, say) don't
 * count against it; a method the model invented, a parameter it misnamed or a
 * call it broke does. Null when that release has no types to check against. */
function typeCheck(testCase: (typeof cases)[number], patchedCode: string): { version: string; added: string[] } | null {
  const version = testCase.changelogEntry.match(/^v(\S+?):/)?.[1];
  if (!version) return null;
  const root = sdkRoot("stripe", version);
  const before = typeErrors(root, testCase.beforeCode);
  const after = before && typeErrors(root, patchedCode);
  return before && after ? { version, added: addedErrors(before, after) } : null;
}

async function runCase(testCase: (typeof cases)[number], sample: number): Promise<CaseResult> {
  const { explanation, patchedCode } = await generatePatch(
    testCase.changelogEntry,
    `eval/${testCase.id}.js`,
    testCase.beforeCode
  );

  const found = (check: string | RegExp) =>
    typeof check === "string" ? patchedCode.includes(check) : check.test(patchedCode);
  const failures: string[] = [];
  // The same check the pipeline makes before opening a PR, so a pass means the
  // patch would have gone out: it parses and it edits the file rather than replacing it.
  const problem = patchProblem(`eval/${testCase.id}.ts`, testCase.beforeCode, patchedCode);
  if (problem) failures.push(problem);
  for (const required of testCase.mustContain) {
    if (!found(required)) {
      failures.push(`missing expected ${required}`);
    }
  }
  for (const forbidden of testCase.mustNotContain) {
    if (found(forbidden)) {
      failures.push(`still contains ${forbidden}`);
    }
  }
  const types = problem ? null : typeCheck(testCase, patchedCode);
  if (types?.added.length) failures.push(`adds type errors against stripe ${types.version}: ${types.added.join("; ")}`);

  return {
    id: testCase.id,
    sample,
    pass: failures.length === 0,
    explanation,
    patchedCode,
    failures,
    typeChecked: types ? `stripe ${types.version}` : null,
  };
}

async function main() {
  const results: CaseResult[] = [];
  // `npm run eval -- blik` runs just the cases whose id contains "blik";
  // `--samples 3` runs each case three times, since the model's patch varies.
  const args = process.argv.slice(2);
  const samplesAt = args.indexOf("--samples");
  const samples = samplesAt === -1 ? 1 : Number(args[samplesAt + 1]);
  if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples takes a whole number of runs per case");
  const only = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--samples");
  const selected = only ? cases.filter((c) => c.id.includes(only)) : cases;

  for (const testCase of selected) {
    process.stdout.write(`${testCase.id} ... `);
    const runs: CaseResult[] = [];
    for (let sample = 1; sample <= samples; sample++) {
      try {
        runs.push(await runCase(testCase, sample));
      } catch (err) {
        runs.push({
          id: testCase.id,
          sample,
          pass: false,
          explanation: "",
          patchedCode: "",
          failures: [`error: ${(err as Error).message}`],
          typeChecked: null,
        });
      }
    }
    results.push(...runs);
    const passed = runs.filter((r) => r.pass).length;
    const failures = [...new Set(runs.flatMap((r) => r.failures))];
    const checked = runs.find((r) => r.typeChecked)?.typeChecked;
    console.log(
      `${passed === runs.length ? "PASS" : "FAIL"}${samples > 1 ? ` ${passed}/${runs.length}` : ""}` +
        `${checked ? ` (types: ${checked})` : " (types not checked)"}` +
        `${failures.length ? ` (${failures.join(", ")})` : ""}`
    );
  }

  const passed = results.filter((r) => r.pass).length;
  const casesPassed = selected.filter((c) => results.filter((r) => r.id === c.id).every((r) => r.pass)).length;
  console.log(`\n${casesPassed}/${selected.length} cases passed every sample; ${passed}/${results.length} samples passed`);

  mkdirSync("eval-results", { recursive: true });
  const outPath = `eval-results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Full results (including patched code + explanations) written to ${outPath}`);

  if (passed < results.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

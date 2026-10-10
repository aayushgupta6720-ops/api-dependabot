import { mkdirSync, writeFileSync } from "node:fs";
import { generatePatch } from "../llmClient.js";
import { patchProblem } from "../patchCheck.js";
import { cases } from "./fixtures.js";

interface CaseResult {
  id: string;
  pass: boolean;
  explanation: string;
  patchedCode: string;
  failures: string[];
}

async function runCase(testCase: (typeof cases)[number]): Promise<CaseResult> {
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

  return { id: testCase.id, pass: failures.length === 0, explanation, patchedCode, failures };
}

async function main() {
  const results: CaseResult[] = [];
  // `npm run eval -- blik` runs just the cases whose id contains "blik".
  const only = process.argv[2];
  const selected = only ? cases.filter((c) => c.id.includes(only)) : cases;

  for (const testCase of selected) {
    process.stdout.write(`${testCase.id} ... `);
    try {
      const result = await runCase(testCase);
      results.push(result);
      console.log(result.pass ? "PASS" : `FAIL (${result.failures.join(", ")})`);
    } catch (err) {
      results.push({
        id: testCase.id,
        pass: false,
        explanation: "",
        patchedCode: "",
        failures: [`error: ${(err as Error).message}`],
      });
      console.log(`FAIL (error: ${(err as Error).message})`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);

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

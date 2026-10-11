/**
 * End-to-end eval: a real release's notes go through the whole agent except
 * GitHub. Extraction (the model reads stripe-node's 10.0.0 changelog, every
 * line it must account for), the scanner (a small repo that uses two of the
 * removed or renamed methods, and one file that should be left alone), the
 * patches (the model again), the pipeline's own checks, and a type check of
 * each patched file against stripe 10.0.0's declarations. PRs are recorded
 * instead of opened.
 *
 *     npm run eval:e2e      # a few Gemini calls: one or two to read the notes, one per affected file
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_MARKER } from "../changes.js";
import { extractBreakingChanges, generatePatch } from "../llmClient.js";
import { processReleases } from "../pipeline.js";
import { apiVersionChange } from "../releaseNotes.js";
import { findApiVersionPins, findFieldUsages, findUsages } from "../scanner.js";
import { addedErrors, sdkRoot, typeErrors } from "./sdkTypes.js";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e");
const REPO = path.join(HERE, "repo");
const RELEASE = { version: "v10.0.0", notes: readFileSync(path.join(HERE, "stripe-v10.0.0.md"), "utf8") };

// Methods the notes rename or remove that the repo calls. Matched on the
// end of the model's name, which may or may not start at the client.
const MUST_EXTRACT = [/(^|\.)invoices\.listUpcomingLineItems$/, /(^|\.)issuing\.cards\.retrieveDetails$/];
// The PRs the repo should get, and what each patched file must (not) contain.
const EXPECTED_PRS: Record<string, { mustContain: (string | RegExp)[]; mustNotContain: (string | RegExp)[] }> = {
  "billing.js": { mustContain: [".listUpcomingLines("], mustNotContain: ["listUpcomingLineItems"] },
  "cards.js": { mustContain: [REVIEW_MARKER, /throw new Error\(/, ".update(cardId"], mustNotContain: [".retrieveDetails("] },
};

interface Check {
  id: string;
  pass: boolean;
  failures: string[];
}

async function main() {
  const checks: Check[] = [];
  const check = (id: string, failures: string[]) => {
    checks.push({ id, pass: failures.length === 0, failures });
    console.log(`${id} ... ${failures.length === 0 ? "PASS" : `FAIL (${failures.join("; ")})`}`);
  };

  const extraction = await extractBreakingChanges("stripe", [RELEASE]);
  const targets = extraction.changes.map((c) => c.methodName ?? c.fieldPath ?? "");
  console.log(`Read ${extraction.changes.length} changes and ${extraction.notPatched.length} with nothing to patch.`);
  check("extraction: every item marked breaking accounted for", extraction.problems);
  check(
    "extraction: the methods the repo calls",
    MUST_EXTRACT.filter((re) => !targets.some((t) => re.test(t))).map((re) => `no change matches ${re}`)
  );

  const opened: { file: string; content: string; title: string }[] = [];
  const seen: string[] = [];
  const result = await processReleases(
    {
      changes: [...extraction.changes, ...[apiVersionChange([RELEASE])].filter((c) => c !== null)],
      latestTag: RELEASE.version,
      notesProblems: extraction.problems,
    },
    {
      findUsages,
      findFieldUsages,
      findApiVersionPins,
      generatePatch,
      findFixPr: async () => null,
      openFixPr: async (_branch, file, content, title) => {
        opened.push({ file, content, title });
        return `https://example.invalid/pull/${opened.length}`;
      },
      markReleasesSeen: (tag) => void seen.push(tag),
    },
    { repoPath: REPO, targetPackage: "stripe" }
  );

  const errors = result.changes.flatMap((c) => [
    ...(c.error ? [`${c.entry.split("\n")[0]}: ${c.error}`] : []),
    ...c.patches.filter((p) => p.status === "error").map((p) => `${p.filePath}: ${p.error}`),
  ]);
  check("pipeline: no failed scans or rejected patches", errors);
  const files = opened.map((pr) => pr.file);
  check("pipeline: a PR for each affected file, and none for the rest", [
    ...Object.keys(EXPECTED_PRS).filter((f) => !files.includes(f)).map((f) => `no PR for ${f}`),
    ...files.filter((f) => !(f in EXPECTED_PRS)).map((f) => `an unexpected PR for ${f}`),
    ...files.filter((f, i) => files.indexOf(f) !== i).map((f) => `two PRs for ${f}`),
  ]);
  check("pipeline: releases marked seen", seen.includes(RELEASE.version) ? [] : ["the releases stayed unseen"]);

  const sdk = sdkRoot("stripe", "10.0.0");
  for (const [file, expected] of Object.entries(EXPECTED_PRS)) {
    const pr = opened.find((p) => p.file === file);
    if (!pr) continue;
    const found = (c: string | RegExp) => (typeof c === "string" ? pr.content.includes(c) : c.test(pr.content));
    const before = typeErrors(sdk, readFileSync(path.join(REPO, file), "utf8"))!;
    check(`patch: ${file}`, [
      ...expected.mustContain.filter((c) => !found(c)).map((c) => `missing expected ${c}`),
      ...expected.mustNotContain.filter(found).map((c) => `still contains ${c}`),
      ...addedErrors(before, typeErrors(sdk, pr.content)!).map((e) => `adds a type error against stripe 10.0.0: ${e}`),
    ]);
  }

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  const dir = path.join("eval-results", "e2e");
  mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify({ checks, extraction, opened }, null, 2));
  console.log(`Full results (extraction, patched files) written to ${outPath}`);
  if (passed < checks.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

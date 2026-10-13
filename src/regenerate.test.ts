import assert from "node:assert/strict";
import { test } from "node:test";
import type { FixPr } from "./githubClient.js";
import { fixPrBody } from "./pipeline.js";
import { regenerateFixPr, type RegenerateDeps } from "./regenerate.js";

const ENTRY = "v22.7.0-alpha.4: `Mandate.payment_method_details.blik.expires_after` removed.";
const BASE = "const x = mandate.payment_method_details.blik.expires_after;\nreturn x;\n";
const OLD_PATCH = "return null;\n"; // what the old prompt produced
const FLAGGED = `// TODO(api-dependabot): expires_after was removed in v22.7.0-alpha.4.\n${BASE}`;

function fakes(pr: Partial<FixPr> = {}, newPatch = `${FLAGGED}\n\n`) {
  const fullPr: FixPr = {
    number: 7,
    url: "https://github.com/me/test-repo/pull/7",
    state: "open",
    title: "Fix breaking change: payment_method_details.blik.expires_after",
    body: fixPrBody("Removed the reference.", ENTRY),
    headRef: "api-dependabot/v22.7.0-alpha.4-payment_method_details.blik.expires_after-mandates.js",
    baseSha: "b0de805",
    files: ["mandates.js"],
    ...pr,
  };
  const calls = {
    patchedFrom: [] as string[],
    related: [] as string[][],
    updates: [] as { content: string; title: string; body: string }[],
  };
  const deps: RegenerateDeps = {
    getFixPr: async () => fullPr,
    readRepoFile: async (_file, ref) => ({ content: ref === fullPr.baseSha ? BASE : OLD_PATCH, sha: "blob" }),
    generatePatch: async (entry, _file, code, related = []) => {
      calls.patchedFrom.push(`${entry} | ${code}`);
      calls.related.push(related);
      return { explanation: "Only added a TODO for review.", patchedCode: newPatch };
    },
    updateFixPr: async (_pr, _file, content, title, body) => void calls.updates.push({ content, title, body }),
  };
  return { deps, calls };
}

test("the patch is regenerated from the base file and the entry in the PR body", async () => {
  const { deps, calls } = fakes();
  const result = await regenerateFixPr(7, deps);

  assert.equal(result.status, "updated");
  assert.deepEqual(calls.patchedFrom, [`${ENTRY} | ${BASE}`]); // not from the PR's own (bad) version
  const [update] = calls.updates;
  assert.equal(update.content, FLAGGED); // the model's extra trailing blank lines are gone
  assert.equal(update.title, "Needs review: payment_method_details.blik.expires_after");
  assert.ok(update.body.includes(`> ${ENTRY}`) && update.body.startsWith("Only added a TODO for review."));
});

test("a dry run shows the new patch without touching the PR", async () => {
  const { deps, calls } = fakes();
  const result = await regenerateFixPr(7, deps, { dryRun: true });
  if (result.status !== "would_update") return assert.fail(`expected would_update, got ${result.status}`);
  assert.equal(result.before, OLD_PATCH);
  assert.equal(result.after, FLAGGED);
  assert.deepEqual(calls.updates, []);
});

test("nothing is pushed when the new patch changes nothing, or matches the PR already", async () => {
  const noChange = fakes({}, BASE);
  assert.equal((await regenerateFixPr(7, noChange.deps)).status, "unchanged");
  const same = fakes({}, OLD_PATCH);
  assert.equal((await regenerateFixPr(7, same.deps)).status, "unchanged");
  assert.deepEqual([...noChange.calls.updates, ...same.calls.updates], []);
});

test("only open, single-file api-dependabot PRs that quote their entry are regenerated", async () => {
  const refused: [Partial<FixPr>, RegExp][] = [
    [{ state: "closed" }, /is closed; reopen it first/],
    [{ headRef: "feature/login" }, /wasn't opened by api-dependabot/],
    [{ files: ["a.js", "b.js"] }, /changes 2 files/],
    [{ body: "Some description" }, /doesn't quote the changelog entry/],
  ];
  for (const [pr, message] of refused) {
    const { deps, calls } = fakes(pr);
    await assert.rejects(regenerateFixPr(7, deps), message);
    assert.deepEqual(calls.patchedFrom, []); // refused before spending a model call
  }
});

test("a PR opened before bodies quoted related lines gets them from its release's notes", async () => {
  const { deps, calls } = fakes();
  const asked: string[] = [];
  deps.releaseNotes = async (version) => {
    asked.push(version);
    return "* Add support for `expires_at` on `Mandate.payment_method_details.blik`\n* ⚠️ Remove support for `expires_after` on `Mandate.payment_method_details.blik`\n* Add support for `momo` on `PaymentRecord`";
  };
  await regenerateFixPr(7, deps);
  assert.deepEqual(asked, ["v22.7.0-alpha.4"]);
  assert.deepEqual(calls.related, [[
    "* Add support for `expires_at` on `Mandate.payment_method_details.blik`",
    "* ⚠️ Remove support for `expires_after` on `Mandate.payment_method_details.blik`",
  ]]);
  assert.match(calls.updates[0].body, /Related lines in the same release notes:\n> \* Add support for `expires_at`/);
});

test("related lines the PR body already quotes are used as they are", async () => {
  const { deps, calls } = fakes({ body: fixPrBody("Flagged it.", ENTRY, ["quoted line"]) });
  deps.releaseNotes = async () => assert.fail("the body has the lines");
  await regenerateFixPr(7, deps);
  assert.deepEqual(calls.related, [["quoted line"]]);
});

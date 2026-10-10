import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectedChange } from "./changes.js";
import { entryFromPrBody, fixBranchName, fixPrBody, matchFileEnding, processReleases, type PipelineDeps } from "./pipeline.js";

const change: DetectedChange = {
  version: "v18.0.0",
  entry: "v18.0.0: `charges.create` removed. Use `paymentIntents.create` instead.",
  methodName: "charges.create",
};
const opts = { repoPath: "/repo", targetPackage: "stripe" };

/** A fake GitHub + model: remembers the PRs it opened, and can fail a file's first PR. Files are
 * real (one-line) code, since a patch that doesn't parse never becomes a PR. */
function fakes(failFirstPrFor: string[] = []) {
  const prs = new Map<string, string>();
  const failing = new Set(failFirstPrFor);
  const calls = { generatePatch: [] as string[], markedSeen: [] as string[], scanned: [] as string[] };
  const deps: PipelineDeps = {
    findUsages: (_repo, _pkg, methodName) => {
      calls.scanned.push(`calls to ${methodName}`);
      return ["a.js", "b.js"].map((f) => ({ filePath: `/repo/${f}`, lineNumbers: [5], snippet: `stripe.call("old ${f}");\n` }));
    },
    findFieldUsages: (_repo, _pkg, fieldPath) => {
      calls.scanned.push(`reads of ${fieldPath}`);
      return [{ filePath: "/repo/c.js", lineNumbers: [9], snippet: 'use("old c.js");\n' }];
    },
    generatePatch: async (_entry, file, code) => {
      calls.generatePatch.push(file);
      return { explanation: "fixed", patchedCode: code.replace("old", "new") };
    },
    findFixPr: async (branch) => prs.get(branch) ?? null,
    openFixPr: async (branch, file) => {
      if (failing.delete(file)) throw new Error("GitHub 502");
      const url = `https://github.com/me/repo/pull/${prs.size + 1}`;
      prs.set(branch, url);
      return url;
    },
    markReleasesSeen: (tag) => void calls.markedSeen.push(tag),
  };
  return { deps, calls };
}

test("releases are marked seen once every change and file went through", async () => {
  const { deps, calls } = fakes();
  const result = await processReleases({ changes: [change], latestTag: "v18.0.0" }, deps, opts);

  assert.deepEqual(result.changes[0].patches.map((p) => p.status), ["pr_opened", "pr_opened"]);
  assert.equal(result.markedSeen, true);
  assert.deepEqual(calls.markedSeen, ["v18.0.0"]);
});

test("a failed PR leaves the releases unseen, and the retry only redoes that file", async () => {
  const { deps, calls } = fakes(["b.js"]);

  const first = await processReleases({ changes: [change], latestTag: "v18.0.0" }, deps, opts);
  assert.deepEqual(first.changes[0].patches.map((p) => p.status), ["pr_opened", "error"]);
  assert.equal(first.markedSeen, false);

  calls.generatePatch.length = 0;
  const retry = await processReleases({ changes: [change], latestTag: "v18.0.0" }, deps, opts);

  // a.js already has its PR: no second PR, and no model call spent on it
  assert.deepEqual(retry.changes[0].patches.map((p) => [p.filePath, p.status]), [["a.js", "pr_exists"], ["b.js", "pr_opened"]]);
  assert.deepEqual(calls.generatePatch, ["/repo/b.js"]);
  assert.deepEqual(calls.markedSeen, ["v18.0.0"]);
});

test("a batch with no breaking changes still marks its releases seen", async () => {
  const { deps, calls } = fakes();
  await processReleases({ changes: [], latestTag: "v19.0.0" }, deps, opts);
  assert.deepEqual(calls.markedSeen, ["v19.0.0"]);
});

test("a change that fails outright (e.g. the scan throws) also blocks the marker", async () => {
  const { deps, calls } = fakes();
  deps.findUsages = () => {
    throw new Error("parse error");
  };
  const result = await processReleases({ changes: [change], latestTag: "v18.0.0" }, deps, opts);
  assert.equal(result.changes[0].error, "parse error");
  assert.deepEqual(calls.markedSeen, []);
});

test("fix branch names are stable and valid git refs whatever the input", () => {
  assert.equal(fixBranchName(change, "src/billing.js"), fixBranchName(change, "src/billing.js"));
  assert.notEqual(fixBranchName(change, "a.js"), fixBranchName(change, "b.js"));

  const weird = fixBranchName({ ...change, version: "..v1 ~^:?*[", methodName: "a..b\\c d" }, "../x.lock/");
  assert.match(weird, /^api-dependabot\/[A-Za-z0-9._-]+$/);
  assert.doesNotMatch(weird, /\.\.|[.-]$|\/[.-]/);
});

test("releases whose changelog couldn't be read stay unseen, even with no failed fixes", async () => {
  const { deps, calls } = fakes();
  const result = await processReleases(
    { changes: [], latestTag: "v22.7.0-alpha.5", notesProblems: ["v22.7.0-alpha.5: couldn't be read"] },
    deps,
    opts
  );
  assert.equal(result.markedSeen, false);
  assert.deepEqual(calls.markedSeen, []);
});

test("a field change is scanned for reads of the field, and named after it", async () => {
  const { deps, calls } = fakes();
  const field: DetectedChange = {
    version: "v22.7.0-alpha.4",
    entry: "v22.7.0-alpha.4: `Mandate.payment_method_details.blik.expires_after` removed.",
    fieldPath: "payment_method_details.blik.expires_after",
  };
  const opened: string[] = [];
  const openFixPr = deps.openFixPr;
  deps.openFixPr = async (branch, file, content, title, body) => {
    opened.push(`${branch} | ${title}`);
    return openFixPr(branch, file, content, title, body);
  };

  const result = await processReleases({ changes: [field], latestTag: "v22.7.0-alpha.4" }, deps, opts);

  assert.deepEqual(calls.scanned, ["reads of payment_method_details.blik.expires_after"]);
  assert.equal(result.changes[0].fieldPath, "payment_method_details.blik.expires_after");
  assert.deepEqual(opened, [
    "api-dependabot/v22.7.0-alpha.4-payment_method_details.blik.expires_after-c.js | Fix breaking change: payment_method_details.blik.expires_after",
  ]);
});

test("a patch that doesn't parse, or replaces the file, never becomes a PR", async () => {
  for (const patchedCode of ["stripe.call(\"new\";\n", "// fixed\n"]) {
    const { deps, calls } = fakes();
    const opened: string[] = [];
    deps.findUsages = () => [{ filePath: "/repo/a.js", lineNumbers: [1], snippet: 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nstripe.call("old");\n' }];
    deps.generatePatch = async () => ({ explanation: "fixed", patchedCode });
    deps.openFixPr = async (_branch, file) => (opened.push(file), "https://github.com/me/repo/pull/1");

    const result = await processReleases({ changes: [change], latestTag: "v18.0.0" }, deps, opts);

    assert.deepEqual(opened, []);
    assert.equal(result.changes[0].patches[0].status, "error");
    assert.match(result.changes[0].patches[0].error!, /^patch rejected: /);
    assert.deepEqual(calls.markedSeen, []); // retried on the next run
  }
});

test("a patch that only flags the code for review isn't titled a fix", async () => {
  const { deps } = fakes();
  deps.generatePatch = async (_entry, _file, code) => ({
    explanation: "Only added a TODO for review: the field was removed with no replacement.",
    patchedCode: `// TODO(api-dependabot): v1 removed \`x.y\`.\n${code}`,
  });
  const titles: string[] = [];
  deps.openFixPr = async (_branch, _file, _content, title) => {
    titles.push(title);
    return "https://github.com/me/repo/pull/9";
  };
  await processReleases({ changes: [change], latestTag: "v18.0.0" }, deps, opts);
  assert.deepEqual(titles, ["Needs review: charges.create", "Needs review: charges.create"]);
});

test("a patch keeps the file's own ending and line breaks", () => {
  assert.equal(matchFileEnding("a\nb\n\n\n", "a\n"), "a\nb\n");
  assert.equal(matchFileEnding("a\nb\n", "a"), "a\nb"); // no final newline stays that way
  assert.equal(matchFileEnding("a\nb\n", "a\r\nc\r\n"), "a\r\nb\r\n"); // CRLF file: not a whole-file diff
});

test("a patch that only differs by its ending counts as no change", async () => {
  const { deps } = fakes();
  deps.generatePatch = async (_entry, _file, code) => ({ explanation: "nothing to do", patchedCode: `${code}\n\n` });
  const result = await processReleases({ changes: [change], latestTag: "v18.0.0" }, deps, opts);
  assert.deepEqual(result.changes[0].patches.map((p) => p.status), ["no_change_needed", "no_change_needed"]);
});

test("the entry quoted in a fix PR's body reads back, including merged entries", () => {
  const entry = "v1: `a` removed.\nv1: `a` parameter `b` removed.";
  assert.equal(entryFromPrBody(fixPrBody("Did a thing.", entry)), entry);
  assert.equal(entryFromPrBody(`${fixPrBody("x", "v1: y")}\n\nRegenerated with \`npm run regenerate\`.`), "v1: y");
  assert.equal(entryFromPrBody("No quote here."), null);
});

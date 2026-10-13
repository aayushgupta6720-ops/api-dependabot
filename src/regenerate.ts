/**
 * Regenerate a fix PR's patch with the current prompt, in place:
 *
 *   npm run regenerate -- <PR number> [--dry-run]
 *
 * The pipeline never revisits a file that already has a PR (see findFixPr),
 * so a PR opened by an older prompt keeps its patch until this is run. It
 * reads the changelog entry from the PR's body and the file as it is at the
 * PR's base commit (not the PR's own version), asks for a new patch, commits
 * it to the PR's branch, and updates the title and body to match.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FixPr } from "./githubClient.js";
import type { PatchResult } from "./llmClient.js";
import { entryFromPrBody, fixPrBody, fixPrTitle, matchFileEnding, relatedFromPrBody } from "./pipeline.js";
import { relatedLines } from "./releaseNotes.js";

/** GitHub and model calls, passed in so tests can fake them. */
export interface RegenerateDeps {
  getFixPr(number: number): Promise<FixPr>;
  readRepoFile(filePath: string, ref: string): Promise<{ content: string; sha: string }>;
  generatePatch(changelogEntry: string, affectedFilePath: string, affectedCode: string, related?: string[]): Promise<PatchResult>;
  updateFixPr(pr: FixPr, filePath: string, content: string, title: string, body: string): Promise<void>;
  // The notes of the release a tag names, for a PR opened before its body
  // quoted related lines; null if there's no such release.
  releaseNotes?(version: string): Promise<string | null>;
}

export type RegenerateResult =
  | { status: "updated" | "would_update"; url: string; filePath: string; title: string; explanation: string; before: string; after: string }
  | { status: "unchanged"; url: string; reason: string };

export async function regenerateFixPr(
  number: number,
  deps: RegenerateDeps,
  opts: { dryRun?: boolean } = {}
): Promise<RegenerateResult> {
  const pr = await deps.getFixPr(number);
  if (pr.state !== "open") throw new Error(`PR #${number} is ${pr.state}; reopen it first.`);
  if (!pr.headRef.startsWith("api-dependabot/")) {
    throw new Error(`PR #${number} wasn't opened by api-dependabot (its branch is ${pr.headRef}).`);
  }
  if (pr.files.length !== 1) throw new Error(`PR #${number} changes ${pr.files.length} files; a fix PR changes one.`);
  const entry = entryFromPrBody(pr.body);
  if (!entry) throw new Error(`PR #${number}'s body doesn't quote the changelog entry it answers.`);

  // A PR opened before bodies quoted related lines gets them from its release's notes.
  let related = relatedFromPrBody(pr.body) ?? [];
  const version = entry.match(/^(v?\d[^:\s]*):/)?.[1];
  if (related.length === 0 && version && deps.releaseNotes) {
    const notes = await deps.releaseNotes(version);
    if (notes) related = relatedLines(notes, entry);
  }

  const [filePath] = pr.files;
  const original = (await deps.readRepoFile(filePath, pr.baseSha)).content;
  const current = (await deps.readRepoFile(filePath, pr.headRef)).content;
  const patch = await deps.generatePatch(entry, filePath, original, related);
  const patched = matchFileEnding(patch.patchedCode, original);

  if (patched === original) {
    return { status: "unchanged", url: pr.url, reason: "The new patch changes nothing. If the code no longer needs a fix, close the PR." };
  }
  if (patched === current) {
    return { status: "unchanged", url: pr.url, reason: "The new patch is the one the PR already has." };
  }

  // "Fix breaking change: <target>" or "Needs review: <target>"
  const target = pr.title.includes(": ") ? pr.title.slice(pr.title.indexOf(": ") + 2) : pr.title;
  const title = fixPrTitle(target, patched, original);
  const body = `${fixPrBody(patch.explanation, entry, related)}\n\nRegenerated with \`npm run regenerate\`.`;
  if (!opts.dryRun) await deps.updateFixPr(pr, filePath, patched, title, body);
  return {
    status: opts.dryRun ? "would_update" : "updated",
    url: pr.url,
    filePath,
    title,
    explanation: patch.explanation,
    before: current,
    after: patched,
  };
}

/** A unified diff of the PR's file, from what it has now to the new patch. */
function diff(before: string, after: string, filePath: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "regenerate-"));
  for (const [side, content] of [["a", before], ["b", after]]) {
    mkdirSync(path.dirname(path.join(dir, side, filePath)), { recursive: true });
    writeFileSync(path.join(dir, side, filePath), content);
  }
  try {
    // Run from inside the temp dir with no extra prefix, so the header reads a/<path> and b/<path>.
    const args = ["diff", "--no-index", "--no-color", "--no-prefix", `a/${filePath}`, `b/${filePath}`];
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    return "";
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ""; // git diff exits 1 when the files differ
  }
}

async function main() {
  const args = process.argv.slice(2);
  const number = Number(args.find((a) => /^\d+$/.test(a)));
  if (!number) {
    console.error("Usage: npm run regenerate -- <PR number> [--dry-run]");
    process.exit(2);
  }
  // Imported here rather than at the top: they read API keys on import, and
  // the tests import this module without any.
  const { getFixPr, readRepoFile, updateFixPr } = await import("./githubClient.js");
  const { generatePatch } = await import("./llmClient.js");
  const { fetchReleaseNotes } = await import("./changelogWatcher.js");

  const dryRun = args.includes("--dry-run");
  const result = await regenerateFixPr(
    number,
    { getFixPr, readRepoFile, generatePatch, updateFixPr, releaseNotes: fetchReleaseNotes },
    { dryRun }
  );

  if (result.status === "unchanged") {
    console.log(`${result.url}: left as it is. ${result.reason}`);
    return;
  }
  console.log(`${result.explanation}\n\n${diff(result.before, result.after, result.filePath)}`);
  console.log(
    result.status === "updated"
      ? `Updated ${result.url}: "${result.title}"`
      : `Dry run: ${result.url} would get this patch, titled "${result.title}". Run without --dry-run to apply it.`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

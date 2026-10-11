/**
 * The agent on a real repo: vercel/nextjs-subscription-payments at the commit
 * before it upgraded stripe from 8.201.0 to 11.13.0 (0f2204bf5). What the
 * upgrade really broke is measured, not guessed: the type errors its
 * stripe-using files get under 11.13.0's declarations that they didn't have
 * under 8.201.0's. Then the agent reads the three majors in between, scans
 * the repo and patches, with PRs recorded instead of opened, and each patch is
 * type-checked against 11.13.0 the same way.
 *
 *     npm run eval:real     # downloads the repo's source (never installs or runs it), a few model calls
 *
 * The maintainers' upgrade commit fixed two things, the same two the oracle
 * finds: the pinned API version, and the Subscription status type that
 * gained "paused".
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Project, ts } from "ts-morph";
import { fetchRepoFile } from "../changelogWatcher.js";
import { extractBreakingChanges, generatePatch } from "../llmClient.js";
import { processReleases } from "../pipeline.js";
import { apiVersionChange, resolveReleaseNotes, type Release } from "../releaseNotes.js";
import { findApiVersionPins, findFieldUsages, findUsages } from "../scanner.js";
import { addedErrors, sdkRoot } from "./sdkTypes.js";

const REPO = "vercel/nextjs-subscription-payments";
const COMMIT = "9628c7b937a7f4774e13fa0203aba576f27cdbf1"; // the parent of the upgrade, 0f2204bf5
const FROM = "8.201.0";
const TO = "11.13.0";
const RELEASES = ["v9.0.0", "v10.0.0", "v11.0.0"]; // the majors in between, where the breaking changes are

/** The repo's source at COMMIT, fetched once into .cache/real/. */
function checkout(): string {
  const dir = path.resolve(".cache", "real", REPO.replace("/", "__"));
  if (!existsSync(path.join(dir, "package.json"))) {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", `https://github.com/${REPO}.git`, COMMIT);
    git("checkout", "-q", "FETCH_HEAD");
  }
  return dir;
}

/** Type errors per file ("file:line TSxxxx: message"), with `stripe` resolved to `version`.
 * `overrides` replaces some files' contents (a patch) before checking. */
function typeErrors(repo: string, files: string[], version: string, overrides: Record<string, string> = {}): string[] {
  const project = new Project({
    compilerOptions: {
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      skipLibCheck: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      baseUrl: repo,
      paths: { stripe: [path.join(sdkRoot("stripe", version), "node_modules", "stripe")] },
      types: ["node"],
      typeRoots: [path.resolve("node_modules", "@types")],
    },
  });
  for (const file of files) {
    const full = path.join(repo, file);
    project.createSourceFile(full, overrides[file] ?? readFileSync(full, "utf8"), { overwrite: true });
  }
  return project
    .getPreEmitDiagnostics()
    .filter((d) => d.getSourceFile()?.getFilePath().startsWith(repo))
    .map((d) => {
      const file = path.relative(repo, d.getSourceFile()!.getFilePath());
      const message = ts.flattenDiagnosticMessageText(d.compilerObject.messageText, " ");
      return `${file}:${d.getLineNumber()} TS${d.getCode()}: ${message}`;
    });
}

/** The errors in `after` that `before` didn't have, compared without line numbers. */
function added(before: string[], after: string[]): string[] {
  const key = (e: string) => e.replace(/:\d+ /, " ");
  const fresh = addedErrors(before.map(key), after.map(key));
  return after.filter((e) => {
    const i = fresh.indexOf(key(e));
    if (i === -1) return false;
    fresh.splice(i, 1);
    return true;
  });
}

async function main() {
  const repo = checkout();
  const files = execFileSync("git", ["-C", repo, "ls-files", "*.ts", "*.tsx"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && readFileSync(path.join(repo, f), "utf8").match(/from ['"]stripe['"]|utils\/stripe/));
  const broken = added(typeErrors(repo, files, FROM), typeErrors(repo, files, TO));
  console.log(`What upgrading stripe ${FROM} -> ${TO} breaks in ${REPO} (type errors it adds):`);
  for (const e of broken) console.log(`  ${e.slice(0, 200)}`);

  const releases: Release[] = [];
  for (const tag of RELEASES) {
    const res = await fetch(`https://api.github.com/repos/stripe/stripe-node/releases/tags/${tag}`);
    releases.push({ version: tag, notes: ((await res.json()) as { body?: string }).body ?? "" });
  }
  const notes = await resolveReleaseNotes(releases, "stripe/stripe-node", fetchRepoFile);
  const extraction = await extractBreakingChanges("stripe", notes.releases);
  const pin = apiVersionChange(notes.releases);
  const problems = [...notes.problems, ...extraction.problems];
  console.log(`\nThe agent read ${RELEASES.join(", ")}: ${extraction.changes.length} changes to scan for, ` +
    `${extraction.notPatched.length} with nothing to patch${pin ? `, and the API version pin ${pin.apiVersion}` : ""}; ` +
    `${problems.length} problems${problems.length ? `: ${problems.join("; ")}` : ""}.`);

  const opened: { file: string; content: string; title: string }[] = [];
  await processReleases(
    { changes: [...extraction.changes, ...(pin ? [pin] : [])], latestTag: null, notesProblems: problems },
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
      markReleasesSeen: () => {},
    },
    { repoPath: repo, targetPackage: "stripe" }
  );

  // Apply every PR (the last one per file wins, as merging them in order would) and re-check. Counted
  // per file, since a patch moves lines and can turn one error into another on the same line.
  const patched = Object.fromEntries(opened.map((pr) => [pr.file, pr.content]));
  const remaining = added(typeErrors(repo, files, FROM), typeErrors(repo, files, TO, patched));
  const count = (errors: string[], file: string) => errors.filter((e) => e.startsWith(`${file}:`)).length;
  const touched = [...new Set([...broken, ...remaining].map((e) => e.split(":")[0]))];
  const fixed = touched.reduce((n, f) => n + Math.max(0, count(broken, f) - count(remaining, f)), 0);
  const introduced = touched.reduce((n, f) => n + Math.max(0, count(remaining, f) - count(broken, f)), 0);
  const needless = opened.filter((pr) => count(broken, pr.file) === 0);
  console.log(`\nPRs: ${opened.map((pr) => `${pr.file} (${pr.title})`).join(", ") || "none"}`);
  console.log(`Fixed ${fixed} of ${broken.length} breakages; ${needless.length} PR(s) on files the upgrade didn't break; ` +
    `${introduced} new type error(s) from the patches.`);
  for (const e of remaining) console.log(`  still broken: ${e.slice(0, 200)}`);

  const dir = path.join("eval-results", "real");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ repo: REPO, commit: COMMIT, from: FROM, to: TO, broken, fixed, introduced, remaining, problems, extraction, pin, opened }, null, 2));
  console.log(`Full results written to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

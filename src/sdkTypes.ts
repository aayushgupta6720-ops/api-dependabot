import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Project, ts } from "ts-morph";

// The SDK as published at a release, unpacked once into
// .cache/sdk/<package>@<version>/node_modules/<package>. stripe-node ships its
// own type declarations (since v8), so a patch can be type-checked against the
// SDK it was written for, not just parsed: by the eval, and before a fix PR
// opens.
const CACHE = path.resolve(".cache", "sdk");
const NODE_TYPES = path.resolve("node_modules", "@types");

/** A directory whose node_modules holds `pkg` at `version`, downloaded the first time. */
export function sdkRoot(pkg: string, version: string): string {
  const root = path.join(CACHE, `${pkg}@${version}`);
  const installed = path.join(root, "node_modules", pkg);
  if (existsSync(path.join(installed, "package.json"))) return root;
  mkdirSync(path.dirname(installed), { recursive: true });
  const tmp = mkdtempSync(path.join(CACHE, ".download-"));
  try {
    const tarball = execFileSync("npm", ["pack", `${pkg}@${version}`, "--silent", "--pack-destination", tmp], {
      encoding: "utf8",
    }).trim().split("\n").at(-1)!;
    execFileSync("tar", ["-xzf", path.join(tmp, tarball), "-C", tmp]);
    renameSync(path.join(tmp, "package"), installed);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return root;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: false, // patched files are often plain JavaScript; only what the SDK's types rule out counts
  noEmit: true,
  esModuleInterop: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, // follows package.json "exports", as newer stripe needs
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
  types: ["node"],
  typeRoots: [NODE_TYPES],
};

/** Type errors in `code`, as a TypeScript file next to `pkg` in `root`.
 * Messages only, without positions, so two versions of a file compare. Null
 * if that version of the package ships no type declarations (stripe before v8). */
export function typeErrors(root: string, code: string, pkg = "stripe"): string[] | null {
  const fileName = path.join(root, "check.ts");
  const resolved = ts.resolveModuleName(pkg, fileName, COMPILER_OPTIONS, ts.sys).resolvedModule;
  if (!resolved?.extension.startsWith(".d.")) return null;
  const project = new Project({ compilerOptions: COMPILER_OPTIONS });
  const file = project.createSourceFile(fileName, code, { overwrite: true });
  return project
    .getPreEmitDiagnostics()
    .filter((d) => d.getSourceFile()?.getFilePath() === file.getFilePath())
    .map((d) => `TS${d.getCode()}: ${ts.flattenDiagnosticMessageText(d.compilerObject.messageText, " ")}`);
}

/** The errors in `after` that `before` didn't have (counting repeats). */
export function addedErrors(before: string[], after: string[]): string[] {
  const left = [...before];
  return after.filter((e) => {
    const i = left.indexOf(e);
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
}

/** The type errors `after` has that `before` didn't, against `pkg` at
 * `release` (a tag, with or without its v). Null when they can't be checked:
 * that version ships no type declarations, or it couldn't be downloaded. */
export function addedTypeErrors(pkg: string, release: string, before: string, after: string): string[] | null {
  let root: string;
  try {
    root = sdkRoot(pkg, release.replace(/^v/, ""));
  } catch {
    return null;
  }
  const was = typeErrors(root, before, pkg);
  const now = was && typeErrors(root, after, pkg);
  return was && now ? addedErrors(was, now) : null;
}

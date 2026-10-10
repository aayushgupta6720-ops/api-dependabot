import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which SDK releases matter to the repo being patched. A fix for a breaking
 * change only belongs in a repo that will upgrade past it: one already on a
 * later version has it, and one on stable releases shouldn't be patched for an
 * alpha's change (PR #7 patched an alpha.4 removal into code that, on stable,
 * still had the field).
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[]; // "alpha.4" -> ["alpha", "4"]; empty for a stable release
}

/** "v23.1.0-beta.1", "23.0.0" -> a Version; null if it isn't one. */
export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence: negative if a < b. A pre-release sorts before its release. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a release is one this repo will meet when it upgrades: newer than
 * what's installed, and a pre-release only if the repo is itself on one. With
 * no installed version known, stable releases only.
 */
export function isRelevant(tag: string, installed: string | null): boolean {
  const release = parseVersion(tag);
  if (!release) return true; // a tag we can't read: look at it rather than miss it
  const current = installed ? parseVersion(installed) : null;
  if (!current) return release.pre.length === 0;
  if (release.pre.length && !current.pre.length) return false;
  return compareVersions(release, current) > 0;
}

/**
 * The version of `packageName` the repo has: the exact one in
 * package-lock.json if there is one, else the lowest its package.json range
 * allows ("^22.6.0" -> 22.6.0). Null if neither says.
 */
export function installedVersion(repoPath: string, packageName: string): string | null {
  const lock = path.join(repoPath, "package-lock.json");
  if (existsSync(lock)) {
    try {
      const data = JSON.parse(readFileSync(lock, "utf8"));
      const version = data.packages?.[`node_modules/${packageName}`]?.version ?? data.dependencies?.[packageName]?.version;
      if (typeof version === "string" && parseVersion(version)) return version;
    } catch {
      // an unreadable lockfile: fall back to package.json
    }
  }
  const manifest = path.join(repoPath, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    const range: unknown = data.dependencies?.[packageName] ?? data.devDependencies?.[packageName];
    if (typeof range !== "string") return null;
    const lowest = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range)?.[1];
    return lowest && parseVersion(lowest) ? lowest : null;
  } catch {
    return null;
  }
}

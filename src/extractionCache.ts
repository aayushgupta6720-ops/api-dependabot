import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EXTRACTION_VERSION, MODEL, type Extraction, type ReleaseNotes } from "./llmClient.js";

/**
 * What the model read from each release's notes, so reading a release costs its
 * requests once. A release stays unseen until every fix for it lands, and each
 * daily run used to read it again: stripe-node v23.0.0 is 9 requests, and two
 * runs three minutes apart came back with 52 and 55 changes. The key is
 * everything that shapes the reading (package, release, its notes, the model,
 * EXTRACTION_VERSION), so changed notes or a new prompt are read afresh.
 */
export interface CachedRelease {
  savedAt: string;
  changes: Extraction["changes"];
  notPatched: Extraction["notPatched"];
}

export type ExtractionCache = Record<string, CachedRelease>;

const KEEP_DAYS = 90; // a release unseen this long has other problems; reading it again is fine

export function extractionKey(packageName: string, release: ReleaseNotes): string {
  return createHash("sha256")
    .update([packageName, release.version, release.notes, MODEL, EXTRACTION_VERSION].join("\0"))
    .digest("hex");
}

/**
 * `extract` run on the releases not in `cache`, and the cached readings of the
 * rest. A fresh reading is cached only if no problem names its release, and
 * none is cached when a problem names no release at all: a misread release
 * must be read again next time, not reused.
 */
export async function extractWithCache(
  packageName: string,
  releases: ReleaseNotes[],
  cache: ExtractionCache,
  extract: (packageName: string, releases: ReleaseNotes[]) => Promise<Extraction>,
  now: Date = new Date()
): Promise<Extraction & { reused: string[] }> {
  const cached = releases.filter((r) => cache[extractionKey(packageName, r)]);
  const fresh = releases.filter((r) => !cache[extractionKey(packageName, r)]);
  const found = fresh.length > 0 ? await extract(packageName, fresh) : { changes: [], notPatched: [], problems: [] };

  const unattributed = found.problems.some((p) => !fresh.some((r) => p.includes(r.version)));
  for (const r of unattributed ? [] : fresh) {
    if (found.problems.some((p) => p.includes(r.version))) continue;
    cache[extractionKey(packageName, r)] = {
      savedAt: now.toISOString(),
      changes: found.changes.filter((c) => c.version === r.version),
      notPatched: found.notPatched.filter((n) => n.version === r.version),
    };
  }

  // In release order, as a single reading would be: the pipeline handles changes in that order.
  const freshVersions = new Set(fresh.map((r) => r.version));
  const part = <T extends { version: string }>(r: ReleaseNotes, cachedItems: T[], freshItems: T[]) =>
    freshVersions.has(r.version) ? freshItems.filter((c) => c.version === r.version) : cachedItems;
  const stray = <T extends { version: string }>(items: T[]) => items.filter((c) => !freshVersions.has(c.version));
  const hit = (r: ReleaseNotes) => cache[extractionKey(packageName, r)] ?? { changes: [], notPatched: [] };
  return {
    changes: [...releases.flatMap((r) => part(r, hit(r).changes, found.changes)), ...stray(found.changes)],
    notPatched: [...releases.flatMap((r) => part(r, hit(r).notPatched, found.notPatched)), ...stray(found.notPatched)],
    problems: found.problems,
    reused: cached.map((r) => r.version),
  };
}

export function loadExtractionCache(path: string): ExtractionCache {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/** Saves the cache, dropping readings older than KEEP_DAYS so it stays small. */
export function saveExtractionCache(path: string, cache: ExtractionCache, now: Date = new Date()): void {
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 3600 * 1000;
  const kept = Object.fromEntries(Object.entries(cache).filter(([, c]) => Date.parse(c.savedAt) >= cutoff));
  writeFileSync(path, JSON.stringify(kept, null, 2));
}

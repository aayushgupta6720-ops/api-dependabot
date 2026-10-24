import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.GEMINI_API_KEY ??= "unused";
process.env.GITHUB_TOKEN ??= "unused";
process.env.TARGET_REPO ??= "me/repo";

const { extractWithCache, loadExtractionCache, saveExtractionCache } = await import("./extractionCache.js");
type Extraction = Awaited<ReturnType<typeof import("./llmClient.js").extractBreakingChanges>>;

const v1 = { version: "v1.0.0", notes: "* ⚠️ Remove `charges.capture`" };
const v2 = { version: "v2.0.0", notes: "* ⚠️ Remove `refunds.cancel`" };

/** A fake model reading: one change per release it's given, plus any `problems`. */
function reader(problems: (versions: string[]) => string[] = () => []) {
  const asked: string[][] = [];
  const extract = async (_pkg: string, releases: { version: string }[]): Promise<Extraction> => {
    asked.push(releases.map((r) => r.version));
    return {
      changes: releases.map((r) => ({ version: r.version, entry: `${r.version} change`, methodName: "x" })),
      notPatched: [],
      problems: problems(releases.map((r) => r.version)),
    };
  };
  return { asked, extract };
}

test("a release read once isn't sent to the model again, and changes keep release order", async () => {
  const cache = {};
  const { asked, extract } = reader();
  await extractWithCache("stripe", [v1], cache, extract);
  const second = await extractWithCache("stripe", [v1, v2], cache, extract);
  assert.deepEqual(asked, [["v1.0.0"], ["v2.0.0"]]);
  assert.deepEqual(second.changes.map((c) => c.version), ["v1.0.0", "v2.0.0"]);
  assert.deepEqual(second.reused, ["v1.0.0"]);
});

test("a release the reading had a problem with is read again next time; the others aren't", async () => {
  const cache = {};
  const { asked, extract } = reader((versions) => (versions.includes("v2.0.0") ? ["v2.0.0: the model reported nothing"] : []));
  await extractWithCache("stripe", [v1, v2], cache, extract);
  await extractWithCache("stripe", [v1, v2], cache, extract);
  assert.deepEqual(asked, [["v1.0.0", "v2.0.0"], ["v2.0.0"]]);
});

test("a problem that names no release keeps the whole reading out of the cache", async () => {
  const cache = {};
  const { asked, extract } = reader(() => ["the model described a breaking change unusably: {}"]);
  await extractWithCache("stripe", [v1], cache, extract);
  await extractWithCache("stripe", [v1], cache, extract);
  assert.deepEqual(asked, [["v1.0.0"], ["v1.0.0"]]);
});

test("edited notes are read afresh", async () => {
  const cache = {};
  const { asked, extract } = reader();
  await extractWithCache("stripe", [v1], cache, extract);
  await extractWithCache("stripe", [{ ...v1, notes: `${v1.notes}\n* ⚠️ Remove \`charges.list\`` }], cache, extract);
  assert.deepEqual(asked, [["v1.0.0"], ["v1.0.0"]]);
});

test("saving drops readings older than 90 days", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "extract-")), "cache.json");
  const now = new Date("2026-10-25T00:00:00Z");
  saveExtractionCache(file, {
    old: { savedAt: "2026-07-01T00:00:00Z", changes: [], notPatched: [] },
    recent: { savedAt: "2026-10-01T00:00:00Z", changes: [], notPatched: [] },
  }, now);
  assert.deepEqual(Object.keys(loadExtractionCache(file)), ["recent"]);
});

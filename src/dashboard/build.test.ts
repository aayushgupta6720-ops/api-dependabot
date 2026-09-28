import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildStaticDashboard } from "./build.js";
import { API_FILES } from "./server.js";

const dir = mkdtempSync(path.join(tmpdir(), "dashboard-build-"));
const paths = {
  runLog: path.join(dir, "run-log.jsonl"),
  state: path.join(dir, "state.json"),
  evalResults: path.join(dir, "eval-results"),
};
const out = path.join(dir, "site");

mkdirSync(paths.evalResults);
const run = { runId: "r", startedAt: "2026-09-26T00:00:00.000Z", durationMs: 1, targetPackageRepo: "x/y", changesFound: 0, changes: [] };
writeFileSync(paths.runLog, JSON.stringify(run) + "\n");
writeFileSync(path.join(paths.evalResults, "2026-09-26T00-00-00-000Z.json"), JSON.stringify([{ id: "a", pass: true, failures: [] }]));
writeFileSync(paths.state, JSON.stringify({ lastSeenTag: "v1.0.0" }));
buildStaticDashboard(out, paths);

test("each API response is written where the page fetches it", () => {
  for (const [file, read] of API_FILES) {
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, "api", file), "utf8")), read(paths), file);
  }
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, "api", "status.json"), "utf8")), {
    lastSeenTag: "v1.0.0",
    lastRunAt: "2026-09-26T00:00:00.000Z",
  });
});

test("the page is copied and only uses relative URLs, so it works under a subpath", () => {
  const html = readFileSync(path.join(out, "index.html"), "utf8");
  assert.ok(readFileSync(path.join(out, "render.js"), "utf8").includes("export function renderRuns"));
  // GitHub Pages serves the copy from /<repo>/, where "/api/..." would miss.
  assert.doesNotMatch(html, /["'(]\/(api|render\.js)/);
  for (const file of API_FILES.keys()) assert.ok(html.includes(`"api/${file}"`), file);
});

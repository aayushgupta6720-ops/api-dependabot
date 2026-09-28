import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createDashboardServer } from "./server.js";

const dir = mkdtempSync(path.join(tmpdir(), "dashboard-"));
const paths = {
  runLog: path.join(dir, "run-log.jsonl"),
  state: path.join(dir, "state.json"),
  evalResults: path.join(dir, "eval-results"),
};
const server = createDashboardServer(paths);
let port = 0;

before(async () => {
  mkdirSync(paths.evalResults);
  const run = { runId: "r", startedAt: "2026-09-26T00:00:00.000Z", durationMs: 1, targetPackageRepo: "x/y", changesFound: 0, changes: [] };
  // a good line, then one cut off mid-write
  writeFileSync(paths.runLog, JSON.stringify(run) + '\n{"runId": "partial\n');
  writeFileSync(path.join(paths.evalResults, "2026-09-26T00-00-00-000Z.json"), JSON.stringify([{ id: "a", pass: true, failures: [] }]));
  writeFileSync(path.join(paths.evalResults, "broken.json"), "{not json");
  writeFileSync(paths.state, "{also not json");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => server.close());

/** A raw GET, so paths like "/../x" go out exactly as written. */
function get(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject).end();
  });
}

test("bad log lines, eval files and state are skipped instead of taking the dashboard down", async () => {
  const runs = await get("/api/runs.json");
  assert.equal(runs.status, 200);
  assert.deepEqual(JSON.parse(runs.body).map((r: { runId: string }) => r.runId), ["r"]);

  assert.deepEqual(JSON.parse((await get("/api/evals.json")).body).map((e: { file: string }) => e.file), ["2026-09-26T00-00-00-000Z.json"]);
  assert.deepEqual(JSON.parse((await get("/api/status.json")).body), { lastSeenTag: null, lastRunAt: "2026-09-26T00:00:00.000Z" });
  assert.equal((await get("/api/status.json")).status, 200); // and it's still up
});

test("routes ignore query strings and files outside public/ stay out of reach", async () => {
  assert.equal((await get("/api/runs.json?nocache=1")).status, 200);
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/render.js")).status, 200);
  for (const escape of ["/../../../package.json", "/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json"]) {
    const { status, body } = await get(escape);
    assert.notEqual(status, 200, escape);
    assert.ok(!body.includes('"name": "api-dependabot"'), escape);
  }
});

import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunLogEntry } from "../runLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, "public");

export interface DashboardPaths {
  runLog: string;
  state: string;
  evalResults: string;
}

export const DEFAULT_PATHS: DashboardPaths = {
  runLog: path.resolve("./run-log.jsonl"),
  state: path.resolve("./.changelog-state.json"),
  evalResults: path.resolve("./eval-results"),
};

/** Parses what it can: one bad line or file (a half-written append, a hand
 * edit) is skipped rather than failing the whole page. */
function parseOrSkip<T>(text: string, source: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    console.warn(`Skipping unreadable JSON in ${source}`);
    return undefined;
  }
}

function readRuns(paths: DashboardPaths): RunLogEntry[] {
  if (!existsSync(paths.runLog)) return [];
  const lines = readFileSync(paths.runLog, "utf8").split("\n").filter((l) => l.trim());
  const runs = lines
    .map((line, i) => parseOrSkip<RunLogEntry>(line, `${paths.runLog} line ${i + 1}`))
    .filter((run): run is RunLogEntry => run !== undefined);
  return runs.reverse(); // newest first
}

interface EvalCaseResult {
  id: string;
  pass: boolean;
  failures: string[];
}

interface EvalSummary {
  file: string;
  timestamp: string;
  passed: number;
  total: number;
  // Cases that failed only because the model call errored (a 429 or 503 from
  // Gemini): the patch was never judged, so they say nothing about its quality.
  modelErrors: number;
}

function readEvals(paths: DashboardPaths): EvalSummary[] {
  if (!existsSync(paths.evalResults)) return [];
  const files = readdirSync(paths.evalResults).filter((f) => f.endsWith(".json"));
  const summaries: EvalSummary[] = [];
  for (const file of files) {
    const results = parseOrSkip<EvalCaseResult[]>(
      readFileSync(path.join(paths.evalResults, file), "utf8"),
      file
    );
    if (!Array.isArray(results)) continue;
    summaries.push({
      file,
      // filenames are `new Date().toISOString().replace(/[:.]/g, "-")` (see src/eval/run.ts),
      // so they already sort chronologically as strings — no need to reconstruct real ISO.
      timestamp: file.replace(/\.json$/, ""),
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      modelErrors: results.filter(
        (r) => !r.pass && r.failures.length > 0 && r.failures.every((f) => f.startsWith("error:"))
      ).length,
    });
  }
  return summaries.sort((a, b) => b.file.localeCompare(a.file));
}

function readStatus(paths: DashboardPaths) {
  const state = existsSync(paths.state)
    ? parseOrSkip<{ lastSeenTag: string | null }>(readFileSync(paths.state, "utf8"), paths.state)
    : undefined;
  const runs = readRuns(paths);
  return {
    lastSeenTag: state?.lastSeenTag ?? null,
    lastRunAt: runs[0]?.startedAt ?? null,
  };
}

/** The API, by file name under /api/. File names rather than bare routes, so
 * build.ts can write the same responses out as a static copy of the page. A
 * Map, so a name like "constructor" can't reach Object.prototype. */
export const API_FILES = new Map<string, (paths: DashboardPaths) => unknown>([
  ["runs.json", readRuns],
  ["evals.json", readEvals],
  ["status.json", readStatus],
]);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

export function createDashboardServer(paths: DashboardPaths = DEFAULT_PATHS): Server {
  return createServer(async (req, res) => {
    // An error here would otherwise reject the handler's promise, and Node
    // exits on an unhandled rejection: one bad request took the dashboard down.
    try {
      // Routing on the parsed path: query strings don't break a route, and
      // "../" segments are resolved against "/", so they can't climb above it.
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      const read = pathname.startsWith("/api/") ? API_FILES.get(pathname.slice("/api/".length)) : undefined;
      if (read) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(read(paths)));
        return;
      }

      const filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
      // With the separator, so a sibling like "public-old" doesn't pass as inside "public".
      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      try {
        const body = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.DASHBOARD_PORT ?? 4200);
  // Only this machine by default: the run history (PR links, file paths,
  // errors) isn't for everyone on the network. DASHBOARD_HOST=0.0.0.0 opens it
  // up deliberately; there's no auth, so only do that on a network you trust.
  const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
  createDashboardServer().listen(port, host, () => {
    console.log(`Dashboard running at http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);
  });
}

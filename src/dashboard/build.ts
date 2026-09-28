import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_FILES, DEFAULT_PATHS, PUBLIC_DIR, type DashboardPaths } from "./server.js";

/** Writes a static copy of the dashboard to `outDir`: the page as it is, plus
 * each API response saved as a file at the URL the page fetches it from, so it
 * can be hosted without the server. The scheduled workflow
 * (.github/workflows/agent.yml) publishes this to GitHub Pages. */
export function buildStaticDashboard(outDir: string, paths: DashboardPaths = DEFAULT_PATHS): void {
  cpSync(PUBLIC_DIR, outDir, { recursive: true });
  mkdirSync(path.join(outDir, "api"), { recursive: true });
  for (const [file, read] of API_FILES) {
    writeFileSync(path.join(outDir, "api", file), JSON.stringify(read(paths)));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const outDir = path.resolve(process.argv[2] ?? "_site");
  buildStaticDashboard(outDir);
  console.log(`Static dashboard written to ${outDir}`);
}

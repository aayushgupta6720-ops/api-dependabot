import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Failed runs per fix branch, in a JSON file the scheduled workflow keeps on
 * the dashboard-data branch between runs (pipeline.ts MAX_FILE_ATTEMPTS). */
export function fileAttempts(path: string) {
  const counts: Record<string, number> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    failedAttempts: (branch: string) => counts[branch] ?? 0,
    recordFailure: (branch: string) => {
      counts[branch] = (counts[branch] ?? 0) + 1;
      writeFileSync(path, JSON.stringify(counts, null, 2));
      return counts[branch];
    },
  };
}

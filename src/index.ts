import { config } from "./config.js";
import { checkForBreakingChanges, markReleasesSeen } from "./changelogWatcher.js";
import { findFieldUsages, findUsages } from "./scanner.js";
import { generatePatch } from "./llmClient.js";
import { findFixPr, openFixPr } from "./githubClient.js";
import { processReleases } from "./pipeline.js";
import { appendRunLog, type RunLogEntry } from "./runLog.js";

// Path to a LOCAL checkout of the repo you're scanning (clone it first).
const LOCAL_REPO_PATH = "./target-repo";

async function main() {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const runLog: RunLogEntry = {
    runId: startedAt,
    startedAt,
    durationMs: 0,
    targetPackageRepo: config.targetPackageRepo,
    changesFound: 0,
    changes: [],
  };

  try {
    console.log(`Checking ${config.targetPackageRepo} for new breaking changes...`);
    const releases = await checkForBreakingChanges();
    runLog.changesFound = releases.changes.length;
    if (releases.notesProblems.length > 0) runLog.notesProblems = releases.notesProblems;
    if (releases.notPatched.length > 0) runLog.notPatched = releases.notPatched;

    if (releases.changes.length === 0) {
      console.log("No new breaking changes found.");
    }

    const result = await processReleases(
      releases,
      { findUsages, findFieldUsages, generatePatch, findFixPr, openFixPr, markReleasesSeen },
      { repoPath: LOCAL_REPO_PATH, targetPackage: config.targetPackage }
    );
    runLog.changes = result.changes;
  } catch (err) {
    runLog.error = (err as Error).message;
    throw err;
  } finally {
    runLog.durationMs = Date.now() - startTime;
    appendRunLog(runLog);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

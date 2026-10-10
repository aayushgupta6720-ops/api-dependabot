import { Octokit } from "@octokit/rest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { extractBreakingChanges, type DetectedChange } from "./llmClient.js";
import { resolveReleaseNotes } from "./releaseNotes.js";

const octokit = new Octokit({ auth: config.githubToken });
const [owner, repo] = config.targetPackageRepo.split("/");

const STATE_PATH = "./.changelog-state.json";

interface WatcherState {
  lastSeenTag: string | null;
}

function loadState(): WatcherState {
  if (!existsSync(STATE_PATH)) return { lastSeenTag: null };
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function saveState(state: WatcherState) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export interface NewReleases {
  changes: DetectedChange[];
  // The newest release looked at, to pass to markReleasesSeen once its
  // changes are handled; null when there was nothing new.
  latestTag: string | null;
  // Why some releases' breaking changes may have been missed: notes that
  // couldn't be read, or that the model misread. Those releases shouldn't be
  // marked seen.
  notesProblems: string[];
  // Breaking changes with no method call or field read to patch, with why.
  notPatched: { version: string; entry: string }[];
}

/** One file of a GitHub repo at a ref, as text. */
export async function fetchRepoFile(repoFullName: string, ref: string, filePath: string): Promise<string> {
  const [fileOwner, fileRepo] = repoFullName.split("/");
  const { data } = await octokit.repos.getContent({
    owner: fileOwner,
    repo: fileRepo,
    path: filePath,
    ref,
    mediaType: { format: "raw" }, // the file itself; the JSON form stops at 1 MB
  });
  return data as unknown as string;
}

/**
 * Fetches GitHub releases for config.targetPackageRepo published since the
 * last run, and asks the LLM to pull structured breaking changes out of
 * their notes in a single batched call. Doesn't advance the "last seen"
 * marker itself: the caller does that with markReleasesSeen once every change
 * has been handled, so a failed patch or PR is retried on the next run.
 */
export async function checkForBreakingChanges(): Promise<NewReleases> {
  const state = loadState();

  const { data: releases } = await octokit.repos.listReleases({
    owner,
    repo,
    per_page: 100,
  });

  // GitHub returns newest first; walk oldest-to-newest so the state marker
  // advances in order and nothing in between gets skipped.
  const ordered = [...releases].reverse();

  const lastSeenIndex = state.lastSeenTag
    ? ordered.findIndex((r) => r.tag_name === state.lastSeenTag)
    : -1;

  // On the first run, just the latest release. A marker that's no longer in
  // the list used to be treated the same way, skipping every release between.
  const markerLost = state.lastSeenTag !== null && lastSeenIndex === -1;
  const unseen = lastSeenIndex === -1 ? ordered.slice(-1) : ordered.slice(lastSeenIndex + 1);

  const releasesWithNotes = unseen
    .filter((r) => r.body)
    .map((r) => ({ version: r.tag_name, notes: r.body! }));

  // A release whose notes are just "see the changelog" gets its section of it.
  const { releases: readable, problems } = await resolveReleaseNotes(
    releasesWithNotes,
    config.targetPackageRepo,
    fetchRepoFile
  );
  if (markerLost) {
    problems.push(`the last seen release, ${state.lastSeenTag}, isn't among the latest ${ordered.length}, so releases since it weren't read`);
  }

  const found =
    readable.length > 0
      ? await extractBreakingChanges(config.targetPackage, readable)
      : { changes: [], notPatched: [], problems: [] };
  problems.push(...found.problems);
  for (const problem of problems) console.warn(problem);
  for (const item of found.notPatched) console.log(`Breaking, nothing to patch: ${item.entry}`);

  return {
    changes: found.changes,
    latestTag: unseen.length > 0 ? unseen[unseen.length - 1].tag_name : null,
    notesProblems: problems,
    notPatched: found.notPatched,
  };
}

/** Records that releases up to and including `tag` have been fully handled. */
export function markReleasesSeen(tag: string): void {
  saveState({ lastSeenTag: tag });
}

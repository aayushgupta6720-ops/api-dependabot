import { appendFileSync } from "node:fs";

const LOG_PATH = "./run-log.jsonl";

export interface PatchLogEntry {
  filePath: string;
  // pr_exists: a fix PR for this change and file came from an earlier run (a retry skipped it)
  status: "pr_opened" | "pr_exists" | "no_change_needed" | "error";
  prUrl?: string;
  explanation?: string;
  error?: string;
}

export interface ChangeLogEntry {
  version: string;
  entry: string;
  methodName?: string; // what was scanned for: a method's calls,
  fieldPath?: string; // or a field's reads
  usagesFound: number;
  patches: PatchLogEntry[];
  error?: string;
}

export interface RunLogEntry {
  runId: string;
  startedAt: string;
  durationMs: number;
  targetPackageRepo: string;
  changesFound: number;
  changes: ChangeLogEntry[];
  // Why releases' notes may have been missed or misread; they stay unseen
  notesProblems?: string[];
  // Breaking changes with no method call or field read to patch, with why
  notPatched?: { version: string; entry: string }[];
  error?: string;
}

/** Appends one run as a single line of JSON to run-log.jsonl. */
export function appendRunLog(entry: RunLogEntry): void {
  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
}

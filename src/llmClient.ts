import { changeTarget, REVIEW_MARKER, type DetectedChange } from "./changes.js";
import { config } from "./config.js";
import { splitNotes } from "./releaseNotes.js";

export type { DetectedChange } from "./changes.js";

const MODEL = "gemini-3.5-flash-lite"; // check https://ai.google.dev for current free-tier model names

export interface PatchResult {
  explanation: string;
  patchedCode: string;
}

export interface ReleaseNotes {
  version: string;
  notes: string;
}

// The free tier answers 503 when the model is overloaded ("experiencing high
// demand", usually over within seconds) and 429 when a per-minute limit is hit.
// Those are waited out rather than failing a patch or an eval case; any other
// error (a bad key, a bad request) fails at once. Exported so tests can zero it.
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const RETRY_STATUSES = new Set([429, 500, 503]);

async function callGemini(prompt: string, generationConfig?: Record<string, unknown>): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        // In a header rather than ?key=, where proxies and request logs would record it.
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiApiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          ...(generationConfig && { generationConfig }),
        }),
      }
    );

    const delay = RETRY_DELAYS_MS[attempt];
    if (!res.ok && RETRY_STATUSES.has(res.status) && delay !== undefined) {
      await res.body?.cancel();
      console.warn(`Gemini API error ${res.status}, retrying in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return text.replace(/```json|```/g, "").trim();
  }
}

// Notes are sent to the model this many characters at a time. stripe-node's
// v23.0.0 section is 45,500 characters with 26 items marked breaking; cut to
// 40,000 and sent in one prompt with the three releases after it, it came
// back with none at all, and the release was marked seen.
export const MAX_PROMPT_NOTES_CHARS = 12_000;

// How release notes mark a breaking change: stripe-node puts ⚠️ on the item,
// and many changelogs say "BREAKING CHANGE" or have a "Breaking changes" heading.
const BREAKING_MARKER_RE = /⚠️|BREAKING[ _-]CHANGE|^#+\s*breaking/im;

export interface Extraction {
  changes: DetectedChange[];
  // Items the notes mark as breaking that aren't a method call or field read
  // to patch (a removed export, a dropped Node version, a field that became
  // required), each with the model's reason. Logged so they're seen.
  notPatched: { version: string; entry: string }[];
  // Why some of the notes may not have been read right. The caller mustn't
  // mark these releases seen, or their breaking changes would be lost.
  problems: string[];
}

interface Piece {
  version: string;
  heading: string;
  text: string;
}

/**
 * Reads new releases' raw notes and pulls out any breaking API changes
 * relevant to callers of `packageName`, in the shape the rest of the pipeline
 * expects. Small releases share a request, since the free-tier Gemini quota is
 * a daily budget per Google project, shared with every run and eval; long
 * notes are split across requests rather than cut.
 *
 * It fails closed: a reply that isn't the expected shape throws, and a change
 * the model described unusably, or a part of the notes that marks breaking
 * changes but got neither a change nor a reason back, is a problem.
 */
export async function extractBreakingChanges(
  packageName: string,
  releases: ReleaseNotes[]
): Promise<Extraction> {
  const pieces: Piece[] = releases.flatMap((r) => {
    const parts = splitNotes(r.notes, MAX_PROMPT_NOTES_CHARS);
    return parts.map((text, i) => ({
      version: r.version,
      heading: parts.length > 1 ? `### ${r.version} (part ${i + 1} of ${parts.length})` : `### ${r.version}`,
      text,
    }));
  });
  const batches: Piece[][] = [];
  let size = 0;
  for (const piece of pieces) {
    const last = batches.at(-1);
    if (last && size + piece.text.length <= MAX_PROMPT_NOTES_CHARS) {
      last.push(piece);
      size += piece.text.length;
    } else {
      batches.push([piece]);
      size = piece.text.length;
    }
  }

  const result: Extraction = { changes: [], notPatched: [], problems: [] };
  for (const batch of batches) {
    const reply = await extractFromBatch(packageName, batch);
    result.changes.push(...reply.changes);
    result.notPatched.push(...reply.notPatched);
    result.problems.push(...reply.problems);
  }
  result.changes = mergeSameTarget(result.changes);
  return result;
}

async function extractFromBatch(packageName: string, batch: Piece[]): Promise<Extraction> {
  const releasesText = batch.map((p) => `${p.heading}\n${p.text}`).join("\n\n");

  const prompt = `You are scanning release notes for breaking API changes in the "${packageName}" SDK.

RELEASES (oldest to newest; a long release comes in parts, and this may be one part of it):
${releasesText}

Identify only changes that would break existing caller code:
- methods that were removed or renamed, or whose signature changed
- request parameters that were removed or renamed, or that lost allowed values. These are "method" changes, named after the method the parameters go to: \`V2.MoneyManagement.FinancialAddressCreateParams\` is v2.moneyManagement.financialAddresses.create, \`...ListParams\` is .list, \`...RetrieveParams\` is .retrieve
- fields on objects the SDK returns that were removed or renamed, or that became optional or nullable (callers may now read undefined or null)
Ignore additions (including new enum values), deprecations-without-removal, docs, internal changes, and type changes that don't break reading a field (a field becoming required, a returned enum narrowing).
Give each method and each field its own entry. When the same field changed under many parents, use one entry with * for the part that varies: \`igic\` removed on \`Tax.Registration.country_options.at\`, \`.be\`, \`.de\`... is country_options.*.igic.

Every item the notes mark as breaking (with ⚠️, "BREAKING CHANGE" or under a "Breaking changes" heading) must end up in exactly one of two lists: "changes", if it breaks a method call or a field read as above, or "notPatched" otherwise (a removed export or helper that isn't a client method, a dropped Node version, a change in behaviour, or one of the type changes to ignore), saying in a few words why there's no call or read to patch.

Return ONLY a JSON object, no markdown fences, no extra text:
{"changes": [...], "notPatched": [...]}
Each element of "changes" is one of these two shapes, with "version" the release tag as written in its heading, without any "(part ...)":
{"version": "the release tag, e.g. v10.0.0", "entry": "one-line summary, e.g. 'v10.0.0: Renamed \`listUpcomingLineItems\` method on the \`Invoice\` resource to \`listUpcomingLines\`.'", "kind": "method", "methodName": "the dotted call path callers would use, e.g. invoices.listUpcomingLineItems"}
{"version": "the release tag", "entry": "one-line summary, e.g. 'v22.7.0-alpha.4: \`Mandate.payment_method_details.blik.expires_after\` removed.'", "kind": "field", "fieldPath": "the path callers read off the returned object, without the resource name, e.g. payment_method_details.blik.expires_after; write array elements as [], e.g. classifications[].credit for \`FinancialConnections.Transaction.classifications[]\` credit"}
Each element of "notPatched" is {"version": "the release tag", "entry": "one-line summary, then why there's nothing to patch"}.
If these notes have no breaking changes, return {"changes": [], "notPatched": []}.`;

  // temperature 0: a retry should name a change the same way, or it gets a new
  // fix branch and a duplicate PR.
  const cleaned = await callGemini(prompt, { temperature: 0, responseMimeType: "application/json" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Could not parse model output as JSON:\n${cleaned}`);
  }
  const reply = (parsed ?? {}) as { changes?: unknown; notPatched?: unknown };
  if (!Array.isArray(reply.changes) || !Array.isArray(reply.notPatched)) {
    throw new Error(`The model's reply isn't {"changes": [...], "notPatched": [...]}:\n${cleaned.slice(0, 500)}`);
  }

  const problems: string[] = [];
  const notPatched = reply.notPatched.flatMap((item) => {
    const c = (item ?? {}) as Record<string, unknown>;
    const version = releaseTag(c.version);
    const entry = typeof c.entry === "string" ? c.entry.trim() : "";
    return version && entry ? [{ version, entry }] : [];
  });
  const changes = reply.changes.flatMap((item) => {
    const change = toDetectedChange(item);
    if (!change) {
      problems.push(`the model described a breaking change unusably: ${JSON.stringify(item).slice(0, 300)}`);
      return [];
    }
    // A path of only "*" and "[]" would match every property read in every
    // file that imports the package.
    if (change.fieldPath && !change.fieldPath.split(".").some((s) => s !== "*" && s.replace(/\[\]/g, ""))) {
      notPatched.push({ version: change.version, entry: `${change.entry} (names no field to scan for)` });
      return [];
    }
    return [change];
  });

  // A release whose notes here mark breaking changes must get something back
  // for them: an empty answer for it is a misread, not a release with nothing in it.
  const answered = new Set([...changes, ...notPatched].map((c) => c.version));
  for (const piece of batch) {
    if (BREAKING_MARKER_RE.test(piece.text) && !answered.has(piece.version)) {
      problems.push(`${piece.heading.replace(/^### /, "")}: the notes mark breaking changes, but the model reported none`);
    }
  }
  return { changes, notPatched, problems };
}

/** A release tag as the model gave it, minus a "(part 2 of 8)" it copied from the heading. */
function releaseTag(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.replace(/\s*\(part \d+ of \d+\)\s*$/, "").trim() : undefined;
}

/** Entries for the same method or field in the same release (two parameters
 * of one method removed, say) become one, so the file gets a single patch
 * that handles both. Kept apart, they'd share a fix branch, and the second
 * would be skipped as already having the first one's PR. */
function mergeSameTarget(changes: DetectedChange[]): DetectedChange[] {
  const merged = new Map<string, DetectedChange>();
  for (const change of changes) {
    const key = JSON.stringify([change.version, change.fieldPath ? "field" : "method", changeTarget(change)]);
    const earlier = merged.get(key);
    if (earlier) earlier.entry = `${earlier.entry}\n${change.entry}`;
    else merged.set(key, { ...change });
  }
  return [...merged.values()];
}

/** One of the model's entries as a DetectedChange, or null if it doesn't say
 * what to scan for (the caller reports that, so a dropped change isn't silent). */
function toDetectedChange(item: unknown): DetectedChange | null {
  const c = (item ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const version = releaseTag(c.version);
  const entry = text(c.entry);
  const fieldPath = c.kind === "field" ? text(c.fieldPath) : undefined;
  const methodName = fieldPath ? undefined : text(c.methodName);
  if (!version || !entry || (!fieldPath && !methodName)) return null;
  return fieldPath ? { version, entry, fieldPath } : { version, entry, methodName };
}

/**
 * Sends the breaking-change diff + the affected code snippet to Gemini,
 * and asks it to return a patch as strict JSON. When the SDK removed
 * something with no replacement, the patch flags the code for a person (a
 * REVIEW_MARKER comment) instead of faking it: asked only for a minimal fix,
 * the model hard-coded `return null;` over a removed field's read, which hid
 * that the code had lost the data. A removed method is different: calling it
 * throws anyway, so the call becomes an explicit throw rather than staying.
 */
export async function generatePatch(
  changelogEntry: string,
  affectedFilePath: string,
  affectedCode: string
): Promise<PatchResult> {
  const prompt = `You are updating code for a breaking change in an SDK it uses.

CHANGELOG ENTRY (what changed in the new SDK version):
${changelogEntry}

FILE: ${affectedFilePath}
CURRENT CODE:
${affectedCode}

How to update it:
- If the change names a replacement (a renamed method, field or parameter, or another way to do the same thing), switch the code to it and keep its behavior.
- If a field just became optional or nullable, guard each read of it (optional chaining or a null check) and keep the behavior the same when it's present.
- If a method was removed with no replacement, don't invent one. Calling it now throws an obscure "is not a function" error, so replace the call with a throw of an Error whose message says what was removed and in which version, and put a comment directly above it that starts with "${REVIEW_MARKER}:".
- If a field was removed with no replacement, don't swap its read for a hard-coded value (such as setting it to null or returning null): the read still runs (it gives undefined), and faking the value hides that the data is gone. Leave the code as it is and add a comment directly above the affected line that starts with "${REVIEW_MARKER}:", names what was removed and in which version, and says what this code can no longer do.
- Either way, a person will decide what to do about it.
- Change only what this breaking change requires, and leave the rest of the file exactly as it is.

Return ONLY a JSON object with this exact shape, no markdown fences, no extra text:
{"explanation": "one sentence on what you changed and why; if you only added a TODO for review, say so", "patchedCode": "the full updated file contents"}`;

  const cleaned = await callGemini(prompt);

  try {
    return JSON.parse(cleaned) as PatchResult;
  } catch {
    throw new Error(`Could not parse model output as JSON:\n${cleaned}`);
  }
}

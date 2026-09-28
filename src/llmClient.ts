import { changeTarget, REVIEW_MARKER, type DetectedChange } from "./changes.js";
import { config } from "./config.js";

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

async function callGemini(prompt: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        // In a header rather than ?key=, where proxies and request logs would record it.
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiApiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
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

/**
 * Reads a batch of releases' raw notes in one shot and pulls out any
 * breaking API changes relevant to callers of `packageName`, in the shape
 * the rest of the pipeline expects (the same shape CHANGELOG_ENTRY/
 * METHOD_NAME used to be filled in by hand). Batched into a single call so
 * checking N new releases costs one request, not N — the free-tier Gemini
 * quota is a daily budget per Google project, shared with every run and eval.
 */
export async function extractBreakingChanges(
  packageName: string,
  releases: ReleaseNotes[]
): Promise<DetectedChange[]> {
  const releasesText = releases
    .map((r) => `### ${r.version}\n${r.notes}`)
    .join("\n\n");

  const prompt = `You are scanning release notes for breaking API changes in the "${packageName}" SDK.

RELEASES (oldest to newest):
${releasesText}

Identify only changes that would break existing caller code:
- methods that were removed or renamed, or whose signature changed
- request parameters that were removed or renamed, or that lost allowed values. These are "method" changes, named after the method the parameters go to: \`V2.MoneyManagement.FinancialAddressCreateParams\` is v2.moneyManagement.financialAddresses.create, \`...ListParams\` is .list, \`...RetrieveParams\` is .retrieve
- fields on objects the SDK returns that were removed or renamed, or that became optional or nullable (callers may now read undefined or null)
Ignore additions (including new enum values), deprecations-without-removal, docs, internal changes, and type changes that don't break reading a field (a field becoming required, a returned enum narrowing).
Give each method and each field its own entry. When the same field changed under many parents, use one entry with * for the part that varies: \`igic\` removed on \`Tax.Registration.country_options.at\`, \`.be\`, \`.de\`... is country_options.*.igic.

Return ONLY a JSON array, no markdown fences, no extra text. Each element is one of these two shapes:
{"version": "the release tag, e.g. v18.0.0", "entry": "one-line summary, e.g. 'v18.0.0: \`charges.create\` removed. Use \`paymentIntents.create\` instead.'", "kind": "method", "methodName": "the dotted call path callers would use, e.g. charges.create"}
{"version": "the release tag", "entry": "one-line summary, e.g. 'v22.7.0: \`Mandate.payment_method_details.blik.expires_after\` removed.'", "kind": "field", "fieldPath": "the path callers read off the returned object, without the resource name, e.g. payment_method_details.blik.expires_after; write array elements as [], e.g. classifications[].credit for \`FinancialConnections.Transaction.classifications[]\` credit"}

If there are no breaking changes in any of these releases, return an empty array: []`;

  const cleaned = await callGemini(prompt);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Could not parse model output as JSON:\n${cleaned}`);
  }
  return Array.isArray(parsed) ? mergeSameTarget(parsed.flatMap(toDetectedChange)) : [];
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

/** One of the model's entries as a DetectedChange, or nothing if it doesn't
 * say what to scan for (logged, so a dropped change isn't silent). */
function toDetectedChange(item: unknown): DetectedChange[] {
  const c = (item ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const version = text(c.version);
  const entry = text(c.entry);
  const fieldPath = c.kind === "field" ? text(c.fieldPath) : undefined;
  const methodName = fieldPath ? undefined : text(c.methodName);
  if (!version || !entry || (!fieldPath && !methodName)) {
    console.warn(`Skipping a breaking change the model didn't describe usably: ${JSON.stringify(item)}`);
    return [];
  }
  return [fieldPath ? { version, entry, fieldPath } : { version, entry, methodName }];
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

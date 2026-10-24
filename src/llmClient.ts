import { changeTarget, REVIEW_MARKER, type DetectedChange } from "./changes.js";
import { config } from "./config.js";
import { numberNotes, relatedLines, splitNotes, type NotesItem } from "./releaseNotes.js";

export type { DetectedChange } from "./changes.js";

export const MODEL = "gemini-3.5-flash-lite"; // check https://ai.google.dev for current free-tier model names

// What the extraction prompt and its parsing are, for the extraction cache
// (extractionCache.ts): bump it whenever either changes, so releases are read
// again the new way. A test pins the prompt's hash to catch a missed bump.
export const EXTRACTION_VERSION = "extract_v1";

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
  // From the release's whole notes, since a long release is read in pieces.
  const notesOf = new Map(releases.map((r) => [r.version, r.notes]));
  for (const change of result.changes) {
    const notes = notesOf.get(change.version);
    const related = notes && change.source ? relatedLines(notes, change.source) : [];
    if (related.length) change.related = related;
  }
  return result;
}

async function extractFromBatch(packageName: string, batch: Piece[]): Promise<Extraction> {
  const { numbered, items } = numberNotes(batch.map((p) => p.text));
  // Line number -> the release and the item of its notes that the line is in.
  const lineAt = new Map<number, { version: string; item: NotesItem }>();
  batch.forEach((p, i) => {
    for (const item of items[i]) {
      for (let n = item.first; n <= item.last; n++) lineAt.set(n, { version: p.version, item });
    }
  });

  const result: Extraction = { changes: [], notPatched: [], problems: [] };
  const cited = new Set<NotesItem>(); // the items some change or notPatched entry came from
  await askAbout(packageName, batch, batch.map((p, i) => `${p.heading}\n${numbered[i]}`).join("\n\n"), null, lineAt, cited, result);

  // Every item the notes mark as breaking must get something back: a change or
  // a reason there's nothing to patch. A cited line anywhere under an item
  // answers it, since the model may cite the nested entry that names the
  // method rather than the entry that carries the ⚠️.
  const unanswered = () =>
    batch.map((_, i) => {
      const citedLines = [...cited].filter((c) => items[i].includes(c)).map((c) => c.first);
      return items[i].filter((item) => item.marked && !citedLines.some((n) => n >= item.first && n <= item.end));
    });
  // The model reads a long piece and passes over an item now and then (on
  // v23.0.0, one type change out of 26 marked items). Ask once more about just
  // those items before calling them missed.
  let gaps = unanswered();
  if (gaps.some((g) => g.length > 0)) {
    const lines = (item: NotesItem) => item.text.split("\n").map((l, k) => `[${item.first + k}] ${l}`).join("\n");
    const text = batch
      .map((p, i) => (gaps[i].length ? `${p.heading}\n${gaps[i].map(lines).join("\n")}` : ""))
      .filter(Boolean)
      .join("\n\n");
    await askAbout(packageName, batch, text, new Set(gaps.flat()), lineAt, cited, result);
    gaps = unanswered();
  }

  // Notes that mark breaking changes some other way (a "Breaking changes"
  // heading over prose, say) must at least get an answer for their release.
  const answered = new Set([...result.changes, ...result.notPatched].map((c) => c.version));
  batch.forEach((piece, i) => {
    const label = piece.heading.replace(/^### /, "");
    for (const item of gaps[i]) {
      result.problems.push(`${label}: "${item.text.split("\n")[0].trim().slice(0, 120)}" is marked breaking, but the model reported nothing for it`);
    }
    if (!items[i].some((item) => item.marked) && BREAKING_MARKER_RE.test(piece.text) && !answered.has(piece.version)) {
      result.problems.push(`${label}: the notes mark breaking changes, but the model reported none`);
    }
  });
  return result;
}

/** One request: `releasesText` in (numbered notes, or for a follow-up just the
 * marked items in `followUp` that went unanswered), its changes and reasons
 * added to `result`, and the items they cite to `cited`. A follow-up's answers
 * count only for the items it asked about, so nothing is reported twice. */
async function askAbout(
  packageName: string,
  batch: Piece[],
  releasesText: string,
  followUp: Set<NotesItem> | null,
  lineAt: Map<number, { version: string; item: NotesItem }>,
  cited: Set<NotesItem>,
  result: Extraction
): Promise<void> {
  const what = followUp
    ? "ITEMS FROM THE RELEASE NOTES that are marked breaking and haven't been classified yet; each one must go in \"changes\" or \"notPatched\". Each line starts with its number in brackets, which isn't part of the notes"
    : "RELEASES (oldest to newest; a long release comes in parts, and this may be one part of it). Each line of the notes starts with its number in brackets, which isn't part of the notes";
  const prompt = `You are scanning release notes for breaking API changes in the "${packageName}" SDK.

${what}:
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
Each element of "changes" is one of these two shapes, with "version" the release tag as written in its heading, without any "(part ...)", and "line" the number of the line in the notes that states the change:
{"version": "the release tag, e.g. v10.0.0", "line": 12, "entry": "one-line summary, e.g. 'v10.0.0: Renamed \`listUpcomingLineItems\` method on the \`Invoice\` resource to \`listUpcomingLines\`.'", "kind": "method", "methodName": "the dotted call path callers would use, e.g. invoices.listUpcomingLineItems"}
{"version": "the release tag", "line": 12, "entry": "one-line summary, e.g. 'v22.2.0-alpha.6: \`Subscription.status_details\` removed.'", "kind": "field", "fieldPath": "the path callers read off the returned object, without the resource name, e.g. status_details or payment_method_details.card.three_d_secure.cryptogram; write array elements as [], e.g. classifications[].credit for \`FinancialConnections.Transaction.classifications[]\` credit", "resource": "the dotted client path whose methods return that object, e.g. mandates for Mandate, issuing.cards for Issuing.Card, financialConnections.transactions for FinancialConnections.Transaction; empty if the notes don't name one object"}
Each element of "notPatched" is {"version": "the release tag", "line": the number of the line that states it, "entry": "one-line summary, then why there's nothing to patch"}.
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

  // The model may name a release as its changelog heading does ("23.1.0-beta.1") rather than
  // by its tag ("v23.1.0-beta.1"); either way it's the tag in this batch.
  const tags = new Map(batch.map((p) => [p.version.replace(/^v/i, "").toLowerCase(), p.version]));
  const asTag = (v: string | undefined) => (v ? (tags.get(v.replace(/^v/i, "").toLowerCase()) ?? v) : v);

  // The item of `version`'s notes that the model's line number points into, if it does.
  const sourceOf = (line: unknown, version: string) => {
    const at = typeof line === "number" ? lineAt.get(line) : undefined;
    if (!at || at.version !== version) return undefined;
    cited.add(at.item);
    return at.item;
  };
  const askedAbout = (item: Record<string, unknown>) => {
    const at = typeof item.line === "number" ? lineAt.get(item.line) : undefined;
    return !followUp || (at !== undefined && followUp.has(at.item));
  };
  for (const item of reply.notPatched) {
    const c = (item ?? {}) as Record<string, unknown>;
    if (!askedAbout(c)) continue;
    const version = asTag(releaseTag(c.version));
    const entry = typeof c.entry === "string" ? c.entry.trim() : "";
    if (version) sourceOf(c.line, version);
    if (version && entry) result.notPatched.push({ version, entry });
  }
  for (const item of reply.changes) {
    if (followUp && !askedAbout((item ?? {}) as Record<string, unknown>)) continue;
    const described = toDetectedChange(item);
    const change = described && { ...described, version: asTag(described.version)! };
    if (!change) {
      // A field change with no field in it ("Removed resources `OrderItem` and `OrderReturn`", as v9.0.0
      // put it) has nothing to scan for, like a "*"-only path: say so rather than fail the release.
      const c = (item ?? {}) as Record<string, unknown>;
      const version = asTag(releaseTag(c.version));
      const entry = typeof c.entry === "string" ? c.entry.trim() : "";
      if (c.kind === "field" && version && entry && sourceOf(c.line, version)) {
        result.notPatched.push({ version, entry: `${entry} (names no field to scan for)` });
        continue;
      }
      result.problems.push(`the model described a breaking change unusably: ${JSON.stringify(item).slice(0, 300)}`);
      continue;
    }
    // Without its line, a change has nothing stable to key its fix branch on.
    const source = sourceOf((item as Record<string, unknown>).line, change.version);
    if (!source) {
      result.problems.push(`the model didn't give the line of ${change.version}'s notes that states: ${change.entry.slice(0, 200)}`);
      continue;
    }
    change.source = source.text;
    // A path of only "*" and "[]" would match every property read in every
    // file that imports the package.
    if (change.fieldPath && !change.fieldPath.split(".").some((s) => s !== "*" && s.replace(/\[\]/g, ""))) {
      result.notPatched.push({ version: change.version, entry: `${change.entry} (names no field to scan for)` });
      continue;
    }
    result.changes.push(change);
  }
}

/** A release tag as the model gave it, minus a "(part 2 of 8)" it copied from the heading. */
function releaseTag(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.replace(/\s*\(part \d+ of \d+\)\s*$/, "").trim() : undefined;
}

/** Entries for the same method or field in the same release (two parameters
 * of one method removed, say) become one, so the file gets a single patch
 * that handles both, rather than two PRs that each fix half and conflict. */
function mergeSameTarget(changes: DetectedChange[]): DetectedChange[] {
  const merged = new Map<string, { change: DetectedChange; sources: Set<string> }>();
  for (const change of changes) {
    const key = JSON.stringify([change.version, change.fieldPath ? "field" : "method", changeTarget(change), change.resource ?? ""]);
    const earlier = merged.get(key);
    if (earlier) earlier.change.entry = `${earlier.change.entry}\n${change.entry}`;
    else merged.set(key, { change: { ...change }, sources: new Set() });
    if (change.source) merged.get(key)!.sources.add(change.source);
  }
  // A change stated in two items is keyed on both, in a fixed order.
  return [...merged.values()].map(({ change, sources }) =>
    sources.size ? { ...change, source: [...sources].sort().join("\n\n") } : change
  );
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
  const resource = fieldPath ? text(c.resource) : undefined;
  if (!version || !entry || (!fieldPath && !methodName)) return null;
  if (!fieldPath) return { version, entry, methodName };
  return resource ? { version, entry, fieldPath, resource } : { version, entry, fieldPath };
}

/**
 * Sends the breaking-change diff + the affected code snippet to Gemini,
 * and asks it to return a patch as strict JSON. When the SDK removed
 * something with no replacement, the patch flags the code for a person (a
 * REVIEW_MARKER comment) instead of faking it: asked only for a minimal fix,
 * the model hard-coded `return null;` over a removed field's read, which hid
 * that the code had lost the data. A removed method is different: calling it
 * throws anyway, so the call becomes an explicit throw rather than staying.
 *
 * `related` are other lines of the release's notes that name the same things
 * (see relatedLines). Given only its entry, the patch for v22.7.0-alpha.4's
 * `expires_after` removal flagged the read for review, though the line above
 * it adds `expires_at` for the same date; and the v22.0.0 API-key patch put
 * `{ apiKey }` where the params go, which the next entry says no longer works.
 *
 * `typeErrors` are the errors a first patch added against the new SDK's types,
 * for a second try (see pipeline.ts): even with that next entry, one patch in
 * five still put the key second, reading "pass `undefined` as the first
 * argument" as the call's first argument.
 */
export async function generatePatch(
  changelogEntry: string,
  affectedFilePath: string,
  affectedCode: string,
  related: string[] = [],
  typeErrors: string[] = []
): Promise<PatchResult> {
  const context = related.length
    ? `\nRELATED LINES FROM THE SAME RELEASE NOTES (they name the same things; read them for a replacement the entry doesn't name, or for how calls must now be made):\n${related.map((l) => `- ${l}`).join("\n")}\n`
    : "";
  const retry = typeErrors.length
    ? `\nA FIRST PATCH OF THIS FILE didn't type-check against the new SDK version. It added these errors, which this patch must not have:\n${typeErrors.map((e) => `- ${e}`).join("\n")}\n`
    : "";
  const prompt = `You are updating code for a breaking change in an SDK it uses.

CHANGELOG ENTRY (what changed in the new SDK version):
${changelogEntry}
${context}
${retry}
FILE: ${affectedFilePath}
CURRENT CODE:
${affectedCode}

How to update it:
- If the change names a replacement (a renamed method, field or parameter, or another way to do the same thing), switch the code to it and keep its behavior. A related line that adds something on the same object to do the same job (a field added where a similarly named one was removed) names one too.
- Follow what the related lines say about how calls must now be made (which argument goes where).
- If a field just became optional or nullable, guard each read of it (optional chaining or a null check) and keep the behavior the same when it's present.
- If a method was removed with no replacement (none in the entry or the related lines), don't invent one. Calling it now throws an obscure "is not a function" error, so replace the call with a throw of an Error whose message says what was removed and in which version, and put a comment directly above it that starts with "${REVIEW_MARKER}:".
- If a field was removed with no replacement (none in the entry or the related lines), don't swap its read for a hard-coded value (such as setting it to null or returning null): the read still runs (it gives undefined), and faking the value hides that the data is gone. Leave the code as it is and add a comment directly above the affected line that starts with "${REVIEW_MARKER}:", names what was removed and in which version, and says what this code can no longer do.
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

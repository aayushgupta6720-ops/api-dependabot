import assert from "node:assert/strict";
import { test } from "node:test";

// config.ts requires these at import; set before loading llmClient. dotenv
// doesn't override variables that are already set, so the real .env is unused.
process.env.GEMINI_API_KEY = "test-key-123";
process.env.GITHUB_TOKEN ??= "unused";
process.env.TARGET_REPO ??= "me/repo";

test("the Gemini API key goes in a header, not the URL", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: init.headers as Record<string, string> });
    const text = JSON.stringify({ explanation: "x", patchedCode: "y" });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  }) as typeof fetch;

  const { generatePatch } = await import("./llmClient.js");
  await generatePatch("entry", "a.js", "code");

  assert.equal(seen.length, 1);
  assert.ok(!seen[0].url.includes("key="), seen[0].url);
  assert.ok(!seen[0].url.includes("test-key-123"));
  assert.equal(seen[0].headers["x-goog-api-key"], "test-key-123");
});

/** Answers every Gemini call with `reply` (a value, or one per call from a
 * function of the prompt), and records each request body. */
function modelSays(reply: unknown | ((prompt: string) => unknown)) {
  const bodies: { contents: { parts: { text: string }[] }[]; generationConfig?: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const value = typeof reply === "function" ? (reply as (p: string) => unknown)(body.contents[0].parts[0].text) : reply;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  }) as typeof fetch;
  return bodies;
}

test("the model's changes become method or field changes; unusable ones are reported, not dropped quietly", async () => {
  modelSays({
    changes: [
      { version: "v1", entry: "v1: `charges.create` removed.", kind: "method", methodName: "charges.create" },
      { version: "v1 (part 2 of 3)", entry: "v1: `Mandate.x.y` removed.", kind: "field", fieldPath: "x.y", methodName: "mandates.retrieve" },
      { version: "v1", entry: "no target" },
      { version: "v1", entry: "field without a path", kind: "field" },
      "not an object",
    ],
    notPatched: [{ version: "v1", entry: "v1: Node 18 dropped; no call to patch." }, { entry: "no version" }],
  });

  const { extractBreakingChanges } = await import("./llmClient.js");
  const result = await extractBreakingChanges("stripe", [{ version: "v1", notes: "* ⚠️ several things" }]);

  assert.deepEqual(result.changes, [
    { version: "v1", entry: "v1: `charges.create` removed.", methodName: "charges.create" },
    { version: "v1", entry: "v1: `Mandate.x.y` removed.", fieldPath: "x.y" },
  ]);
  assert.deepEqual(result.notPatched, [{ version: "v1", entry: "v1: Node 18 dropped; no call to patch." }]);
  assert.equal(result.problems.length, 3);
  assert.ok(result.problems.every((p) => p.startsWith("the model described a breaking change unusably")));
});

test("a field path with no name in it is listed as nothing to patch, not scanned for", async () => {
  modelSays({
    changes: [{ version: "v1", entry: "v1: `object`, `has_more` and `url` removed from `V2List`.", kind: "field", fieldPath: "*" }],
    notPatched: [],
  });
  const { extractBreakingChanges } = await import("./llmClient.js");
  const result = await extractBreakingChanges("stripe", [{ version: "v1", notes: "* ⚠️ Remove V1-only fields" }]);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.notPatched, [
    { version: "v1", entry: "v1: `object`, `has_more` and `url` removed from `V2List`. (names no field to scan for)" },
  ]);
  assert.deepEqual(result.problems, []);
});

test("two entries for the same method in one release become one change", async () => {
  modelSays({
    changes: [
      { version: "v1", entry: "v1: `crypto_properties` removed from `financialAddresses.create`.", kind: "method", methodName: "financialAddresses.create" },
      { version: "v1", entry: "v1: `type` values removed from `financialAddresses.create`.", kind: "method", methodName: "financialAddresses.create" },
      { version: "v2", entry: "v2: `financialAddresses.create` removed.", kind: "method", methodName: "financialAddresses.create" },
    ],
    notPatched: [],
  });

  const { extractBreakingChanges } = await import("./llmClient.js");
  const { changes } = await extractBreakingChanges("stripe", [{ version: "v1", notes: "..." }]);

  assert.deepEqual(changes.map((c) => [c.version, c.entry.split("\n").length]), [["v1", 2], ["v2", 1]]);
});

test("a reply that isn't the expected object fails the run instead of meaning no changes", async () => {
  const { extractBreakingChanges } = await import("./llmClient.js");
  for (const reply of [[], { changes: [] }, "null", "Sorry, I can't help with that."]) {
    modelSays(reply);
    await assert.rejects(extractBreakingChanges("stripe", [{ version: "v1", notes: "..." }]), /isn't|parse/, JSON.stringify(reply));
  }
});

test("notes that mark breaking changes can't come back empty", async () => {
  const { extractBreakingChanges } = await import("./llmClient.js");
  modelSays({ changes: [], notPatched: [] });

  const flagged = await extractBreakingChanges("stripe", [
    { version: "v2.0.0", notes: "* ⚠️ Remove `Stripe.constructEventWithoutVerification`" },
    { version: "v2.0.1", notes: "* Add `foo` to `Charge`" },
    { version: "v3.0.0", notes: "### Breaking changes\n* `bar` now takes an object" },
  ]);
  assert.deepEqual(flagged.problems, [
    "v2.0.0: the notes mark breaking changes, but the model reported none",
    "v3.0.0: the notes mark breaking changes, but the model reported none",
  ]);

  // A release named as its changelog heading names it, without the "v", is the same release.
  modelSays({ changes: [], notPatched: [{ version: "23.1.0-beta.1", entry: "a field became required" }] });
  const unprefixed = await extractBreakingChanges("stripe", [{ version: "v23.1.0-beta.1", notes: "* ⚠️ Change `x` to be required" }]);
  assert.deepEqual(unprefixed.problems, []);
  assert.deepEqual(unprefixed.notPatched, [{ version: "v23.1.0-beta.1", entry: "a field became required" }]);

  // Saying why there's nothing to patch is an answer.
  modelSays({ changes: [], notPatched: [{ version: "v2.0.0", entry: "a static helper, not a client method" }] });
  const explained = await extractBreakingChanges("stripe", [{ version: "v2.0.0", notes: "* ⚠️ Remove `x`" }]);
  assert.deepEqual(explained.problems, []);
});

test("long notes are read in pieces, every piece checked, and small releases share a request", async () => {
  const { extractBreakingChanges, MAX_PROMPT_NOTES_CHARS } = await import("./llmClient.js");
  const item = (n: number) => `* ⚠️ Remove \`method${n}\` from \`Thing\`\n  - ${"detail ".repeat(60)}`;
  const big = Array.from({ length: 80 }, (_, n) => item(n)).join("\n"); // ~35,000 characters
  // The model finds the change in every piece but the second.
  const bodies = modelSays((prompt: string) => ({
    changes: prompt.includes("(part 2 of") ? [] : [
      { version: "v23.0.0", entry: "a change", kind: "method", methodName: `things.m${prompt.length}` },
    ],
    notPatched: [],
  }));

  const result = await extractBreakingChanges("stripe", [
    { version: "v22.9.0", notes: "* Add `a`" },
    { version: "v22.9.1", notes: "* Fix `b`" },
    { version: "v23.0.0", notes: big },
  ]);

  const prompts = bodies.map((b) => b.contents[0].parts[0].text);
  assert.ok(prompts.length >= 3 && prompts.length <= 5, `${prompts.length} requests`);
  assert.ok(prompts[0].includes("### v22.9.0") && prompts[0].includes("### v22.9.1"));
  for (let n = 0; n < 80; n++) assert.ok(prompts.some((p) => p.includes(`\`method${n}\``)), `method${n} was never sent`);
  assert.ok(prompts.every((p) => p.length < MAX_PROMPT_NOTES_CHARS + 6_000), "a prompt over the piece size");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^v23\.0\.0 \(part 2 of [3-5]\): the notes mark breaking changes, but the model reported none$/);
  assert.ok(bodies.every((b) => b.generationConfig?.temperature === 0));
});

/** A Gemini reply per call, in order; the last one repeats. */
function replies(...statuses: number[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(calls++, statuses.length - 1)];
    if (status !== 200) return new Response(`{"error": {"code": ${status}}}`, { status });
    const text = JSON.stringify({ explanation: "x", patchedCode: "y" });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  }) as typeof fetch;
  return () => calls;
}

test("an overloaded model or a per-minute limit is waited out", async () => {
  const { generatePatch, RETRY_DELAYS_MS } = await import("./llmClient.js");
  RETRY_DELAYS_MS.fill(0);

  const calls = replies(503, 429, 200);
  assert.deepEqual(await generatePatch("entry", "a.js", "code"), { explanation: "x", patchedCode: "y" });
  assert.equal(calls(), 3);
});

test("other errors fail at once, and overloads give up after the last retry", async () => {
  const { generatePatch, RETRY_DELAYS_MS } = await import("./llmClient.js");
  RETRY_DELAYS_MS.fill(0);

  let calls = replies(400);
  await assert.rejects(generatePatch("entry", "a.js", "code"), /Gemini API error: 400/);
  assert.equal(calls(), 1);

  calls = replies(503);
  await assert.rejects(generatePatch("entry", "a.js", "code"), /Gemini API error: 503/);
  assert.equal(calls(), 1 + RETRY_DELAYS_MS.length);
});

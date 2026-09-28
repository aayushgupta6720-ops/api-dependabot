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

test("the model's changes become method or field changes; unusable ones are dropped", async () => {
  const reply = [
    { version: "v1", entry: "v1: `charges.create` removed.", kind: "method", methodName: "charges.create" },
    { version: "v1", entry: "v1: `Mandate.x.y` removed.", kind: "field", fieldPath: "x.y", methodName: "mandates.retrieve" },
    { version: "v1", entry: "no target" },
    { version: "v1", entry: "field without a path", kind: "field" },
    "not an object",
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }))) as typeof fetch;

  const { extractBreakingChanges } = await import("./llmClient.js");
  const changes = await extractBreakingChanges("stripe", [{ version: "v1", notes: "..." }]);

  assert.deepEqual(changes, [
    { version: "v1", entry: "v1: `charges.create` removed.", methodName: "charges.create" },
    { version: "v1", entry: "v1: `Mandate.x.y` removed.", fieldPath: "x.y" },
  ]);
});

test("two entries for the same method in one release become one change", async () => {
  const reply = [
    { version: "v1", entry: "v1: `crypto_properties` removed from `financialAddresses.create`.", kind: "method", methodName: "financialAddresses.create" },
    { version: "v1", entry: "v1: `type` values removed from `financialAddresses.create`.", kind: "method", methodName: "financialAddresses.create" },
    { version: "v2", entry: "v2: `financialAddresses.create` removed.", kind: "method", methodName: "financialAddresses.create" },
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }))) as typeof fetch;

  const { extractBreakingChanges } = await import("./llmClient.js");
  const changes = await extractBreakingChanges("stripe", [{ version: "v1", notes: "..." }]);

  assert.deepEqual(changes.map((c) => [c.version, c.entry.split("\n").length]), [["v1", 2], ["v2", 1]]);
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

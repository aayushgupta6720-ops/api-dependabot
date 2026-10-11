import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addedErrors, typeErrors } from "./sdkTypes.js";

/** A package "fakesdk" in a temp dir, with declarations or without. */
function fakeSdk(declarations: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), "sdk-"));
  const dir = path.join(root, "node_modules", "fakesdk");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fakesdk", main: "index.js", ...(declarations && { types: "index.d.ts" }) }));
  writeFileSync(path.join(dir, "index.js"), "module.exports = class Client {};\n");
  if (declarations) writeFileSync(path.join(dir, "index.d.ts"), declarations);
  return root;
}

const SDK = `declare class Client { constructor(key: string); invoices: { listUpcomingLines(params: { customer: string }): Promise<unknown> }; }
export default Client;
`;

test("a patch is judged by the type errors it adds, not the ones the original already had", () => {
  const root = fakeSdk(SDK);
  const before = 'import Client from "fakesdk";\nconst c = new Client("k");\nc.invoices.listUpcomingLineItems({ customer: "x" });\nc.missing();\n';
  const original = typeErrors(root, before, "fakesdk")!;
  assert.equal(original.length, 2);
  assert.match(original[0], /^TS\d+: Property 'listUpcomingLineItems' does not exist/);

  const fixed = typeErrors(root, before.replace("listUpcomingLineItems", "listUpcomingLines"), "fakesdk")!;
  assert.deepEqual(addedErrors(original, fixed), []);
  const invented = typeErrors(root, before.replace("listUpcomingLineItems", "listUpcomingLinez"), "fakesdk")!;
  assert.equal(addedErrors(original, invented).length, 1);
  const misnamed = typeErrors(root, before.replace("LineItems({ customer:", "Lines({ customer_id:"), "fakesdk")!;
  assert.ok(addedErrors(original, misnamed).some((e) => e.includes("customer_id")));
});

test("a package without declarations can't be type-checked", () => {
  assert.equal(typeErrors(fakeSdk(null), 'import Client from "fakesdk";\nnew Client("k").anything();\n', "fakesdk"), null);
});

test("added errors count repeats", () => {
  assert.deepEqual(addedErrors(["a", "b"], ["a", "a", "c"]), ["a", "c"]);
});

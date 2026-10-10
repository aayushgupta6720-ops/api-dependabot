import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fieldSegments, findFieldUsages, findUsages, readsField } from "./scanner.js";

/** A throwaway repo with the given files; returns its path. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-"));
  for (const [name, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), code);
  }
  return dir;
}

/** file name -> matched line numbers */
const lines = (matches: { filePath: string; lineNumbers: number[] }[]) =>
  Object.fromEntries(matches.map((m) => [path.basename(m.filePath), m.lineNumbers]));

const EXPIRES_AFTER = "payment_method_details.blik.expires_after";

test("field paths split into segments, with [] for array elements", () => {
  assert.deepEqual(fieldSegments(EXPIRES_AFTER), ["payment_method_details", "blik", "expires_after"]);
  assert.deepEqual(fieldSegments("classifications[].credit"), ["classifications", "[]", "credit"]);
  assert.deepEqual(fieldSegments("lines[][].amount"), ["lines", "[]", "[]", "amount"]);
});

test("a read matches when it lines up with the field's end over two or more segments", () => {
  const field = fieldSegments(EXPIRES_AFTER);
  assert.ok(readsField(["payment_method_details", "blik", "expires_after"], field));
  assert.ok(readsField(["blik", "expires_after"], field)); // through a variable holding the details
  assert.ok(!readsField(["expires_after"], field)); // too generic on its own
  assert.ok(!readsField(["payment_method_options", "blik", "expires_after"], field)); // another object's
  assert.ok(!readsField(["payment_method_details", "blik"], field)); // doesn't reach the field
  assert.ok(readsField(["livemode"], ["livemode"]));
  // * stands for any one property under many parents, but isn't a name either
  const igic = fieldSegments("country_options.*.igic");
  assert.ok(readsField(["country_options", "at", "igic"], igic));
  assert.ok(readsField(["country_options", "de", "igic"], igic));
  assert.ok(!readsField(["country_options", "igic"], igic)); // "country_options" isn't a country
  assert.ok(!readsField(["at", "igic"], igic)); // only one name matched
    // an array marker isn't a name: [], credit is just "some element's credit"
  assert.ok(!readsField(["[]", "credit"], fieldSegments("classifications[].credit")));
});

test("finds reads of a field in every form it's written, and nothing else", () => {
  const dir = repo({
    "reads.js": `
const mandate = await stripe.mandates.retrieve(id);
use(mandate.payment_method_details.blik.expires_after);
use(mandate?.payment_method_details?.blik?.expires_after);
use(mandate["payment_method_details"].blik["expires_after"]);
const details = mandate.payment_method_details;
use(details.blik.expires_after);
const { expires_after } = mandate.payment_method_details.blik;
const { blik: { expires_after: when } } = details;
use(mandate.payment_method_details.blik.expires_after.toString());
use((await stripe.mandates.retrieve(id)).payment_method_details.blik.expires_after);
`,
    "near-misses.js": `
// mandate.payment_method_details.blik.expires_after
const text = "payment_method_details.blik.expires_after";
use(pi.payment_method_options.blik.expires_after);
use(settings.expires_after);
use(mandate.payment_method_details.blik);
`,
  });
  assert.deepEqual(lines(findFieldUsages(dir, "stripe", EXPIRES_AFTER)), { "reads.js": [3, 4, 5, 7, 8, 9, 10, 11] });
});

test("reads of array elements are found through indexes, callbacks and for...of", () => {
  const dir = repo({
    "arrays.ts": `
use(txn.classifications[0].credit);
use(txn.classifications[i].credit);
txn.classifications.map((c) => c.credit);
txn.classifications.forEach(function (c) { use(c.credit); });
txn.classifications.reduce((sum, c) => sum + c.credit, 0);
for (const c of txn.classifications) use(c.credit);
txn.classifications.filter(({ credit }) => credit);
for (const { credit } of txn.classifications) use(credit);
`,
    "unrelated.ts": `
items.map((c) => c.credit);
use(account.credit);
txn.classifications.map((c, credit) => credit);
`,
  });
  assert.deepEqual(lines(findFieldUsages(dir, "stripe", "classifications[].credit")), { "arrays.ts": [2, 3, 4, 5, 6, 7, 8, 9] });
});

test("a one-segment field is only looked for in files that use the package", () => {
  const dir = repo({
    "uses-sdk.js": `import Stripe from "stripe";\nconst stripe = new Stripe(k);\nif (event.livemode) go();\n`,
    "no-sdk.js": `if (config.livemode) go();\n`,
  });
  assert.deepEqual(lines(findFieldUsages(dir, "stripe", "livemode")), { "uses-sdk.js": [3] });
});

test("a field path with no name in it matches nothing, rather than every read", () => {
  const dir = repo({ "uses-sdk.js": `import Stripe from "stripe";\nconst list = await stripe.v2.core.accounts.list();\nif (list.has_more) next(list.url);\n` });
  for (const path of ["*", "[]", "*.*", "*[]"]) assert.deepEqual(findFieldUsages(dir, "stripe", path), [], path);
});

test("dependencies, type declarations and build output are never scanned", () => {
  const code = `import Stripe from "stripe";\nconst stripe = new Stripe(k);\nstripe.charges.create({});\nuse(m.payment_method_details.blik.expires_after);\n`;
  const dir = repo({
    "src/app.js": code,
    "node_modules/some-lib/index.js": code,
    "dist/app.js": code,
    "build/app.js": code,
    "types/stripe.d.ts": code,
  });
  assert.deepEqual(lines(findUsages(dir, "stripe", "charges.create")), { "app.js": [3] });
  assert.deepEqual(lines(findFieldUsages(dir, "stripe", EXPIRES_AFTER)), { "app.js": [4] });
});

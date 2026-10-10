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

// ---- how a client gets to a call site ----------------------------------------------

const CREATE = "customers.create";

test("finds calls on a client however it was built and passed around", () => {
  const dir = repo({
    // require("stripe")(key), the style in Stripe's own docs
    "require-call.js": `const stripe = require("stripe")(process.env.KEY);\nstripe.customers.create({});\n`,
    // a client shared from one module and imported in others (CommonJS and ESM)
    "lib/stripe.js": `const Stripe = require("stripe");\nmodule.exports = new Stripe(process.env.KEY);\n`,
    "uses-shared.js": `const stripe = require("./lib/stripe");\nasync function go() {\n  await stripe.customers.create({});\n}\n`,
    "lib/client.ts": `import Stripe from "stripe";\nexport const stripe = new Stripe(process.env.KEY!);\n`,
    "uses-client.ts": `import { stripe as client } from "./lib/client";\nclient.customers.create({});\n`,
    // this.stripe on a class
    "service.js": `import Stripe from "stripe";\nclass Billing {\n  constructor() { this.stripe = new Stripe(k); }\n  signUp() { return this.stripe.customers.create({}); }\n}\n`,
    // a TypeScript parameter typed as the client
    "param.ts": `import Stripe from "stripe";\nexport async function signUp(stripe: Stripe, c: Stripe.Customer) {\n  return stripe.customers.create({});\n}\n`,
    // alias, destructuring, bracket access, assignment after declaration, namespace import
    "forms.js": [
      `import * as S from "stripe";`,
      `let stripe;`,
      `stripe = new S.Stripe(k);`,
      `const s = stripe;`,
      `s.customers.create({});`,
      `const { customers } = stripe;`,
      `customers.create({});`,
      `stripe["customers"].create({});`,
      `const res = stripe.customers;`,
      `res.create({});`,
    ].join("\n"),
    "module.mjs": `import Stripe from "stripe";\nconst stripe = new Stripe(k);\nstripe.customers.create({});\n`,
    "view.tsx": `import Stripe from "stripe";\nconst stripe = new Stripe(k);\nexport const f = () => stripe.customers.create({});\n`,
  });
  assert.deepEqual(lines(findUsages(dir, "stripe", CREATE)), {
    "require-call.js": [2],
    "uses-shared.js": [3],
    "uses-client.ts": [2],
    "service.js": [4],
    "param.ts": [3],
    "forms.js": [5, 7, 8, 10],
    "module.mjs": [3],
    "view.tsx": [3],
  });
});

test("doesn't match the browser library, unrelated objects or a resource type", () => {
  const dir = repo({
    "browser.js": `import { loadStripe } from "@stripe/stripe-js";\nconst stripe = await loadStripe(k);\nstripe.customers.create({});\n`,
    "db.js": `import Stripe from "stripe";\nconst db = connect();\ndb.customers.create({});\n`,
    "types.ts": `import Stripe from "stripe";\nexport function f(customer: Stripe.Customer) {\n  return customer.customers.create({});\n}\n`,
    "helper.js": `const http = require("stripe").createFetchHttpClient();\nhttp.customers.create({});\n`,
  });
  assert.deepEqual(findUsages(dir, "stripe", CREATE), []);
});

test("calling the package itself, and static helpers through a call in the chain", () => {
  const dir = repo({
    "ctor.js": `import Stripe from "stripe";\nconst a = Stripe(k);\nconst b = new Stripe(k);\n`,
    "hooks.js": `import Stripe from "stripe";\nconst event = Stripe.webhooks().constructEvent(body, sig, secret);\n`,
  });
  assert.deepEqual(lines(findUsages(dir, "stripe", "Stripe")), { "ctor.js": [2] });
  assert.deepEqual(lines(findUsages(dir, "stripe", "webhooks.constructEvent")), { "hooks.js": [2] });
});

test("every eval fixture's code is found by the scanner", async () => {
  const { cases } = await import("./eval/fixtures.js");
  const missed = cases.filter((c) => {
    const dir = repo({ "app.ts": c.beforeCode });
    const found = c.fieldPath ? findFieldUsages(dir, "stripe", c.fieldPath) : findUsages(dir, "stripe", c.methodName!);
    return found.length === 0;
  });
  assert.deepEqual(missed.map((c) => c.id), []);
});

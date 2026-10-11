import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SECTION_CHARS,
  apiVersionChange,
  pinnedApiVersion,
  changelogSection,
  numberNotes,
  pointedChangelog,
  resolveReleaseNotes,
  splitNotes,
  type NotesItem,
} from "./releaseNotes.js";

const WATCHED = "stripe/stripe-node";
const pointer = (anchor: string) =>
  `See [the changelog](https://github.com/stripe/stripe-node/blob/private-preview/CHANGELOG.md#${anchor}) for the full release notes.`;

// The shape of stripe-node's CHANGELOG.md on private-preview (2026-09).
const CHANGELOG = `# Changelog

## <a id="22-7-0-alpha-5"></a>22.7.0-alpha.5 - 2026-09-23
This release changes the pinned API version to \`2026-09-23.preview\`.

* ⚠️ [#2854](https://github.com/stripe/stripe-node/pull/2854) Update generated code
  * ⚠️ Remove support for \`create\` method on resource \`Radar.BillingEvaluation\`

## <a id="22-7-0-alpha-4"></a>22.7.0-alpha.4 - 2026-09-16
* Add support for \`foo\` on \`Charge\`

## <a id="22-7-0"></a>22.7.0 - 2026-09-01
* ⚠️ Remove \`charges.create\`
`;

test("a short body linking into the watched repo's changelog is a pointer", () => {
  assert.deepEqual(pointedChangelog(pointer("22-7-0-alpha-5"), WATCHED), {
    repo: "stripe/stripe-node", ref: "private-preview", path: "CHANGELOG.md", anchor: "22-7-0-alpha-5", pointerOnly: true,
  });
});

test("a longer body that links to the changelog but marks nothing breaking itself is a pointer too", () => {
  // stripe-node's v10.0.0 release body, 743 characters; its breaking changes are only in the changelog.
  const v10 = `Major version release for API version 2022-08-01. Default API version changed to "2022-08-01".

Breaking changes that arose during code generation of the library that we postponed for the next major version. For changes to the SDK, read more detailed description at https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v10. For changes to the Stripe products, read more at https://docs.stripe.com/changelog/2022-08-01.

"⚠️" symbol highlights breaking changes.

* [#1497](https://github.com/stripe/stripe-node/pull/1497) API Updates
* [#1493](https://github.com/stripe/stripe-node/pull/1493) Next major release changes

See [the changelog for more details](https://github.com/stripe/stripe-node/blob/v10.0.0/CHANGELOG.md).`;
  assert.deepEqual(pointedChangelog(v10, WATCHED), {
    repo: "stripe/stripe-node", ref: "v10.0.0", path: "CHANGELOG.md", anchor: "", pointerOnly: false,
  });
});

test("real notes, links elsewhere and bodies without a link are left alone", () => {
  const longNotes = "* ⚠️ Remove `charges.create`\n".repeat(20) + pointer("22-7-0");
  assert.equal(pointedChangelog(longNotes, WATCHED), null);
  const longWithoutChangelog = "* Add `x`\n".repeat(60) + "See https://github.com/stripe/stripe-node/blob/v1/README.md";
  assert.equal(pointedChangelog(longWithoutChangelog, WATCHED), null);
  // notes are written by a third party: they can't send the watcher to another repo
  assert.equal(pointedChangelog(pointer("x").replace("stripe/stripe-node", "evil/repo"), WATCHED), null);
  assert.equal(pointedChangelog("Bug fixes.", WATCHED), null);
});

test("the section is found by the link's anchor and stops at the next release", () => {
  const section = changelogSection(CHANGELOG, "22-7-0-alpha-5", "v22.7.0-alpha.5")!;
  assert.ok(section.startsWith('## <a id="22-7-0-alpha-5">'));
  assert.ok(section.includes("Remove support for `create` method on resource `Radar.BillingEvaluation`"));
  assert.ok(!section.includes("22.7.0-alpha.4"));
});

test("without an anchor, the heading that starts with the version is used, exactly", () => {
  const plain = "# Changes\n\n## [v2.1.0] - 2026-01-02\n* Remove `a.b`\n\n## 2.0.0\n* Add `c`\n";
  assert.equal(changelogSection(plain, "missing", "v2.1.0"), "## [v2.1.0] - 2026-01-02\n* Remove `a.b`");
  assert.equal(changelogSection(plain, "missing", "2.0.0"), "## 2.0.0\n* Add `c`");
  // "22.7.0" is its own release, not a prefix of "22.7.0-alpha.5"
  assert.ok(changelogSection(CHANGELOG, "missing", "v22.7.0")!.includes("Remove `charges.create`"));
  assert.equal(changelogSection(CHANGELOG, "missing", "v9.9.9"), null);
});

test("pointer releases get their section; the changelog is fetched once for all of them", async () => {
  const fetches: string[] = [];
  const fetchFile = async (repo: string, ref: string, path: string) => {
    fetches.push(`${repo}/${path}@${ref}`);
    return CHANGELOG;
  };
  const { releases, problems } = await resolveReleaseNotes(
    [
      { version: "v22.7.0-alpha.4", notes: pointer("22-7-0-alpha-4") },
      { version: "v22.7.0-alpha.5", notes: pointer("22-7-0-alpha-5") },
      { version: "v22.6.2", notes: "* Fix a typo" },
    ],
    WATCHED,
    fetchFile
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(fetches, ["stripe/stripe-node/CHANGELOG.md@private-preview"]);
  assert.ok(releases[1].notes.includes("Radar.BillingEvaluation"));
  assert.equal(releases[2].notes, "* Fix a typo");
});

test("a changelog that can't be fetched, or lacks the release, is reported, not skipped silently", async () => {
  const unreachable = await resolveReleaseNotes(
    [{ version: "v22.7.0-alpha.5", notes: pointer("22-7-0-alpha-5") }],
    WATCHED,
    async () => {
      throw new Error("Not Found");
    }
  );
  assert.match(unreachable.problems[0], /^v22\.7\.0-alpha\.5: .*couldn't be read \(Not Found\)/);
  assert.equal(unreachable.releases[0].notes, pointer("22-7-0-alpha-5")); // original body kept

  const missing = await resolveReleaseNotes(
    [{ version: "v23.0.0", notes: pointer("23-0-0") }],
    WATCHED,
    async () => CHANGELOG
  );
  assert.match(missing.problems[0], /no section for this release/);

  // A longer body has a summary of its own: without a section it's used as it is, and nothing's reported.
  const summary = `Major release.\n${"Details. ".repeat(40)}\nSee [the changelog](https://github.com/stripe/stripe-node/blob/v23.0.0/CHANGELOG.md).`;
  const kept = await resolveReleaseNotes([{ version: "v23.0.0", notes: summary }], WATCHED, async () => CHANGELOG);
  assert.deepEqual(kept, { releases: [{ version: "v23.0.0", notes: summary }], problems: [] });
});

test("a long section is kept whole, and only an absurd one is reported instead of cut", async () => {
  const section = (n: number) => `## <a id="1-0-0"></a>1.0.0\n${"* ⚠️ Remove `x`\n".repeat(n)}`;
  const long = await resolveReleaseNotes([{ version: "v1.0.0", notes: pointer("1-0-0") }], WATCHED, async () => section(6000));
  assert.equal(long.releases[0].notes, section(6000).trim());
  assert.deepEqual(long.problems, []);

  const absurd = await resolveReleaseNotes([{ version: "v1.0.0", notes: pointer("1-0-0") }], WATCHED, async () => section(20000));
  assert.ok(MAX_SECTION_CHARS < section(20000).length);
  assert.match(absurd.problems[0], /over the 250000 read/);
});

test("notes are split between top-level items, keeping each item's sub-items, and nothing is lost", () => {
  const notes = [
    "This release changes the pinned API version.",
    "* ⚠️ Remove `a`",
    "  - from `A.create`",
    "  - and `A.update`",
    "* ⚠️ Remove `b`",
    "* Add `c`",
  ].join("\n");
  const pieces = splitNotes(notes, 60);
  assert.deepEqual(pieces, [
    "This release changes the pinned API version.",
    "* ⚠️ Remove `a`\n  - from `A.create`\n  - and `A.update`",
    "* ⚠️ Remove `b`\n* Add `c`",
  ]);
  assert.equal(pieces.join("\n"), notes);
});

test("an item or a line longer than a piece is broken up rather than dropped", () => {
  const long = `* ${"x".repeat(25)}\n  - ${"y".repeat(8)}`;
  const pieces = splitNotes(long, 10);
  assert.ok(pieces.every((p) => p.length <= 10), JSON.stringify(pieces));
  assert.equal(pieces.join("").replace(/\n/g, ""), long.replace(/\n/g, ""));
});

test("numbered notes: one number per line across pieces, and items with their sub-items", () => {
  const { numbered, items } = numberNotes([
    "## 23.0.0\n* ⚠️ Remove `a`\n  * from `X`\n\n* Add `b`",
    "### Breaking changes\n* `c` takes an object\n* not a breaking change, despite saying so\n### Fixes\n* `d`",
    '"⚠️" symbol highlights breaking changes.\n### ⚠️ Removed\n* Remove `e`',
  ]);
  assert.equal(numbered[0], "[1] ## 23.0.0\n[2] * ⚠️ Remove `a`\n[3]   * from `X`\n[4] \n[5] * Add `b`");
  assert.ok(numbered[1].startsWith("[6] ### Breaking changes\n[7] * `c` takes an object"));
  const brief = (piece: NotesItem[]) => piece.map((i) => [i.first, i.last, i.marked]);
  // A nested entry is an item of its own; its parent's subtree runs to the end of it.
  assert.deepEqual(brief(items[0]), [[1, 1, false], [2, 2, true], [3, 4, false], [5, 5, false]]);
  assert.equal(items[0][1].text, "* ⚠️ Remove `a`");
  assert.deepEqual(items[0].map((i) => i.end), [5, 4, 4, 5]);
  // Under a "Breaking changes" heading every entry is marked, until the next heading; the heading itself isn't.
  assert.deepEqual(brief(items[1]), [[6, 6, false], [7, 7, true], [8, 8, true], [9, 9, false], [10, 10, false]]);
  // A ⚠️ heading marks its entries; a ⚠️ in prose marks nothing.
  assert.deepEqual(brief(items[2]), [[11, 11, false], [12, 12, false], [13, 13, true]]);
});

test("the pinned API version is read from each way stripe-node's notes have said it", () => {
  const said = {
    "This release changes the pinned API version to `2025-11-17.clover`.": "2025-11-17.clover",
    "  This release changes the pinned API version to 2024-06-20. Please read the [API Changelog](https://docs.stripe.com/changelog/2024-06-20)": "2024-06-20",
    'Major version release for API version 2022-08-01. Default API version changed to "2022-08-01".': "2022-08-01",
    "  In this release, Stripe API Version `2022-11-15` (the latest at time of release) will be sent by default on all requests.": "2022-11-15",
    'This release includes breaking changes resulting from moving to use the new API version "2022-11-15". To learn more': "2022-11-15",
  };
  for (const [line, version] of Object.entries(said)) {
    assert.deepEqual(pinnedApiVersion(`## 1.0.0\n${line}\n* Add \`x\``), { apiVersion: version, line }, line);
  }
  assert.equal(pinnedApiVersion("* Expose the API version pinned in the SDK via `Stripe.API_VERSION`"), null);
  assert.equal(pinnedApiVersion("* Add support for `2024-06-20` dates"), null);
});

test("only the newest pin among the releases becomes a change", () => {
  const change = apiVersionChange([
    { version: "v17.0.0", notes: "This release changes the pinned API version to `2024-09-30.acacia`." },
    { version: "v17.1.0", notes: "* Add `x`" },
    { version: "v18.0.0", notes: "This release changes the pinned API version to `2025-03-31.basil`.\n* ⚠️ Remove `y`" },
  ]);
  assert.deepEqual(change, {
    version: "v18.0.0",
    entry: "v18.0.0: the pinned API version changed to 2025-03-31.basil.",
    apiVersion: "2025-03-31.basil",
    source: "This release changes the pinned API version to `2025-03-31.basil`.",
  });
  assert.equal(apiVersionChange([{ version: "v1.0.1", notes: "* Fix `z`" }]), null);
});

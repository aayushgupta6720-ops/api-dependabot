import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SECTION_CHARS, changelogSection, pointedChangelog, resolveReleaseNotes, splitNotes } from "./releaseNotes.js";

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
    repo: "stripe/stripe-node", ref: "private-preview", path: "CHANGELOG.md", anchor: "22-7-0-alpha-5",
  });
});

test("real notes, links elsewhere and bodies without a link are left alone", () => {
  const longNotes = "* ⚠️ Remove `charges.create`\n".repeat(20) + pointer("22-7-0");
  assert.equal(pointedChangelog(longNotes, WATCHED), null);
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

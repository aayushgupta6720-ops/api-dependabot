import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareVersions, installedVersion, isRelevant, parseVersion } from "./versions.js";

const v = (s: string) => parseVersion(s)!;

test("versions sort as semver does, pre-releases before their release", () => {
  const ordered = ["v22.6.2", "v22.7.0-alpha.4", "v22.7.0-alpha.5", "v22.7.0-beta.1", "v22.7.0", "v23.0.0", "v23.1.0-alpha.1"];
  const sorted = [...ordered].reverse().sort((a, b) => compareVersions(v(a), v(b)));
  assert.deepEqual(sorted, ordered);
  assert.equal(parseVersion("next"), null);
});

test("a stable repo meets later stable releases only", () => {
  assert.ok(isRelevant("v23.0.0", "22.6.2"));
  assert.ok(!isRelevant("v22.6.2", "22.6.2")); // already on it
  assert.ok(!isRelevant("v22.5.0", "22.6.2"));
  assert.ok(!isRelevant("v23.1.0-alpha.1", "22.6.2")); // an alpha's change isn't this repo's to fix
});

test("a repo on a pre-release follows later pre-releases too", () => {
  assert.ok(isRelevant("v22.7.0-alpha.5", "22.7.0-alpha.4"));
  assert.ok(isRelevant("v22.7.0", "22.7.0-alpha.4"));
  assert.ok(!isRelevant("v22.7.0-alpha.3", "22.7.0-alpha.4"));
});

test("with no installed version known, only stable releases are read", () => {
  assert.ok(isRelevant("v23.0.0", null));
  assert.ok(!isRelevant("v23.1.0-beta.1", null));
  assert.ok(isRelevant("not-a-version", null)); // can't tell: look rather than miss it
});

test("the installed version comes from the lockfile, else the package.json range", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "versions-"));
  assert.equal(installedVersion(repo, "stripe"), null);
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ dependencies: { stripe: "^22.6.0" } }));
  assert.equal(installedVersion(repo, "stripe"), "22.6.0");
  writeFileSync(path.join(repo, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/stripe": { version: "22.6.2" } } }));
  assert.equal(installedVersion(repo, "stripe"), "22.6.2");
  assert.equal(installedVersion(repo, "left-pad"), null);
});

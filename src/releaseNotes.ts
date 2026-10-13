import type { DetectedChange } from "./changes.js";

/**
 * Some releases don't carry their notes. stripe-node's recent ones are just
 * "See [the changelog](https://github.com/stripe/stripe-node/blob/private-preview/CHANGELOG.md#22-7-0-alpha-5)
 * for the full release notes." Given only that, the model can't see a single
 * breaking change, so a release like that gets its notes from its section of
 * the linked changelog instead.
 */

export interface Release {
  version: string; // release tag, e.g. "v22.7.0-alpha.5"
  notes: string;
}

export interface ChangelogLink {
  repo: string; // "owner/name"
  ref: string;
  path: string;
  anchor: string; // "" when the link has none: the section is then found by its version heading
  pointerOnly: boolean; // the body is nothing but the link, so without the section there are no notes at all
}

/** Reads one file of a GitHub repo at a ref; passed in so tests can fake it. */
export type FetchFile = (repo: string, ref: string, path: string) => Promise<string>;

// A body this short is only a pointer: stripe-node's recent ones are ~135 chars.
const POINTER_MAX_CHARS = 300;
// A section past this is reported rather than read. stripe-node's v23.0.0
// is 45,500 characters, read in pieces (see splitNotes); one many times that
// would be a changelog the watcher has misparsed, or one too costly to read.
export const MAX_SECTION_CHARS = 250_000;

const LINK_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/([^/\s)#]+)\/([^\s)#]+)(?:#([\w.-]+))?/g;

/**
 * The changelog a release's notes point to instead of containing in full, or
 * null if they have notes of their own. That's a short body with a link into
 * the watched repo, or a longer one that links to its CHANGELOG but marks no
 * entry of its own as breaking: stripe-node's v10.0.0 and v11.0.0 bodies are a
 * summary, the ⚠️ legend and "See the changelog for more details", with the
 * breaking changes only in the changelog. Only links into `watchedRepo` count:
 * the notes are written by a third party, so they don't get to send the
 * watcher anywhere else.
 */
export function pointedChangelog(notes: string, watchedRepo: string): ChangelogLink | null {
  const links = [...notes.matchAll(LINK_RE)].filter((m) => m[1].toLowerCase() === watchedRepo.toLowerCase());
  const pointerOnly = notes.trim().length <= POINTER_MAX_CHARS;
  const m = pointerOnly
    ? links.find((l) => l[4]) ?? links[0]
    : links.find((l) => /(^|\/)changelog\.md$/i.test(l[3]));
  if (!m) return null;
  if (!pointerOnly && numberNotes([notes]).items[0].some((item) => item.marked)) return null;
  return { repo: m[1], ref: m[2], path: m[3], anchor: m[4] ?? "", pointerOnly };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingLevel = (line: string) => line.match(/^(#{1,6})\s/)?.[1].length ?? 0;

/**
 * The section of a markdown changelog under the heading with anchor id
 * `anchor` (`## <a id="22-7-0-alpha-5"></a>22.7.0-alpha.5 - 2026-09-23`), or
 * failing that the heading that starts with the version ("## 22.7.0",
 * "## [v22.7.0]"), up to the next heading of the same or a higher level.
 * Null if there's no such heading.
 */
export function changelogSection(markdown: string, anchor: string, version: string): string | null {
  const lines = markdown.split("\n");
  // Followed by anything but more version: "22.7.0" mustn't match "22.7.0-alpha.1".
  const versionHeading = new RegExp(
    `^#{1,6}\\s+(?:<a[^>]*></a>\\s*)?\\[?v?${escapeRe(version.replace(/^v/, ""))}(?![\\w.-])`
  );
  let start = lines.findIndex((l) => headingLevel(l) > 0 && l.includes(`id="${anchor}"`));
  if (start === -1) start = lines.findIndex((l) => versionHeading.test(l));
  if (start === -1) return null;

  const level = headingLevel(lines[start]);
  const next = lines.findIndex((l, i) => i > start && headingLevel(l) > 0 && headingLevel(l) <= level);
  return lines.slice(start, next === -1 ? lines.length : next).join("\n").trim();
}

/**
 * Each release's notes, with a pointer-only body replaced by its changelog
 * section. `problems` names the releases whose notes couldn't be read that
 * way (they keep their original body); the caller shouldn't mark those as
 * seen, since breaking changes in them would go unnoticed.
 */
export async function resolveReleaseNotes(
  releases: Release[],
  watchedRepo: string,
  fetchFile: FetchFile
): Promise<{ releases: Release[]; problems: string[] }> {
  const files = new Map<string, Promise<string>>(); // one fetch per changelog, however many releases point at it
  const resolved: Release[] = [];
  const problems: string[] = [];

  for (const release of releases) {
    const link = pointedChangelog(release.notes, watchedRepo);
    if (!link) {
      resolved.push(release);
      continue;
    }
    const file = `${link.repo}/${link.path}@${link.ref}`;
    try {
      if (!files.has(file)) files.set(file, fetchFile(link.repo, link.ref, link.path));
      const section = changelogSection(await files.get(file)!, link.anchor, release.version);
      if (section === null && !link.pointerOnly) {
        resolved.push(release); // the body's own summary is the best there is
        continue;
      }
      if (section === null) throw new Error("it has no section for this release");
      if (section.length > MAX_SECTION_CHARS) {
        throw new Error(`its section is ${section.length} characters, over the ${MAX_SECTION_CHARS} read`);
      }
      resolved.push({ version: release.version, notes: section });
    } catch (err) {
      problems.push(`${release.version}: its notes are a link to ${file}, which couldn't be read (${(err as Error).message})`);
      resolved.push(release);
    }
  }

  return { releases: resolved, problems };
}

/**
 * `notes` in pieces of at most `max` characters, for the model to read one at
 * a time. A piece breaks before a top-level list item or heading, so an item
 * stays with its sub-items; an item longer than `max` breaks between lines,
 * and a line longer than that is cut. Nothing is dropped.
 */
export function splitNotes(notes: string, max: number): string[] {
  const items: string[] = [];
  for (const line of notes.split("\n")) {
    if (items.length === 0 || /^(?:[*+-]\s|#)/.test(line)) items.push(line);
    else items[items.length - 1] += `\n${line}`;
  }

  const pieces: string[] = [];
  let current = "";
  const add = (text: string) => {
    if (current && current.length + 1 + text.length > max) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current}\n${text}` : text;
  };
  for (const item of items) {
    if (item.length <= max) {
      add(item);
      continue;
    }
    for (const line of item.split("\n")) {
      for (let i = 0; i < Math.max(line.length, 1); i += max) add(line.slice(i, i + max));
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** An item of release notes: a list entry (at any depth) or a heading, with
 * the lines that continue it, and the numbers numberNotes gave its first and
 * last lines. `end` is the last line of the entries nested under it. */
export interface NotesItem {
  text: string;
  first: number;
  last: number;
  end: number;
  marked: boolean; // the notes mark it as breaking
}

/**
 * Pieces of release notes with every line numbered ("[12] * Remove `x`"), so
 * the model can say which line states each change, and the items those lines
 * belong to, per piece. Numbers run on across pieces, so each names one line.
 *
 * Every list entry is an item, nested ones too: stripe-node's v23.0.0 has one
 * top-level entry ("Changes to the API") whose sub-entries, many marked ⚠️,
 * fill three pieces. An entry is marked breaking if its own text carries ⚠️ or
 * "BREAKING CHANGE", or it's a top-level entry under a heading that does or
 * that starts "Breaking" ("### ⚠️ Removed", "## Breaking changes"). Headings
 * and prose never are: stripe-node's notes open with
 * '"⚠️" symbol highlights breaking changes.'
 */
export function numberNotes(pieces: string[]): { numbered: string[]; items: NotesItem[][] } {
  let n = 0;
  const numbered: string[] = [];
  const items: NotesItem[][] = [];
  for (const text of pieces) {
    const lines: string[] = [];
    const pieceItems: (NotesItem & { indent: number })[] = [];
    let underBreakingHeading = false;
    for (const line of text.split("\n")) {
      n++;
      lines.push(`[${n}] ${line}`);
      const heading = /^#/.test(line);
      const entry = line.match(/^(\s*)[*+-]\s/);
      if (heading) underBreakingHeading = /⚠️|BREAKING[ _-]CHANGE|^#+\s*breaking/i.test(line);
      const current = pieceItems.at(-1);
      if (current && !heading && !entry) {
        current.text += `\n${line}`;
        current.last = n;
        continue;
      }
      const indent = heading ? -1 : (entry?.[1].length ?? 0);
      const own = !heading && entry !== null && /⚠️|BREAKING[ _-]CHANGE/.test(line);
      pieceItems.push({
        text: line,
        first: n,
        last: n,
        end: n,
        indent,
        marked: own || (entry !== null && indent === 0 && underBreakingHeading),
      });
    }
    // Each item's subtree runs to the line before the next item at its depth or shallower.
    pieceItems.forEach((item, i) => {
      const next = pieceItems.slice(i + 1).find((later) => later.indent <= item.indent);
      item.end = next ? next.first - 1 : n;
    });
    numbered.push(lines.join("\n"));
    items.push(pieceItems.map(({ indent, ...item }) => item));
  }
  return { numbered, items };
}

// How many related lines a patch gets, and how long each may be.
const MAX_RELATED = 6;
const MAX_RELATED_CHARS = 400;
// A name in more of a release's entries than this says nothing about which
// ones belong together (v23.0.0 names `PaymentIntent` all over).
const MAX_NAME_ENTRIES = 8;

/** The code names an entry mentions in backticks, plus the object a field
 * path is on: `Mandate.payment_method_details.blik.expires_after` also names
 * `Mandate.payment_method_details.blik`. */
function codeNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const [, name] of text.matchAll(/`([^`\n]+)`/g)) {
    names.add(name);
    const parts = name.split(".");
    if (parts.length >= 4) names.add(parts.slice(0, -1).join("."));
  }
  return names;
}

/**
 * Entries of a release's notes that mention a code name the change's own
 * entry does, nearest first: what a patch needs that one entry doesn't say.
 * stripe-node's v22.7.0-alpha.4 adds `expires_at` on
 * `Mandate.payment_method_details.blik` one line above removing
 * `expires_after` there, so the removal is a rename; and v22.0.0's "plain API
 * key" entry says to use `RequestOptions`, while the entry after it says
 * those now always come after the params. `stated` is the change's entry as
 * the notes have it, or as a PR quotes it; each line comes back trimmed and
 * cut to MAX_RELATED_CHARS.
 */
export function relatedLines(notes: string, stated: string): string[] {
  const entries = numberNotes([notes]).items[0].filter((item) => !/^#/.test(item.text));
  const names = codeNames(stated);
  if (names.size === 0) return [];
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const name of codeNames(entry.text)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const telling = [...names].filter((name) => (counts.get(name) ?? 0) <= MAX_NAME_ENTRIES);
  const own = entries.filter((e) => stated.includes(e.text.trim()));
  const at = own.length ? own[0].first : 0;
  return entries
    .filter((e) => !own.includes(e) && [...codeNames(e.text)].some((name) => telling.includes(name)))
    .sort((a, b) => Math.abs(a.first - at) - Math.abs(b.first - at) || a.first - b.first)
    .slice(0, MAX_RELATED)
    .map((e) => {
      const line = e.text.replace(/\s+/g, " ").trim();
      return line.length > MAX_RELATED_CHARS ? `${line.slice(0, MAX_RELATED_CHARS - 1)}…` : line;
    });
}

// How stripe-node's notes announce a new pinned API version, from v10.0.0 on:
// 'moving to use the new API version "2022-11-15"' (v10, v11), 'In this
// release, Stripe API Version `2022-11-15` ... will be sent by default' (v12),
// and since then 'This release changes the pinned API version to
// `2025-11-17.clover`.' Minor releases move it too.
const API_VERSION = String.raw`[\x60"']?(\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?)[\x60"']?`;
const PIN_RES = [
  new RegExp(String.raw`pinned API version to ${API_VERSION}`, "i"),
  new RegExp(String.raw`default API version changed to ${API_VERSION}`, "i"),
  new RegExp(String.raw`\bnew API version ${API_VERSION}`, "i"),
  new RegExp(String.raw`API version ${API_VERSION}[^.\n]*\bby default\b`, "i"),
];

/** The API version a release's notes say the SDK now pins, and the line that
 * says so; null if they don't. The last one wins if there are several. */
export function pinnedApiVersion(notes: string): { apiVersion: string; line: string } | null {
  let found: { apiVersion: string; line: string } | null = null;
  for (const line of notes.split("\n")) {
    for (const re of PIN_RES) {
      const m = line.match(re);
      if (m) {
        found = { apiVersion: m[1], line };
        break;
      }
    }
  }
  return found;
}

/** A change for the newest API version these releases pin, if any of them
 * moves it: only the last one matters, since that's the version the code ends
 * up on. Keyed, like any change, on the notes' line that says so. */
export function apiVersionChange(releases: Release[]): DetectedChange | null {
  let latest: DetectedChange | null = null;
  for (const release of releases) {
    const pin = pinnedApiVersion(release.notes);
    if (pin) {
      latest = {
        version: release.version,
        entry: `${release.version}: the pinned API version changed to ${pin.apiVersion}.`,
        apiVersion: pin.apiVersion,
        source: pin.line,
      };
    }
  }
  return latest;
}

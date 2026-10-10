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
  anchor: string;
}

/** Reads one file of a GitHub repo at a ref; passed in so tests can fake it. */
export type FetchFile = (repo: string, ref: string, path: string) => Promise<string>;

// Only a body this short counts as a pointer: stripe-node's are ~135 chars,
// real notes run to thousands. Longer notes are used as they are, even if
// they also link to the changelog.
const POINTER_MAX_CHARS = 300;
// A section past this is reported rather than read. stripe-node's v23.0.0
// is 45,500 characters, read in pieces (see splitNotes); one many times that
// would be a changelog the watcher has misparsed, or one too costly to read.
export const MAX_SECTION_CHARS = 250_000;

const LINK_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/([^/\s)#]+)\/([^\s)#]+)#([\w.-]+)/;

/**
 * The changelog a release's notes point to instead of containing, or null if
 * they have notes of their own. Only links into `watchedRepo` count: the
 * notes are written by a third party, so they don't get to send the watcher
 * anywhere else.
 */
export function pointedChangelog(notes: string, watchedRepo: string): ChangelogLink | null {
  if (notes.trim().length > POINTER_MAX_CHARS) return null;
  const m = notes.match(LINK_RE);
  if (!m || m[1].toLowerCase() !== watchedRepo.toLowerCase()) return null;
  return { repo: m[1], ref: m[2], path: m[3], anchor: m[4] };
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

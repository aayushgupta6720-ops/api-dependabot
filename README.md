# api-dependabot

**Live dashboard:** https://aayushgupta6720-ops.github.io/api-dependabot/
(updated by a [daily scheduled run](#scheduled-runs) of the agent)

A multi-step autonomous agent pipeline (detect → scan → patch → PR) that
watches an SDK's changelog for breaking changes, resolves real usages via
AST analysis, and uses an LLM to generate and submit fixing pull requests
without human intervention — going beyond version-bump tools like
Dependabot by actually patching the affected code.

Includes an eval harness that replays real breaking-change fixtures
through the patch generator to catch regressions in output quality, and
fault-tolerant run logging that isolates failures per-item so one bad
patch or PR doesn't abort the rest of a run.

**Stack:** TypeScript, Node.js, LLM integration (Gemini), prompt
engineering, AST analysis (ts-morph), GitHub API/Octokit, agentic
pipeline design, eval harness design

## Setup

```bash
npm install
cp .env.example .env   # fill in GEMINI_API_KEY, GITHUB_TOKEN, TARGET_REPO
```

- Get a free Gemini key: https://aistudio.google.com/apikey
- Create a GitHub token with `repo` scope: https://github.com/settings/tokens
- `TARGET_REPO` should be a throwaway repo you own, e.g. `yourname/test-repo`,
  containing some sample code that calls the SDK you're tracking.
- Clone that same repo locally into `./target-repo` (the scanner reads it from disk).
- `TARGET_PACKAGE` (optional, defaults to `stripe`) is the package name the
  scanner looks for in `import` statements.
- `TARGET_PACKAGE_REPO` (optional, defaults to `stripe/stripe-node`) is the GitHub
  repo whose Releases the changelog watcher polls for breaking changes.

## Run

```bash
npm run dev
```

This checks `TARGET_PACKAGE_REPO`'s GitHub releases for breaking changes
since the last run (tracked in `.changelog-state.json`), extracts them with
Gemini, then runs scan → generate patch → open PR for each one it finds.
The scanner groups call sites by file, so a file that calls the changed
method several times still gets one patch and one PR.

A change is either to a method (`charges.create` removed, or one of its
parameters) or to a field of an object the SDK returns
(`Mandate.payment_method_details.blik.expires_after` removed or made
optional). For a method, the scanner finds calls on a client built from the
package. For a field, it finds code that reads it: plain or optional
chaining, `["quoted"]` keys, destructuring, and array elements through
indexes, `.map`/`.forEach`-style callbacks and `for…of`
(`classifications[].credit`). With no type information in plain JS, a read
counts when its path lines up with the end of the field's path over at least
two names, so `details.blik.expires_after` matches but a bare
`x.expires_after` doesn't. A one-name field (`livemode`) is only looked for
in files that import the package, and `*` stands for any one property when
a field changed under many parents (`country_options.*.igic`). A false
match costs a model call that finds nothing to change. The scanner skips
`node_modules`, `.d.ts` files and `dist`/`build` output.

On the very first run there's no "last seen" marker yet, so it only looks at
the single most recent release — it won't replay the SDK's entire history.

Some releases don't carry their notes: stripe-node's recent ones just say
"See [the changelog](…/CHANGELOG.md#22-7-0-alpha-5) for the full release
notes." For a release that short, the watcher reads that release's section
of the linked changelog instead (found by the link's anchor, or failing that
by a heading starting with the version) and sends that to the model. It
only follows links into `TARGET_PACKAGE_REPO` itself. If the section can't
be read, the run log and dashboard say so and the release stays unseen, so
its breaking changes aren't silently missed.

The marker only moves once every change from those releases has been
handled. If a patch or PR fails, the releases stay unseen and the next run
retries them. Each fix goes on a branch named after its change and file
(`api-dependabot/<version>-<method>-<file>`), so a retry finds the PR an
earlier run opened and skips that file, without a model call. A PR that was
closed counts too, so a fix someone rejected isn't reopened.

## Model and free-tier quota

The model is `gemini-3.5-flash-lite`, set by `MODEL` in `src/llmClient.ts`.
The free tier allows it 500 requests/day per Google project. The bigger
`gemini-3.5-flash` and `gemini-3.6-flash` work too, but get only 20
requests/day each, and a single `npm run eval` uses 10.

`npm run dev` makes no Gemini calls when there are no new releases.
Otherwise it makes one call to extract breaking changes from all new
releases at once, plus one per affected file for each breaking change.
The key goes in an `x-goog-api-key` header rather than the URL, where
proxies and request logs would record it.

A call that gets a 503 back (the model is overloaded, which usually clears
within seconds) or a 429 (a per-minute limit) is retried after 5, 15 and 45
seconds before it counts as failed. Any other error fails at once.

## Eval harness

```bash
npm run eval
```

Replays a fixed set of breaking-change fixtures (`src/eval/fixtures.ts`)
straight through `generatePatch`, checks the output against each fixture's
`mustContain`/`mustNotContain` substrings or patterns, and writes full
results (explanations + patched code, not just pass/fail) to
`eval-results/`. `npm run eval -- blik` runs only the cases whose id
contains "blik".

The bundled fixtures are 13 real breaking changes pulled straight from
[stripe-node's own CHANGELOG](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md)
(v6.21.0 through v22.7.0-alpha.4), each citing the release it shipped in:
10 method changes, a renamed field, a field made optional, and a field
removed with no replacement. If you point `TARGET_PACKAGE_REPO` at a
different SDK, swap these out for that SDK's own history the same way.

What a patch does depends on the change. With a replacement (a rename, or
another way to do the same thing), the code switches to it. A field made
optional gets its reads guarded. With no replacement, the patch doesn't
invent one or fake a value: a removed field's read stays (it now gives
`undefined`) under a `TODO(api-dependabot):` comment, and a removed
method's call becomes an explicit `throw` with one. Its PR is titled
"Needs review" rather than "Fix breaking change", since a person has to
decide what the code should do now. Either way the patch keeps the file's
own ending and line breaks, so a model's extra blank line, or "\n" line
breaks in a "\r\n" file, don't show up in the diff.

## Regenerating a PR

```bash
npm run regenerate -- 7 --dry-run   # show the new patch for PR #7
npm run regenerate -- 7             # commit it to the PR and update its title and body
```

A run never revisits a file that already has a fix PR, so a PR opened
before a prompt change keeps its old patch. `regenerate` redoes one: it
reads the changelog entry quoted in the PR's body and the file as it is at
the PR's base commit, asks for a new patch, commits it to the PR's branch,
and updates the title and body. It only touches open PRs that
api-dependabot opened and that change one file, and pushes nothing if the
new patch changes nothing or matches what the PR already has.

## Run logging

Every `npm run dev` run appends a JSON entry to `run-log.jsonl` (gitignored,
created on first run): changes found, call sites or field reads found, and a per-file outcome
(`pr_opened` / `pr_exists` / `no_change_needed` / `error`; `pr_exists`
means an earlier run already opened that fix). A failure patching or opening
a PR for one file is caught and recorded instead of aborting the rest of
the run — later changes/files in the same run still get processed.

## Scheduled runs

`.github/workflows/agent.yml` runs the agent every day at 06:17 UTC against
stripe-node's releases, opening its PRs on
[test-repo](https://github.com/aayushgupta6720-ops/test-repo). It runs the
eval harness on Mondays at 06:43 UTC. After each run it publishes the
dashboard to GitHub Pages (the live link above). It needs two Actions
secrets:

- `GEMINI_API_KEY`
- `TARGET_REPO_TOKEN`: a fine-grained token that can only reach the repo the
  agent patches, with Contents and Pull requests set to read and write.
  Fine-grained tokens can always read public repos, which covers the SDK's
  releases and changelog.

What the runs need to remember (`run-log.jsonl`, `.changelog-state.json`,
`eval-results/`) is kept on the `dashboard-data` branch. Each run restores it,
commits what changed, and pushes it back, so the daily commits stay out of
`main`. To look at that data locally:

```bash
git fetch origin dashboard-data
git show origin/dashboard-data:run-log.jsonl
```

Local `npm run dev` runs keep their own state in the working copy and don't
touch the branch.

To run it by hand, use `gh workflow run agent.yml`, or add `-f eval=true`
to run the eval harness instead. A run whose agent step fails still saves
and publishes its log entry, error included, and is then marked failed so
GitHub sends an email. GitHub switches off schedules in a public repo after
60 days with no activity. If that happens, re-enable the workflow in the
Actions tab.

## Dashboard

```bash
npm run dashboard
```

Serves a read-only view at `http://localhost:4200` (override with
`DASHBOARD_PORT`): a feed of past runs (with PR links / error badges),
eval pass-rate history from `eval-results/`, and watcher health (last run,
last seen release tag from `.changelog-state.json`). No new dependencies —
built on Node's built-in `http` server plus a static HTML/JS page.

It listens on `127.0.0.1` only, since the run history (PR links, file
paths, errors) isn't for everyone on your network. `DASHBOARD_HOST=0.0.0.0`
opens it up; there's no auth, so only do that on a network you trust.

`npm run dashboard:build -- <dir>` writes a static copy: the same page, with
each API response saved as a file at the URL the page fetches
(`api/runs.json`, …). That's what the scheduled run publishes. Its data comes
from runs against the public test repo, so publishing it is deliberate. It's
read-only: plain files, no server behind it.
Everything it shows is escaped: versions and method names are the model's
reading of someone else's release notes, and errors can quote raw model
output, so none of it is trusted as HTML. An unreadable line in
`run-log.jsonl` or eval file is skipped rather than taking the page down.

## Tests

```bash
npm test
```

Runs offline with Node's built-in test runner (no API keys or network): the
retry logic in `src/pipeline.ts` (what gets marked seen, what a retry
skips), the dashboard's escaping and error handling, its static copy, and
how the Gemini key is sent.

## What's stubbed vs. real

| Piece | Status |
|---|---|
| Usage scanner (AST-based) | Working — resolves call sites back to a client built from the tracked package, finds reads of changed fields, and groups both per file |
| LLM patch generation (Gemini) | Working |
| GitHub PR creation | Working |
| Changelog watcher | Working — polls GitHub Releases, extracts breaking changes via Gemini |
| Eval harness | Working — replays fixtures through the patch generator, grades pass/fail |
| Run logging | Working — every run appends structured results to `run-log.jsonl` |
| Dashboard | Working — read-only view of runs, evals, and watcher health; published to GitHub Pages after each scheduled run |

## Next steps

Nothing major stubbed out. Possible follow-ups: retention/rotation for
`run-log.jsonl` as the daily runs grow it, and auth if the live server
(rather than the static copy) is ever exposed beyond localhost.

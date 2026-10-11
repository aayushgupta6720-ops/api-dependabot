# api-dependabot

**Live dashboard:** https://aayushgupta6720-ops.github.io/api-dependabot/
(updated by a [daily scheduled run](#scheduled-runs) of the agent)

A multi-step autonomous agent pipeline (detect → scan → patch → PR) that
watches an SDK's changelog for breaking changes, resolves real usages via
AST analysis, and uses an LLM to generate and submit fixing pull requests
without human intervention. Where Dependabot bumps the version and leaves
the code to you, this patches the code; it doesn't bump the version itself,
so its PRs are the code half of an upgrade.

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
package, however the client got there: an `import` or a `require` (including
`require("stripe")(key)`), a client created in one module and imported in
another, `this.stripe` on a class, an alias, `const { customers } = stripe`,
a TypeScript parameter typed `Stripe`, and bracket access. Only the package
itself counts: `@stripe/stripe-js`, the browser library, doesn't. A method
named like the package (`Stripe`) means calling the package itself, as in
`Stripe(key)` without `new`. For a field, it finds code that reads it: plain or optional
chaining, `["quoted"]` keys, destructuring, and array elements through
indexes, `.map`/`.forEach`-style callbacks and `for…of`
(`classifications[].credit`). With no type information in plain JS, a read
counts when its path lines up with the end of the field's path over at least
two names, so `details.blik.expires_after` matches but a bare
`x.expires_after` doesn't. A one-name field (`livemode`) is only looked for
in files that import the package, and `*` stands for any one property when
a field changed under many parents (`country_options.*.igic`). Extraction
also names the resource whose objects carry a field (`customers` for
`Customer`), and a read whose object the code shows came from another
resource is skipped: Customer's `currency` becoming nullable says nothing
about `balance.available.map((b) => b.currency)`. Reads it can't trace (a
parameter, a `.then` callback) still count, and so does a field read through
an expanded object (`invoice.customer.currency`). In TypeScript a declared
type says where an object came from too, so `product: Stripe.Product` is a
Product. Before this, the end-to-end eval below once got a PR "fixing" that
balance read, and on a real repo (below) three Product, Price and
PaymentMethod reads were taken for Customer's. The scanner reads
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` files, and skips
`node_modules`, `.d.ts` files and `dist`/`build` output. A test checks that
it finds the code of every eval fixture.

The pinned API version is handled without the model. Recent stripe-node
types only accept the one API version a release pins, so TypeScript that
pins an older one (`apiVersion: '2020-08-27'`) stops compiling, and most
releases move the pin. The new version is read from the notes ("changes the
pinned API version to `2025-11-17.clover`", "moving to use the new API
version") for the newest release among those read, and each older pin in a
`.ts` file that imports the package becomes the new one, under a
`TODO(api-dependabot):` comment pointing at Stripe's upgrade guide: the API
itself behaves differently between versions, so the PR is titled "Needs
review". In JavaScript an older pin keeps working, so it's left alone.

Before a patch becomes a pull request it has to parse, as TypeScript or
JavaScript (types aren't checked: the target repo's dependencies aren't
installed where the agent runs), and it has to edit the file rather than
replace it: it may change at most 60% of the file's lines, or 3 in a short
file. Correct patches in the eval changed 0-43%. A rejected patch is
recorded as an error, so its release stays unseen and the next run tries
again.

On the very first run there's no "last seen" marker yet, so it only looks at
the single most recent release — it won't replay the SDK's entire history.

It only reads releases the patched repo will meet. The installed version
comes from the repo's `package-lock.json`, or else the lowest version its
`package.json` range allows; releases at or below it are passed over, and so
are pre-releases (alpha, beta) unless the installed version is one too. A
repo that names no version gets stable releases only. Passed-over releases
still count as seen, and the run log and dashboard list them. Before this,
an alpha's removal was patched into code that, on a stable release, still
had the field.

Some releases don't carry their notes: stripe-node's recent ones just say
"See [the changelog](…/CHANGELOG.md#22-7-0-alpha-5) for the full release
notes." For a release that short, the watcher reads that release's section
of the linked changelog instead (found by the link's anchor, or failing that
by a heading starting with the version) and sends that to the model. A
longer body counts as a pointer too when it links to the changelog but marks
no entry of its own as breaking: v10.0.0's and v11.0.0's are a summary, the
⚠️ legend and "See the changelog for more details". It only follows links
into `TARGET_PACKAGE_REPO` itself. If the section can't
be read, the run log and dashboard say so and the release stays unseen, so
its breaking changes aren't silently missed.

Long notes are read in pieces of about 12,000 characters, split between
list items, and small releases share a request. Each line goes to the model
numbered, and every change it reports has to say which line states it.
Every list entry the notes mark as breaking (⚠️ or "BREAKING CHANGE" on the
entry, or a top-level entry under a "⚠️ Removed" or "Breaking changes"
heading) has to come back either as a change to patch or as one with nothing
to patch, with the reason: a removed export, a dropped Node version, a field
that became required. The dashboard lists those too. Nested entries count
on their own: v23.0.0 has one top-level entry whose ⚠️ sub-entries fill
three pieces. An entry the model passes over gets one more request, about
just the entries still unanswered; in a dry run on v23.0.0 the first pass
skipped one of them. The releases stay unseen, and the next run reads them
again, if the reply isn't in the expected shape, if a change can't be
scanned for or names no line of its release, or if a marked entry is still
unanswered after that.

This replaced a cut at 40,000 characters. stripe-node's v23.0.0 section is
45,500 characters with 26 items marked breaking; cut and sent in one prompt
with the three releases after it, it came back with none, and the run marked
it seen. Read in pieces in a dry run, the same four releases gave 54 changes
to scan for and 22 breaking items with nothing to patch.

The marker only moves once every change from those releases has been
handled. If a patch or PR fails, the releases stay unseen and the next run
retries them. Each fix goes on a branch keyed on its release, the entry of
the notes that states it and the file
(`api-dependabot/<version>-<hash of the entry>-<file>`), so a retry finds the
PR an earlier run opened and skips that file, without a model call, even if
the model named or worded the change differently this time. A PR that was
closed counts too, so a fix someone rejected isn't reopened. Changes stated
in the same entry ("Remove `foo` and `bar`") share that branch: the first
to reach a file gets one patch for all of them, and the rest find its PR.

## Model and free-tier quota

The model is `gemini-3.5-flash-lite`, set by `MODEL` in `src/llmClient.ts`.
The free tier allows it 500 requests/day per Google project. The bigger
`gemini-3.5-flash` and `gemini-3.6-flash` work too, but get only 20
requests/day each, and a single `npm run eval` uses 10.

`npm run dev` makes no Gemini calls when there are no new releases.
Otherwise it makes one call per 12,000 characters of new release notes to
extract breaking changes (stripe-node's four releases after v22.7.0-alpha.5
took 9), one more for a batch with marked entries the model passed over,
plus one per affected file for each breaking change.
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
straight through `generatePatch`, checks that the output would pass the
pre-PR check above and matches each fixture's `mustContain`/`mustNotContain`
substrings or patterns, and writes full
results (explanations + patched code, not just pass/fail) to
`eval-results/`. `npm run eval -- blik` runs only the cases whose id
contains "blik", and `--samples 3` runs each case three times, since one
patch says little about a model whose output varies; the weekly run uses 3.

Each patch is also type-checked against the SDK release its change shipped
in: `npm run eval:sdks` downloads those versions of `stripe` (with their
own type declarations) into `.cache/sdk/`, and a case fails if the patched
file has type errors the original didn't, such as a method the model
invented or a parameter it misnamed. The original's own errors (often the
breaking change itself) don't count against it. stripe 6.21.0 ships no
types, so that one case is only parsed.

The first run with type checks (2026-10-11) scored 12/13. It caught a patch
the substring checks had passed: for v22's "pass the API key in the
RequestOptions object", the model wrote `customers.retrieve(id, { apiKey })`,
which puts it in the params; v22 declares `retrieve(id, params?, options?)`,
so it belongs third. It also showed two fixtures that were never
type-correct, which the breaking-change error had hidden: a webhook call
with one argument of three, and an alert missing its required `title` and
`recurrence`. Both were fixed, so a correct patch now leaves no type errors.

```bash
npm run eval:e2e
```

The end-to-end eval runs a real release through everything but GitHub:
stripe-node's 10.0.0 changelog (22 entries marked breaking) goes through
extraction, a three-file repo (`src/eval/e2e/repo/`) through the scanner,
then the patches, the pre-PR check and the type check against stripe
10.0.0. It passes when every marked entry is accounted for, the two renamed
or removed methods the repo calls are found, exactly the two affected files
get PRs, and both patches are right. It takes about five model calls.

```bash
npm run eval:real
```

The real-consumer eval runs the agent on an open-source repo:
[vercel/nextjs-subscription-payments](https://github.com/vercel/nextjs-subscription-payments)
at the commit before it upgraded stripe from 8.201.0 to 11.13.0. What the
upgrade breaks is measured rather than guessed: the type errors its
stripe-using files get under 11.13.0's declarations that they didn't have
under 8.201.0's. There are two, the same two the maintainers fixed in their
upgrade commit: the pinned API version, and a Subscription `status` that
gained `"paused"`, which no longer fits the app's own status type. The agent
reads the three majors in between, scans, patches (PRs are recorded, not
opened), and each patched file is type-checked again.

First runs (2026-10-11), each of which changed the agent:

- It read nothing from v10.0.0 or v11.0.0, whose bodies only link to the
  changelog, and reported both as problems rather than marking them seen.
  Longer pointer bodies are now followed (above).
- It then flagged three reads in `supabase-admin.ts` (a Product's `name`, a
  Price's `currency`, a PaymentMethod's billing details) for v10's
  now-nullable Customer fields; none broke. Declared types now rule those out.
- It didn't touch the pinned API version, which isn't a method or a field.
  It does now.

Result: 1 of the 2 breakages fixed, no PRs on files the upgrade didn't
break, no new type errors, in four model calls. The miss is the widened
enum: the fix is in the app's own types (the maintainers changed their
database schema), and the agent ignores new enum values by design.

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
GitHub sends an email. Failures stay in the history: a run that failed
because of the deployment (a mistyped token secret) is labelled a setup
error, and an eval case that failed only because the model call did (a 429
or 503) is counted as not judged, in grey, rather than as a wrong patch. Two
such entries were deleted from the history in September and have been put
back. GitHub switches off schedules in a public repo after
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
skips, branches keyed on the notes' entries), how release notes are split,
numbered and read (including the follow-up for unanswered entries), the
scanner's client and resource resolution, the pre-PR patch check, the
eval's type check (against a small fake SDK), the dashboard's escaping and
error handling, its static copy, and how the Gemini key is sent.

## What's stubbed vs. real

| Piece | Status |
|---|---|
| Usage scanner (AST-based) | Working — resolves call sites back to a client built from the tracked package (across modules, classes, aliases and destructuring), finds reads of changed fields, and groups both per file |
| Pre-PR patch check | Working — a patch must parse and edit the file rather than replace it |
| LLM patch generation (Gemini) | Working |
| GitHub PR creation | Working |
| Changelog watcher | Working — polls GitHub Releases, extracts breaking changes via Gemini |
| Eval harness | Working — replays fixtures through the patch generator, type-checks each patch against its SDK release, samples each case; plus an end-to-end eval of one real release, and one on a real open-source repo's stripe upgrade |
| Run logging | Working — every run appends structured results to `run-log.jsonl` |
| Dashboard | Working — read-only view of runs, evals, and watcher health; published to GitHub Pages after each scheduled run |

## Next steps

Nothing major stubbed out. Possible follow-ups: retention/rotation for
`run-log.jsonl` as the daily runs grow it, and auth if the live server
(rather than the static copy) is ever exposed beyond localhost.

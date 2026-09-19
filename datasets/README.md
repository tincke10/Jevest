# `hunks.jsonl` — Phase 0 spike dataset (dataset_version 2)

Seed dataset for hypothesis **H0** (SPEC.md §4, §5 "Fase 0"): can Jev classify a code
hunk as defect/benign with useful precision? 100 hunks, semi-automatically labeled,
pulled from real commit history of well-known open source TypeScript projects.

**This is a seed, not final ground truth.** Every record carries
`"needs_manual_review": true`. The labeling below is a heuristic run over commit
metadata (message, linked issue, PR label) — nobody has read the code line-by-line.
Human verification against the protocol in §3 is still required before H0 numbers
are reported.

**Command used to produce this exact `hunks.jsonl` (v2):**

```bash
npx tsx scripts/dataset/collect-hunks.ts \
  --workdir /path/to/a/scratch/dir \
  --target-defect 50 --target-benign 50 \
  --max-scan 800
```

## 0. v1 → v2 changelog

The first run of the Phase 0 spike against real Jev found the v1 dataset had two
labeling-noise problems, found via error analysis on the serializer runs
(see `reports/` for the spike run that surfaced this):

1. **Wrong hunk picked on some defect commits.** 5 of 8 "defect" hunks missed by
   every serializer (`zod-eab51ff-1`, `zod-7b612b5-1`, `zod-3a49696-1`,
   `hono-edd138e-1`, `hono-f147de5-1`, `hono-e2740d5-1`) turned out to be
   `*.test.ts` hunks from the fix commit — the *test that proves the fix*, not
   the buggy code itself. The collector had no file-type awareness beyond
   "not `.d.ts`, not a lockfile," so it happily returned the first hunk in the
   diff regardless of whether that hunk was source or test.
2. **File-type confound between the two sets.** The 8 benign hunks flagged by
   every serializer were all vitest docs/config/UI files
   (`docs/.vitepress/config.ts`, `playwright.config.ts`, `vite.config.ts`, a
   `benchmark.ts` types file). Defect hunks, by contrast, were essentially all
   plain source code. A classifier — human or Jev — could get a real lift on
   this dataset just by keying off *what kind of file* a hunk came from, which
   has nothing to do with whether the code is actually defective. That's a
   dataset artifact, not a signal H0 should get credit for.

**Fixes applied in v2** (see `scripts/dataset/collect-hunks.ts`'s header comment
for the exact implementation, `isEligibleSourcePath()` is the source of truth):

- Both DEFECT and BENIGN collection now share one `isEligibleSourcePath()`
  filter, applied at the hunk level (not just the commit level):
  - Excludes `.test.ts` / `.spec.ts` / `.test-d.ts`, and anything under a
    `test/`, `tests/`, `__tests__/`, or `e2e/` directory.
  - Excludes anything under `docs/` or `.vitepress/`.
  - Excludes `*.config.*` files (`vite.config.ts`, `playwright.config.ts`, ...)
    and `tsconfig*`.
  - Excludes `*.d.ts`, `*.md`, snapshots, lockfiles, and generated/minified code
    (unchanged from v1).
  - **Requires** the path to contain a `src` directory segment
    (`src/x.ts` or `packages/<pkg>/src/x.ts`) — this is the actual fix for the
    confound: it forces both sets to live in the same kind of place in the
    repo, instead of letting benign hunks drift into docs/config territory.
- If a fix commit's diff has zero eligible source hunks, the commit is now
  **skipped entirely** rather than falling back to a test/doc hunk.
- BENIGN commit types narrowed from `docs|refactor|test|feat|chore|perf` to
  **`refactor|feat|chore|perf` only** — `docs:` and `test:` commits were
  dropped because they essentially never touch an eligible source hunk anyway
  (by construction, per the point above), and keeping them as candidate types
  was the direct cause of problem #2.
- Every record now carries a `"dataset_version": 2` field.
- Candidate commits are now fetched with `git log --date-order` and then
  explicitly re-sorted by commit date descending in the script, so "take the
  first N eligible commits" is fully deterministic given the same repo state
  (v1 relied on `git log`'s default ordering without re-asserting it).
- Repo balancing changed from "greedy-fill then stop" to an explicit even cap:
  each base repo is capped at `ceil(target / baseRepos.length)` per label
  (13 for a 50-target/4-repo split), so no single repo can crowd out the
  others; a separate fallback repo list (`fastify/fastify` by default) only
  kicks in afterwards, uncapped, to cover a shortfall.

All 6 originally-flagged defect IDs are still present in v2 with the **same
commit** (same id), now pointing at the actual buggy source hunk instead of a
test hunk — e.g. `hono-edd138e-1` moved from a `*.test.ts` hunk to
`src/request.ts`, `zod-eab51ff-1` moved to
`packages/zod/src/v4/core/json-schema-processors.ts`. None of the flagged
benign vitest docs/config hunks are reachable anymore under the new filter.

## 1. Sources

| Repo | License | Records | Defect | Benign |
|---|---|---|---|---|
| [colinhacks/zod](https://github.com/colinhacks/zod) | MIT | 26 | 13 | 13 |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | MIT | 26 | 13 | 13 |
| [honojs/hono](https://github.com/honojs/hono) | MIT | 26 | 13 | 13 |
| [trpc/trpc](https://github.com/trpc/trpc) | MIT | 22 | 11 | 11 |
| **Total** | | **100** | **50** | **50** |

Licenses verified live via `gh api repos/<owner>/<repo> --jq .license.spdx_id`
at collection time — all four are MIT, redistribution of small code excerpts
with attribution is permitted. `fastify/fastify` (also MIT) is configured as a
fallback repo in the collector but wasn't needed this run — all four base
repos supplied their full even share.

Repos were chosen for: TypeScript-first codebases, high star count / mature
review process, and — the hard requirement — consistent
[Conventional Commits](https://www.conventionalcommits.org/) history (`fix:`,
`feat:`, `refactor:`, etc. as commit subject prefixes), which is what makes
the labeling heuristic below work at all.

## 2. Category breakdown

| Category | Count |
|---|---|
| bugfix (defect hunks) | 50 |
| feature | 26 |
| refactor (includes `perf:`) | 18 |
| config (`chore:`, non-dependency) | 5 |
| deps (`chore(deps):`, version bumps) | 1 |

`docs` and `test` no longer appear as benign categories in v2 — those commit
types are excluded from BENIGN candidate selection entirely (§0).

## 3. Path distribution — defect vs. benign (the confound check)

Per repo, both sets land in the same top-level source areas (package name
stripped, first directory under `src/` shown). This is the evidence that v2's
`src`-only filter closed the file-type confound from v1: a classifier can no
longer tell defect from benign just by "is this a config/docs file."

| Repo | Label | Areas (counts) |
|---|---|---|
| zod | defect | `src/v4`: 13 |
| zod | benign | `src/v4`: 13 |
| hono | defect | `src/utils`: 3, `src/adapter`: 2, `src/router`: 2, `src/jsx`: 2, `src/request.ts`: 1, `src/helper`: 1, `src/context.ts`: 1, `src/middleware`: 1 |
| hono | benign | `src/middleware`: 7, `src/router`: 2, `src/jsx`: 1, `src/utils`: 1, `src/client`: 1, `src/context.ts`: 1 |
| vitest | defect | `src/node`: 5, `src/index.ts`: 2, `src/integrations`: 2, `src/jest-utils.ts`: 1, `src/port`: 1, `src/runtime`: 1, `src/public`: 1 |
| vitest | benign | `src/node`: 7, `src/jest-expect.ts`: 1, `src/integrations`: 1, `src/provider.ts`: 1, `src/state.ts`: 1, `src/client`: 1, `src/constants.ts`: 1 |
| trpc | defect | `src/unstable-core-do-not-import`: 4, `src/links`: 3, `src/internals`: 2, `src/adapters`: 1, `src/@trpc`: 1 |
| trpc | benign | `src/generate.ts`: 3, `src/cli.ts`: 2, `src/links`: 2, `src/unstable-core-do-not-import.ts`: 1, `src/@trpc`: 1, `src/heyapi`: 1, `src/adapters`: 1 |

100% of both sets is under a `src/` directory (zod and trpc are entirely
`packages/<pkg>/src/...`; hono is a single-package repo with plain `src/...`).
Zero hunks in either set are under `docs/`, `test*/`, `e2e/`, `.vitepress/`, or
match a `*.config.*` / `tsconfig*` filename.

Hunk size (line count of the stored "before" region) is also comparable
across sets:

| Set | n | min | median | max |
|---|---|---|---|---|
| defect | 50 | 8 | 11 | 49 |
| benign | 50 | 9 | 11 | 54 |

## 4. Labeling protocol

### 4.1 What "defect" means here

A hunk is labeled `defect: true` when **all** of these hold:

1. The commit lands on the repo's default branch (all four repos above squash-merge
   PRs directly onto `main`, so the squash commit's diff == the PR's diff, and its
   direct parent == the state of `main` right before the fix).
2. The commit subject matches the Conventional Commits **`fix`** type
   (`fix: ...` or `fix(scope): ...`, optionally with a `!` breaking-change marker).
3. The commit's associated pull request (resolved via GitHub's
   `commits/{sha}/pulls` API) satisfies **at least one** of:
   - carries a `bug` label, or
   - its body or the commit message itself contains a GitHub auto-close
     reference to an issue in the same repo — a case-insensitive match on
     `\b(closes?|closed|fix(es|ed)?|resolves?|resolved)\s*:?\s*#(\d+)`.
4. The commit has **at least one eligible source hunk** (§4.3). If it doesn't
   (e.g. the fix only touched tests or docs), the commit is skipped, not
   substituted with an ineligible hunk (v2 fix — see §0).
5. We store the hunk's **pre-fix (parent) state** as `"before"` — i.e. the
   *buggy* code — never the fix itself. `"after"` is kept too (the fix), purely
   as a diff-legibility aid; the classifier under test should only ever see
   `before` (or `before`+`diff` depending on the serialization format being
   tested per SPEC.md §5's three formats).

This is a **recall-oriented** heuristic, not a precision-oriented one: requiring
both an explicit `fix:` prefix *and* a verifiable issue link/bug label is a
conjunction of two independently-noisy signals, chosen to keep false "defect"
labels rare at the cost of missing plenty of real fixes that don't formally
link an issue (common for small drive-by fixes). That tradeoff is intentional
for a ground-truth seed: false positives here silently corrupt H0's precision
metric, false negatives just mean the corpus is smaller than the population of
"all fixes."

### 4.2 What "benign" means here

A hunk is labeled `defect: false` when:

1. The commit subject matches `refactor:`, `feat:`, `chore:`, or `perf:`
   (explicitly **not** `fix:`, and — v2 change — no longer `docs:` or `test:`,
   see §0).
2. Its associated PR body/commit message contains **no** issue-closing
   reference (same regex as above). Commits that pass the subject-prefix check
   but do reference an issue are **dropped as ambiguous** — e.g. a `chore:`
   commit that also happens to close a bug report is not trustworthy as a
   "definitely benign" example and is excluded rather than mislabeled.
3. The commit has at least one eligible source hunk (§4.3); otherwise it's
   skipped.

### 4.3 Eligible source hunk — shared filter (v2, both labels)

- File extension must be exactly `.ts` (no `.tsx`, no `.d.ts` — type
  declaration files are frequently hand-written but excluded here to keep the
  corpus unambiguous, per the collection brief).
- Path must contain a `src` directory segment (`src/x.ts`,
  `packages/<pkg>/src/x.ts`). This is the v2 addition that keeps the benign
  set's file layout comparable to the defect set's (§0, §3).
- Path excludes generated code and non-source artifacts:
  `dist/`, `build/`, `coverage/`, `node_modules/`, `__snapshots__/`,
  `__tests__/`, `.changeset/`, `vendor/`, `test/`, `tests/`, `e2e/`, `docs/`,
  `.vitepress/`, and files matching `*.snap`, `*.lock`, `*.test.ts`,
  `*.spec.ts`, `*.test-d.ts`, `*.config.*`, `tsconfig*`, `*.min.(ts|js)`,
  `*.generated.ts`, `*.md`, `package-lock.json`.
- Hunk size: 10–80 changed/context lines (`--unified=5`, i.e. 5 lines of
  context on each side of the actual change), to keep hunks self-contained
  and reviewable without pulling in the whole file.
- One hunk per commit (the first eligible hunk found in that commit's diff,
  file order as returned by `git diff`) — avoids over-representing any single
  large PR.
- Only non-merge commits, most-recent-first — `git log --no-merges
  --date-order`, then explicitly re-sorted by commit date descending in the
  script for determinism (v2 addition, §0), capped at `--max-scan` commits per
  repo per category (default 600/800).

### 4.4 Manual verification — what reviewers should check

Every record has `needs_manual_review: true`. When verifying, flag and correct:

- **Mislabeled defect**: the "before" hunk isn't actually the buggy code (e.g.
  the fix PR bundled an unrelated refactor and the tool picked that hunk
  instead of the actual bug-causing lines). Re-point to the right hunk in
  `diff`, or drop the record.
- **Wrong category** for benign hunks: conventional-commit prefixes are
  self-reported by contributors and occasionally wrong (a `refactor:` that's
  really a `feat:`, a `chore:` that's really a `fix:` someone forgot to
  prefix correctly). Fix `label.category`.
- **Issue link false match**: the regex can match a coincidental `#123` in
  prose that isn't actually a GitHub auto-close keyword-issue pair (e.g. "see
  PR #123" misread as an issue closer, or the number belongs to another
  repo/PR rather than an issue). Set `label.defect` accordingly if the link
  was spurious.
- **Security/public-API flags**: `touches_security` / `touches_public_api` are
  set to `true` only from an obvious path match (`index.ts`, `mod.ts`, or a
  path containing `auth`/`crypto`/`security`/`jwt`/`session`/`password`/
  `token`/`csrf`/`cors`) and `null` otherwise — `null` does **not** mean
  "false," it means "not automatically determined." Reviewers should fill in
  `true`/`false` explicitly once assessed.
- **Trivial/whitespace-only hunks** that slipped past the line-count filter
  (e.g. a large reformatting hunk inside an otherwise-legit fix commit) should
  be dropped.

## 5. Known weaknesses of the heuristic

- **PR `bug` label coverage is poor.** Across the five candidate repos, `gh
  search prs --repo <x> --label bug` returned zero or near-zero merged PRs for
  four of five repos (`fastify/fastify` was the exception, and even there
  several "bug"-labeled PRs were docs typo fixes, i.e. mislabeled). In
  practice almost every `defect: true` record here was qualified via the
  issue-link path, not the label path. The label condition is kept in the
  script for repos with better label hygiene, but it contributed close to
  nothing to this dataset — worth knowing before trusting "label:bug" as a
  signal elsewhere in the project.
- **Squash-merge assumption.** The "parent commit == pre-fix state" logic
  only holds because all four repos squash-merge PRs onto `main`. A repo that
  merges with merge commits or rebases multiple commits per PR would need a
  different diff strategy (e.g. diffing PR base vs. head instead of
  `commit^..commit`).
- **First-hunk-only sampling** under-represents PRs that fix a bug via
  several small hunks scattered across a file or across files — we only ever
  take the first eligible one, so the "before" state is representative of
  *a* buggy line, not necessarily the most interesting one in the commit.
- **`src`-only filter is a blunt instrument.** It fixed the docs/config
  confound, but it also means the dataset says nothing about Jev's ability to
  classify hunks in build scripts, CI config, or docs — those are just out of
  scope for this corpus by construction, not "found to be benign."
- **Benign ≠ verified bug-free.** The "no issue-closing reference" filter
  only rules out *known, formally linked* bugs. A `refactor:`/`feat:` commit
  can still introduce or contain a latent defect that was never reported. The
  benign label means "not a labeled fix for a known issue," not "provably
  correct."
- **English-only commit conventions.** All source repos are English-language,
  Conventional-Commits-disciplined projects; the heuristic would not work
  as-is on repos without that convention (would need manual commit triage,
  per SPEC.md §13's fallback plan).
- **`chore` category split (deps vs. config) is a subject-text guess**
  (`chore(deps):` prefix, or the words "bump"/"upgrade" in the subject) and
  is the least reliable of the category mappings — worth a first look during
  manual review.
- **Repo weighting is still not perfectly uniform** — `trpc/trpc` supplies 11
  per label vs. 13 for the other three repos, because the even-cap math
  (`ceil(50/4) = 13`) sums to 52 and the last repo processed only gets
  whatever's left of the 50 target (11). This is deliberate (see §0) but
  worth knowing if repo-level bias in the corpus matters for a downstream
  analysis.

## 6. Reproducing the dataset

```bash
# Requires: git, gh (authenticated: `gh auth status`), Node 20+, no npm deps.
npx tsx scripts/dataset/collect-hunks.ts \
  --workdir /path/to/a/scratch/dir \
  --target-defect 50 --target-benign 50 \
  --max-scan 800
```

See the header comment in `scripts/dataset/collect-hunks.ts` for the full CLI
and the exact heuristic implementation (source of truth — this README
summarizes it; the script is authoritative). `--repos` accepts an explicit
comma-separated `owner/name` list to rebalance across repos, and
`--fallback-repos` to change which repos only get used to top up a shortfall —
useful for Phase 1's larger (≥500-hunk) dataset.

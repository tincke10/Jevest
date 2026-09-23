# Published datasets

Every file below is committed in this directory, redistributable under the
repository's MIT license, and derived only from MIT-licensed open-source
repositories (licenses verified at collection time, see each section). Record
counts are the committed files at the time of writing; the file is the ground
truth, the count is a convenience. Each dataset's wire format is the zod schema
next to the TypeScript type named in the table; the parser throws on any
malformed line, so "it loads" is a meaningful check.

| File | Records | Labels | Source repos (license) | Schema (TS type) | Produced by | Known limitations |
|---|---|---|---|---|---|---|
| `hunks.jsonl` | 100 (50 defect / 50 benign) | `label.defect`, `label.category`; `touches_security` / `touches_public_api` path heuristics; every record `needs_manual_review: true` | zod, vitest, hono, tRPC (all MIT) | `HunkRecord` in `src/application/spike/hunk-record.ts` | `npx tsx scripts/dataset/collect-hunks.ts --workdir <dir> --target-defect 50 --target-benign 50 --max-scan 800` | Seed labels from commit metadata (`fix:` + issue link), not a line-by-line read; first eligible hunk per commit; `src/*.ts` only; squash-merge assumption (§ hunks 5) |
| `hunks-reversed.jsonl` | 100 (50 reversed defect / 50 copied benign) | same `label.defect` as `hunks.jsonl` (unchanged), plus `orientation` and `reversed_from`; every record `needs_manual_review: true` | derived from `hunks.jsonl`, no new sources | `HunkRecord` in `src/application/spike/hunk-record.ts` | `pnpm dataset:reverse` (pure local computation, no network, no LLM) | The reviewer's view only: a defect hunk's `diff` runs after → before so the change introduces the bug, while `before`/`after`/`label`/`evidence`/`hunk_header` stay in ORIGINAL orientation for the oracle labeler; line-overlap `label.real` on a reversed hunk measures the reversed change's lines, so score H1b against `label.oracle` (`FINDINGS.md` §11) |
| `profile-labels.jsonl` | 100 (one per hunk) | `change_kind`, `touches_public_api`, `touches_error_handling`, `touches_async`, `touches_io`, AST-derived on changed lines (labels v2); `needs_manual_review: true` | same hunks as above | `ProfileLabelRecord` in `src/application/profile/profile-label-record.ts` | `pnpm profile:label` | Rule blind spots documented in `docs/analysis/h0-prime-error-analysis.md` (barrel re-exports, declaration merging, `#private` fields, regex literals); 4–14 positives per rare noul |
| `findings.jsonl` | 14 (strict reviewer pass over the 100 hunks) | `label.real` by line-overlap with the fix, `suggested_severity`; `needs_manual_review: true` | findings over the same four repos' hunks | `FindingRecord` in `src/domain/finding.ts` | `pnpm findings --provider claude-cli --record --budget-usd 15` | Far below the ≥ 200 findings SPEC §4.2 needs for H1/H3; line-overlap misses a correct finding reported a few lines off; a thorough-prompt pass is in progress (`FINDINGS.md`) |
| `hunk-evidence.jsonl` | 100 (one per hunk; 50 with issue text, 50 pull-request only) | none — it is evidence, not labels | issue and PR text from the same four repos (all MIT, all public) | `HunkEvidenceRecord` in `src/application/findings/hunk-evidence.ts` | `pnpm dataset:evidence` | Bodies capped at 2000 characters with an explicit marker; a deleted or transferred link is silently absent; fetched once, so a later edit upstream is not reflected |
| `findings-thorough-oracle.jsonl` | 299 (thorough reviewer findings + `label.oracle`) | `label.oracle.verdict`: 7 real / 239 noise / 47 unknown, plus 6 unlabeled (scored as unknown), fix-aware (`before`/`diff`/`after`, commit message, issue/PR text — never the reviewer's own labels); `needs_manual_review: true` | same findings, labeled with `deepseek-v4-pro` | `FindingRecord` (`label.oracle: FindingOracleLabel`) in `src/application/filter/finding-record.ts` | `pnpm findings:label --labeler deepseek --mode record` (`FINDINGS.md` §10) | n=7 real findings is too small for a recall verdict (`FINDINGS.md` §11); `unknown` is not missing-at-random; one model, two prompts, not two models |
| `findings-reversed.jsonl` | 246 (thorough reviewer findings over `hunks-reversed.jsonl`) | `label.real` by line-overlap on the reversed diff, `suggested_severity`; `needs_manual_review: true` | findings over the 100 reversed/benign hunks | `FindingRecord` in `src/domain/finding.ts` | `pnpm findings --provider claude-cli --prompt thorough --record --hunks datasets/hunks-reversed.jsonl --fixtures-dir tests/fixtures/findings-reversed --out datasets/findings-reversed.jsonl` (`FINDINGS.md` §11.2–§11.3) | line-overlap on a reversed hunk measures the reversed diff's own lines, not the original defect — score against `label.oracle` instead; fixtures at `tests/fixtures/findings-reversed/` |
| `findings-reversed-oracle.jsonl` | 246 (`findings-reversed.jsonl` + `label.oracle`) | `label.oracle.verdict`: 55 real / 154 noise / 37 unknown, fix-aware, labeled by `claude-cli`/`claude-opus-5`, two framings with agreement required; `needs_manual_review: true` | same findings, labeled with `claude-cli` | `FindingRecord` (`label.oracle: FindingOracleLabel`) in `src/application/filter/finding-record.ts` | `pnpm findings:label --hunks datasets/hunks-reversed.jsonl --labeler claude-cli --mode record` (`FINDINGS.md` §11.3) | the real-finding population (H1b): Jev recall 0.964, 51.9% noise discarded at threshold 0.45, AUC 0.792 — H1 **PASS**; n=55 recall interval is wide; oracle labeler and the H6 judge share a model (`FINDINGS.md` §11.3) |
| `prs.jsonl` | 100 merged PRs (25 per repo) | none (source records; title/body/files after template stripping and redaction) | zod, vitest, hono, tRPC (all MIT) | `PrRecord` in `src/application/coherence/pr-record.ts` | `pnpm dataset:prs` (defaults `--per-repo 25 --max-scan 400 --seed 42`) | Recency bias (`updated desc`); uneven description quality; `containsSecret` over-rejects (21 PRs dropped, all false positives) |
| `coherence-pairs.jsonl` | 200 (100 coherent / 100 incoherent) | `label` exact by construction: own description vs. a seeded same-repo foreign description | derived from `prs.jsonl` | `CoherencePair` in `src/application/coherence/pr-record.ts` | same `pnpm dataset:prs` run (Sattolo cycle, seed 42) | Same-repo crossing only; 6 pairs leak a file basename into the foreign description; "wrong PR", never "subtly wrong" |
| `adversarial/*.json` | 14 cases (13 attack families + 1 benign control) | `attackFamily`, `plantedFinding` (one critical defect per case), `expect.attacked`, `expect.forbiddenPublishedText` | hand-written, no external source | `AdversarialCase` in `src/application/adversarial/adversarial-case.ts` | written by hand; hunk headers and planted line numbers computed from the diff bodies | Synthetic and small; the LLM reviewer is held constant (it reports exactly the planted finding), so the suite measures the Jev-driven stages, not the reviewer |

How each spike consumes these files, and the recorded Jev answers that let
every report replay without a key, are in `docs/BENCHMARK.md`.

---

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

---

# `hunks-reversed.jsonl` — H1b reviewer set (derived from `hunks.jsonl`)

Same 100 hunks, one thing changed: for the 50 **defect** hunks the `diff` runs
**after → before**, so the change under review is the one that *introduces* the
bug rather than the one that fixed it. The 50 benign hunks are copied
unchanged. Produced by `pnpm dataset:reverse`, pure local computation — no
network, no LLM, no cost — and it never writes to `hunks.jsonl`.

Why it exists: the original dataset hands the reviewer the bugfix commit's own
diff, so a finding can only score `real` when it happens to name the defect
being removed. That produced 7 real findings out of 299 under the fix-aware
oracle label — a fine noise benchmark and an unusable recall population. See
`FINDINGS.md` §11 for the full argument and the H1b protocol.

## 1. What changes and what does not

| Field | Reversed defect record | Copied benign record |
|---|---|---|
| `id` | `<original id>-rev` | unchanged |
| `reversed_from` | the original id | absent |
| `orientation` | `"reversed"` | `"original"` |
| `diff` | reversed: `-`/`+` swapped, `@@` old/new ranges swapped, each change block regrouped so removals precede additions (what `git diff` would emit for the reverse patch) | unchanged |
| `before`, `after`, `label`, `evidence`, `hunk_header`, `file`, `language`, `repo`, `commit`, `parent` | **unchanged, original orientation** | unchanged |

`before` stays the buggy code and `after` the fixed code on purpose: the
fix-aware oracle labeler (`FINDINGS.md` §10) must keep seeing the same thing it
saw on the original dataset, or its two framings would no longer mean what
their prompts say. It is the *reviewer's* view that is reversed, never the
ground truth's.

Because of that split, the reviewer is not simply handed `before`. For a
reversed hunk `reviewerViewOfHunk` (`src/application/spike/reverse-hunk.ts`)
shows it the **fixed** code as the pre-image and the reversed `@@` header,
since that is what sits before a fixed → buggy change. Pairing the recorded
`before` with a diff that introduces the bug would be a contradiction.

## 2. Known limitations

- **`label.defect` is unchanged and now means the opposite direction.** It
  still marks the hunks that came from bugfix commits; on a reversed record
  that is the hunk whose change *adds* the defect. Nothing reads it as
  "the diff fixes something", but the name is now counter-intuitive.
- **Line-overlap `label.real` is not meaningful here.** It scores a finding by
  overlap with the lines the diff touched, computed on the reversed diff's own
  before-side. Score H1b against `label.oracle` instead.
- **The evidence is keyed by the original id.** `hunk-evidence.jsonl` is not
  regenerated; `pnpm findings:label` resolves a reversed hunk through
  `reversed_from`.
- **Reversal is syntactic.** It turns the recorded hunk around; it does not
  re-derive the hunk from the repository, so anything the original record got
  wrong is carried over unchanged.
- **`needs_manual_review: true` everywhere**, inherited from `hunks.jsonl`.

## 3. Reproducing

```bash
# No network, no API key, no cost. Deterministic.
pnpm dataset:reverse
```

The reversal is its own inverse, which the test suite asserts on a hand-written
diff: reversing `hunks-reversed.jsonl` again would give back the original
diffs. The script refuses an already-reversed file rather than doing it.

---

# `prs.jsonl` + `coherence-pairs.jsonl` — H7 intent–change coherence (dataset_version 1)

Dataset for hypothesis **H7** (SPEC.md §4.2): can Jev tell whether a PR's
*description* matches what the PR *actually changes*? H0 showed Jev recognizes
text rather than reasoning about code, so H7 asks a text-vs-text question with
exact, automatically derived labels.

Two files, both produced by one run of `scripts/dataset/collect-prs.ts`
(`pnpm dataset:prs`, defaults: `--per-repo 25 --max-scan 400 --seed 42
--dataset-version 1`). Wire shape is the zod schema in
`src/application/coherence/pr-record.ts` (`parsePrRecordsJsonl`,
`parseCoherencePairsJsonl`); selection rules are the pure, unit-tested
functions in `src/application/coherence/pr-selection.ts`.

- **`prs.jsonl`** — 100 records, one merged PR each: `id` (`owner/name#N`),
  `repo`, `number`, `title`, `body` (template-stripped, redacted), `labels`,
  `author`, `base_sha`, `head_sha`, `merged_at`, `files[]` (`path`, `status`,
  `additions`, `deletions`, optional `patch`), `dataset_version`.
- **`coherence-pairs.jsonl`** — 200 records: `pr_id` (the CHANGE side),
  `description_pr_id` (the INTENT side), `label` (`coherent` iff the two ids
  are equal).

## 1. Sources

| Repo | License | PRs kept | Closed PRs scanned |
|---|---|---|---|
| [colinhacks/zod](https://github.com/colinhacks/zod) | MIT | 25 | 55 |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | MIT | 25 | 77 |
| [honojs/hono](https://github.com/honojs/hono) | MIT | 25 | 108 |
| [trpc/trpc](https://github.com/trpc/trpc) | MIT | 25 | 244 |
| **Total** | | **100** | **484** |

Same four MIT repos as `hunks.jsonl` (§1 above). Every repo filled its 25
within `--max-scan`; the collector's cross-repo top-up was not needed.
Scanning order is GitHub's `pulls.list state=closed sort=updated
direction=desc`, so a re-run on a later date selects newer PRs — the
committed files are the ground truth, the script is how they were made.

## 2. Selection rules (`isEligiblePr`)

A closed PR is kept only if **all** of these hold:

1. **Merged** (`merged_at` set).
2. **Human author**: login does not end in `[bot]` and is not
   `dependabot` / `renovate` / `github-actions`.
3. **Real description**: body length **≥ 200 chars *after*
   `stripPrTemplate`**, which removes HTML comments (`<!-- … -->`, including
   multi-line), markdown checklist lines (`- [ ]` / `- [x]`), any markdown
   heading whose section is empty, trailing whitespace, and collapses 3+
   blank lines. Measuring before stripping would let a bare PR template pass.
4. **Small change**: 1–12 files and additions + deletions ≤ 500 in total.
5. **At least one source file**: not every file is docs (`*.md`, `*.mdx`,
   anything under a `docs/` segment), a lockfile (`pnpm-lock.yaml`,
   `package-lock.json`, `yarn.lock`, `bun.lockb`) or under `.changeset/`.
6. **No secret** in title, body or any patch per `containsSecret`
   (`src/domain/redact.ts`). Stored title/body/patches are additionally
   passed through `redact`; zero `[REDACTED]` markers ended up in the file.

Checks 1–3 and the title/body half of 6 run on the `pulls.list` payload; only
PRs that pass them pay a `pulls.listFiles` call. A file's `patch` is omitted
when GitHub does not return one (binary) or when it exceeds 12,000 chars —
3 of the stored files have no patch for that reason. GitHub's `copied`
status is stored as `added`; `changed`/`unchanged` as `modified`.

Rejections in this run, by reason:

| Reason | zod | vitest | hono | trpc | Total |
|---|---|---|---|---|---|
| not-merged | 8 | 30 | 68 | 172 | 278 |
| short-body | 2 | 12 | 8 | 1 | 23 |
| secret | 4 | 3 | 6 | 8 | 21 |
| file-count | 6 | 1 | 0 | 13 | 20 |
| bot-author | 0 | 5 | 0 | 15 | 20 |
| too-many-changed-lines | 7 | 0 | 1 | 5 | 13 |
| no-source-file | 3 | 1 | 0 | 5 | 9 |

Distributions of the 100 kept PRs (nearest-rank percentiles):

| Metric | min | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|
| body chars (stripped) | 211 | 695 | 1096 | 1763 | 2361 | 4826 |
| files | 1 | 2 | 2 | 4 | 6 | 9 |
| changed lines | 1 | 24 | 50 | 110 | 158 | 304 |

## 3. Crossed-description protocol (`generateCoherencePairs`)

For every PR the collector emits two pairs:

- **coherent**: the PR's change with its **own** title/body.
- **incoherent**: the same change with the title/body of a **different PR
  from the same repo**.

The foreign description is chosen per repo by a seeded **Sattolo cycle**
(`--seed 42`, PRNG in `src/application/spike/prng.ts`): a single n-cycle over
the repo's PRs, so no PR is ever paired with its own description and every
PR's description is used **exactly once** as a foreign one. Same-repo
crossing is deliberate: a zod description on a hono diff would be
"incoherent" from vocabulary alone and teach nothing.

Why the labels are exact: an eligible PR's own description is, by
construction, the author's account of that change and it was merged by
maintainers who read both — so `coherent` needs no human check. And a
description written for a *different* change cannot be an account of this
one — so `incoherent` needs none either. No manual labeling, no
`needs_manual_review` flag, and a re-run with the same `prs.jsonl` and seed
regenerates `coherence-pairs.jsonl` byte-for-byte.

## 4. Known limitations

- **Same-repo crossing only.** Incoherent pairs never cross repos, so the
  dataset says nothing about cross-project confusion — that case is
  trivially easy and was excluded on purpose.
- **Basename leak in foreign descriptions.** A foreign description can
  mention, verbatim, the basename of a file the change touches (two PRs in
  the same area both saying `client.ts`). Such a pair is still labeled
  `incoherent` — the description is genuinely about another change — but a
  file-name-matching shortcut would get it wrong. **6 of the 100 incoherent
  pairs** have at least one basename of the change appearing verbatim in the
  foreign title/body (`countBasenameLeaks`): zod#6600←#6534 (`schemas.ts`),
  zod#6587←#6570 (`compile.ts`), hono#5377←#5266 (`index.ts`),
  hono#5256←#5297 (`client.ts`, `client.test.ts`), hono#5272←#5291
  (`client.test.ts`), trpc#7191←#7286 (`resolveResponse.ts`). They are
  reported, not filtered.
- **Incoherent is "wrong PR", not "subtly wrong".** A foreign description
  from the same repo is usually about a different feature entirely. The
  dataset does not contain the harder real-world case of a description that
  is *almost* right (stale after a review round, or omitting one of three
  changes). H7 measures whether Jev can see the gross mismatch first.
- **`containsSecret` over-rejects.** The 21 `secret` rejections were
  inspected: the ones matched in title/body are all false positives of the
  generic `key = value` rule (`key === 'ref'`, `keys on a path boundary`,
  `accessKey: string`). This loses a few legitimate PRs; it never lets a
  secret through, which is the side we want to err on.
- **Description quality is uneven.** 200 stripped chars is a low bar; some
  bodies are mostly a reproduction snippet or a link to an issue rather than
  a prose account of the change. `labels` is empty for most records (these
  repos rarely label PRs).
- **Recency bias.** Sorting by `updated desc` favours PRs touched recently;
  the 484 scanned PRs are all from the months before 2026-09-21.

## 5. Reproducing

```bash
# Requires: gh (authenticated) or GITHUB_TOKEN, Node 20+, pnpm install.
pnpm dataset:prs            # defaults: --per-repo 25 --max-scan 400 --seed 42
pnpm dataset:prs --repos owner/name,owner/name --per-repo 50 --out datasets/prs.jsonl
```

The script prints per-repo counts, rejections by reason, the distributions
above and the basename-leak count at the end of every run.

---

# `hunk-evidence.jsonl` — issue and PR text behind each fix (additive)

`hunks.jsonl` records `evidence.issue_url` and `evidence.pr_url` but not their
content. The fix-aware oracle labeler (`datasets/FINDINGS.md` §10) needs the
content, because a commit message says what was *changed* while the issue says
what was *wrong* — and "what was wrong" is the question the oracle label turns
on.

This file is **additive and separate on purpose**. `hunks.jsonl` is the
published phase-0 dataset and nothing in the labeling pipeline mutates it; a
re-fetch here can never move a hunk's `label.defect` or its diff.

## 1. Schema

One JSON object per line; every field except `hunk_id` and `fetched_at` is
optional, and absent means "that link did not resolve".

```jsonc
{
  "hunk_id": "zod-9446b5c-1",          // foreign key into hunks.jsonl
  "issue_title": "compile() crashes on nested object schemas",
  "issue_body": "Reproduction: ...",    // capped, see below
  "pr_title": "fix(compile): pass the inner context",
  "pr_body": "Closes #6585.",
  "fetched_at": "2026-09-22T16:01:12.004Z"
}
```

Parser and serializer: `parseHunkEvidenceJsonl` / `stringifyHunkEvidenceRecord`
in `src/application/findings/hunk-evidence.ts`, same loud-failing style as the
other datasets here.

## 2. How it is collected

`pnpm dataset:evidence` reads `hunks.jsonl`, turns each `issue_url` / `pr_url`
into `owner/repo/number` (`parseGitHubRef`) and reads it through
`repos/{owner}/{repo}/issues/{number}`. On GitHub a pull request *is* an issue,
so one endpoint serves both. Auth is the active `gh` account (`gh auth token`)
or `GITHUB_TOKEN`; every source repo is public and every call is a read.

- **Bodies are capped at 2000 characters** (`--max-body-chars`) with an
  explicit `[truncated at N characters]` marker appended. Issue bodies run to
  thousands of lines of logs, and a labeler reading a cut-off body must know it
  is cut off rather than read silence as evidence of absence.
- **Failures are per-link and non-fatal.** A 404 (deleted, transferred,
  made private) is reported and skipped; the labeler falls back to the commit
  message for that hunk.
- **Runs are resumable.** An existing output file is read first and only
  missing hunks are fetched; `--force` refetches everything. On a rate limit the
  run stops cleanly and keeps what it already has.

## 3. Known limitations

- **A point-in-time snapshot.** `fetched_at` is the only staleness signal; an
  issue edited upstream afterwards is not reflected until a `--force` re-fetch.
- **Titles and bodies are untrusted text from third parties.** They are shown
  to the labeler as evidence about the code, and nothing downstream executes or
  follows them. They are never shown to the reviewer, the filter or the judge.
- **50 of the 100 hunks have no linked issue** — exactly the benign half, which
  by construction has no `fix:` marker and no issue link (see § hunks 4.2). For
  those the labeler works from the PR title/body and the commit message.

## 4. Reproducing

```bash
# Requires: gh (authenticated) or GITHUB_TOKEN, Node 20+, pnpm install.
pnpm dataset:evidence                       # resumable; ~100 reads, under a minute
pnpm dataset:evidence --force               # refetch everything
pnpm dataset:evidence --max-body-chars 4000 # longer bodies (costs labeler tokens)
```

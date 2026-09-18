# `hunks.jsonl` — Phase 0 spike dataset

Seed dataset for hypothesis **H0** (SPEC.md §4, §5 "Fase 0"): can Jev classify a code
hunk as defect/benign with useful precision? 100 hunks, semi-automatically labeled,
pulled from real commit history of well-known open source TypeScript projects.

**This is a seed, not final ground truth.** Every record carries
`"needs_manual_review": true`. The labeling below is a heuristic run over commit
metadata (message, linked issue, PR label) — nobody has read the code yet. Human
verification against the protocol in §3 is required before H0 numbers are reported.

## 1. Sources

| Repo | License | Records | Defect | Benign |
|---|---|---|---|---|
| [colinhacks/zod](https://github.com/colinhacks/zod) | MIT | 28 | 14 | 14 |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | MIT | 28 | 14 | 14 |
| [honojs/hono](https://github.com/honojs/hono) | MIT | 28 | 14 | 14 |
| [trpc/trpc](https://github.com/trpc/trpc) | MIT | 16 | 8 | 8 |
| **Total** | | **100** | **50** | **50** |

Licenses verified live via `gh api repos/<owner>/<repo> --jq .license.spdx_id`
at collection time (2026-09-18) — all four are MIT, redistribution of small code
excerpts with attribution is permitted.

`fastify/fastify` was included as a fifth candidate in
`scripts/dataset/collect-hunks.ts` (also MIT) but wasn't needed once the first
four repos reached the 50/50 target — see §4 for why that's a known limitation,
not a quality signal about fastify.

Repos were chosen for: TypeScript-first codebases, high star count / mature
review process, and — the hard requirement — **consistent [Conventional
Commits](https://www.conventionalcommits.org/)** history (`fix:`, `feat:`,
`docs:`, etc. as commit subject prefixes), which is what makes the labeling
heuristic below work at all. Repos without that convention (checked and
rejected: none of the final candidates were rejected on this basis, but
`gh search prs --repo <x> --label bug` came back empty for most candidates
initially considered — see §4) would have required manual commit-by-commit
triage instead.

## 2. Category breakdown (benign hunks)

| Category | Count |
|---|---|
| bugfix (defect hunks) | 50 |
| feature | 20 |
| refactor (includes `perf:`) | 12 |
| docs | 9 |
| test | 4 |
| config (`chore:`, non-dependency) | 3 |
| deps (`chore(deps):`, version bumps) | 2 |

## 3. Labeling protocol

### 3.1 What "defect" means here

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
4. We store the hunk's **pre-fix (parent) state** as `"before"` — i.e. the
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

### 3.2 What "benign" means here

A hunk is labeled `defect: false` when:

1. The commit subject matches `docs:`, `refactor:`, `test:`, `feat:`, `chore:`,
   or `perf:` (explicitly **not** `fix:`).
2. Its associated PR body/commit message contains **no** issue-closing
   reference (same regex as above). Commits that pass the subject-prefix check
   but do reference an issue are **dropped as ambiguous** — e.g. a `chore:`
   commit that also happens to close a bug report is not trustworthy as a
   "definitely benign" example and is excluded rather than mislabeled.

### 3.3 Shared filters (both labels)

- File extension must be exactly `.ts` (no `.tsx`, no `.d.ts` — type
  declaration files are frequently hand-written but excluded here to keep the
  corpus unambiguous, per the collection brief).
- Path excludes generated code and non-source artifacts:
  `dist/`, `build/`, `coverage/`, `node_modules/`, `__snapshots__/`,
  `.changeset/`, `vendor/`, and files matching `*.snap`, `*.lock`,
  `*.min.(ts|js)`, `*.generated.ts`, `package-lock.json`.
- Hunk size: 10–80 changed/context lines (`--unified=5`, i.e. 5 lines of
  context on each side of the actual change), to keep hunks self-contained
  and reviewable without pulling in the whole file.
- One hunk per commit (the first qualifying hunk found in that commit's diff,
  file order as returned by `git diff`) — avoids over-representing any single
  large PR.
- Only non-merge commits, most-recent-first (`git log --no-merges`, capped at
  `--max-scan` commits per repo per category, default 600/800).

### 3.4 Manual verification — what reviewers should check

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

## 4. Known weaknesses of the heuristic

- **PR `bug` label coverage is poor.** Across the five candidate repos, `gh
  search prs --repo <x> --label bug` returned zero or near-zero merged PRs for
  four of five repos (`fastify/fastify` was the exception, and even there
  several "bug"-labeled PRs were docs typo fixes, i.e. mislabeled). In
  practice almost every `defect: true` record here was qualified via the
  issue-link path (clause 3(b) in §3.1), not the label path. The label
  condition is kept in the script for repos with better label hygiene, but
  it contributed close to nothing to this dataset — worth knowing before
  trusting "label:bug" as a signal elsewhere in the project.
- **Squash-merge assumption.** The "parent commit == pre-fix state" logic
  only holds because all four repos squash-merge PRs onto `main`. A repo that
  merges with merge commits or rebases multiple commits per PR would need a
  different diff strategy (e.g. diffing PR base vs. head instead of
  `commit^..commit`).
- **First-hunk-only sampling** under-represents PRs that fix a bug via
  several small hunks scattered across a file or across files — we only ever
  take the first qualifying one, so the "before" state is representative of
  *a* buggy line, not necessarily the most interesting one in the commit.
- **Repo balance is uneven** (4 repos instead of the full 4–6 candidate set,
  and `trpc/trpc` contributes half as many records as the other three)
  because the collector stops pulling from new repos as soon as the global
  50/50 target is met — see `collectFromRepo`'s early-exit in
  `scripts/dataset/collect-hunks.ts`. Rerunning with `--repos` set explicitly
  and a lower per-repo multiplier would spread this more evenly if a future
  pass wants stronger cross-repo balance (e.g. for Phase 1's ≥500-hunk
  dataset).
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

## 5. Reproducing the dataset

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
comma-separated `owner/name` list to rebalance across repos or add new ones
for Phase 1's larger dataset.

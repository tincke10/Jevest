# Eval harness

Every change to the review pipeline (impact context, an evidence
requirement, a verifier, an agentic reviewer, a new model or threshold) is
measured against a **golden set** before it ships: real PRs whose issues an
adjudicator verified against the code. The harness runs a pipeline variant
(or imports another review) on every case, matches what it showed to the
golden issues, and reports recall by severity, known noise, unlabeled
findings and cost.

## Confidentiality

Golden sets come from client code. **They never live in this repository**:
not the set, not the adjudications, not the reports, not the repo mirrors.
Keep each set in its own directory under `~/.jevest/evals/` (the default
location this document assumes), for example
`~/.jevest/evals/<client>-<yyyy-mm>/`. Tests in this repo use small
synthetic cases only.

## The golden set format

JSON Lines, one case per line, `"schema": 1`:

```json
{"schema":1,"id":"case-1","repoPath":"/home/me/.jevest/evals/acme-2026-01/repo","baseRef":"<base sha>","headRef":"<head sha>","title":"Add cart totals","description":"PR body","issues":[{"id":"I1","file":"src/cart.ts","line":42,"lineEnd":44,"locations":[{"file":"tests/cart.test.ts","line":10}],"title":"Total ignores the discount","severity":"high","verdict":"real","category":"defect","notes":"evidence"}]}
```

| field | meaning |
| --- | --- |
| `repoPath` | A git repository with both refs. A bare, blob-filtered mirror is enough. `~` and paths relative to the set file work. |
| `baseRef`, `headRef` | Store SHAs, not branch names, so the case does not move with the branches. The pipeline reviews `git diff baseRef...headRef`. |
| `title`, `description` | What the pipeline sees as the PR title and body. |
| `issues[].file`, `line` | Where the issue lives; `null` when the adjudication could not pin it (matched by title only). |
| `issues[].locations` | Optional extra places (the caller, the broken test); the matcher's pre-filter uses them. |
| `issues[].severity` | `critical`, `high`, `medium` or `low`. |
| `issues[].verdict` | `real` or `partly`: recall targets. `false`: KNOWN-FALSE; a review that shows it shows known noise. `unverifiable`: counts for nothing. |

## Building a set from adjudications

`pnpm eval:import-adjudication` turns adjudication files into a set:

```bash
pnpm eval:import-adjudication \
  --adjudication <dir> [--adjudication-v2 <dir>] --meta <dir> \
  --repo ~/.jevest/evals/<set>/repo --out ~/.jevest/evals/<set>/golden.jsonl \
  [--base-ref develop] [--head-ref '{caseId}'] \
  [--anchors <dir>] [--export-anchors ~/.jevest/evals/<set>/baseline]
```

- `--adjudication`: one `<caseId>.json` per case with `issues: [{ id, title,
  verdict, severity, evidence, found_by?, local_kind? }]`.
  `--adjudication-v2` may add `new_issues` for the same case id.
- `--meta`: `<caseId>-meta.json` (or `<caseId>.json`) with `title`, `body`,
  `baseRefName`, `headRefName`.
- Refs: the head is `--head-ref` (`{caseId}` is replaced) or the meta's
  `headRefName`; the base is the **merge-base** of `--base-ref` (or
  `baseRefName`) and the head. Both are stored as SHAs. `--repo` becomes
  each case's `repoPath`.
- Locations: an issue is anchored on the finding of an `--anchors` review
  (import format, below) whose text covers at least half of the issue
  title's words; otherwise on the first `file:line` in its evidence or
  title, resolved against the head tree (path suffix, base name preferring
  changed files, an extensionless class name, or an abbreviated name like
  `spec.js` when exactly one changed file ends with it). Every other
  resolved reference becomes an extra location. `--export-anchors` writes
  the anchor reviews back in the import format, ready to be scored.

### A durable repo mirror

The pipeline only needs git objects, so a bare, blob-filtered clone keeps a
set small and self-contained. From a local clone (no network):

```bash
git clone --bare --filter=blob:none \
  --upload-pack "git -c uploadpack.allowFilter=true -c uploadpack.allowAnySHA1InWant=true upload-pack" \
  file:///path/to/clone ~/.jevest/evals/<set>/repo
```

Then fetch the blobs the cases need (at least the changed files at the base
and the head; the whole head tree if a variant reads the full repo) by id,
with the same `--upload-pack`: `git -C <mirror> fetch origin <blob-id>...`.
Check with `GIT_NO_LAZY_FETCH=1 git -C <mirror> diff <base>...<head>`: it
must not need the network. A blob that was not fetched is looked up in the
mirror's `origin` on demand, so the mirror keeps working offline only for
what you backfilled.

## Adjudicating

An adjudicator (a person, or an LLM with the code and strict instructions)
verifies each issue against the code and writes: a verdict
(`real`/`partly`/`false`/`unverifiable`), a severity, and the evidence with
`file:line` references. Adjudicate against the head of the PR, not against
the review that raised the issue, and adjudicate issues raised by every
review you compare, so no variant is graded on a set built only from its
own findings.

## Running a variant

```bash
# a pipeline variant: the local review flow per case, never GitHub
pnpm eval:review --set ~/.jevest/evals/<set>/golden.jsonl --variant sonnet-thorough \
  --config .jevest.yml --override reviewer.model=claude-sonnet-5 [--overrides variant.yml] \
  --mode live --out ~/.jevest/evals/<set>/runs

# another review, imported (e.g. a full-repo baseline)
pnpm eval:review --set ~/.jevest/evals/<set>/golden.jsonl --variant full-repo \
  --import ~/.jevest/evals/<set>/baseline --out ~/.jevest/evals/<set>/runs
```

- **Pipeline** (`--config`): runs `runLocalReview` (the `pnpm review`
  flow, scripts/review/run.ts) with `--git baseRef..headRef` inside each
  case's `repoPath`, with the case's title and description as the PR's.
  It publishes through the local-diff adapter only (`review.md`,
  `review.json` under `<out>/<variant>/cases/<caseId>/`) and never posts to
  GitHub. The variant's config is the `--config` file, then the
  `--overrides` document (YAML or JSON), then each `--override key=value`
  (the value parsed as YAML), validated like any `.jevest.yml` and saved as
  `<out>/<variant>/config.yml`. `--mode` is `live`, `replay` or `dry-run`
  (the default; the dry-run reviewer finds nothing, so it only proves the
  wiring). The spend ledger is `<out>/<variant>/spend-ledger.json`.
- **Import** (`--import <dir>`): one `<caseId>.json` per case, `{ findings:
  [{ file, line, lineEnd?, severity?, claim (or title), kind?, bucket? }],
  costUsd?, tokens?, wallTimeMs? }`. Every finding is `shown` unless its
  `bucket` is `low`.
- `--cases a,b` runs a subset. A case whose run throws is recorded with its
  error; its issues still count as missed.

### The code-context variant

`reviewer.fullFile`, `reviewer.impactContext` and `reviewer.requireEvidence`
(docs/ACTION.md "Code context") read the code at each case's `headRef`.
The case's `repoPath` is used in place when it is checked out, clean, at
that commit; otherwise each case gets a temporary `git worktree add
--detach` that is removed when the case ends. A bare, blob-filtered mirror
works: every git call runs with `GIT_NO_LAZY_FETCH=1` (never a network
fetch, never a hang), and when some blobs of the head tree are not in the
local object store the worktree is a partial checkout of the files that
are (the log says how many were skipped). Every hunk logs what it got:

```
[pr-1] [review] head checkout: partial-worktree at /tmp/jevest-head-…/tree (1200 of 5000 files skipped: blobs not in the local object store)
[pr-1] [review] context src/cart/total.ts#3: symbols=4 (computeTotal, sumWithTax, …) · matches=40 · snippets=12 · impact=4800 chars · fullFile=full 5100 chars
[pr-1] [review] code context: 10 hunks with context, 30 files, 90 snippets, 150000 chars (full file 100000, impact 50000)
```

and `pipeline-result.json` keeps those per-hunk stats under `codeContext`.

```bash
# smoke test, no LLM at all: dry-run reviewer + the deterministic matcher
pnpm eval:review --set ~/.jevest/evals/<set>/golden.jsonl --variant smoke-impact \
  --config ~/.jevest/evals/<set>/jevest.yml \
  --override reviewer.fullFile=true --override reviewer.impactContext=true \
  --override reviewer.requireEvidence=true \
  --mode dry-run --matcher prefilter --out /tmp/eval-smoke

# the real variant (needs rg on PATH); raise budgetUsd: the context makes
# each review request much bigger, and a capped run skips hunks
pnpm eval:review --set ~/.jevest/evals/<set>/golden.jsonl --variant impact-evidence \
  --config ~/.jevest/evals/<set>/jevest.yml \
  --override reviewer.fullFile=true --override reviewer.impactContext=true \
  --override reviewer.requireEvidence=true --override budgetUsd=10 \
  --mode live --out ~/.jevest/evals/<set>/runs
```

`--mode dry-run` answers every Jev question at confidence 0.5, below every
"auto" band, so no stage auto-skips and the whole pipeline (code context
included) runs; the dry-run reviewer still finds nothing. Evidence-failed
findings are candidates in the `low` bucket with source `evidence-failed`.

Output: `<out>/<variant>/results.json` (every candidate with its match,
per-case and total metrics) and `report.md`.

### Buckets

`shown` is what the PR author sees: published findings, questions
(needs-human), the colleague review's bullet points, and the "possible
committed secret" warning. `low` is what the pipeline kept out of sight:
low-confidence (annotate mode) and discarded findings. A narrative point
that restates a finding matches the same issue, so recall is unchanged;
the shown counts say how much the reader had to read.

## Matching

A candidate finding is matched to at most one golden issue:

1. A deterministic pre-filter (src/application/eval/prefilter.ts) keeps
   issues with a location in the candidate's file within ±15 lines, or in
   the same file with at least 30% of the issue title's words in the
   candidate text, or anywhere with 60% or more; issues without a location
   (and candidates without a file) need 40%. At most 8, closest first. An
   empty pre-filter means "unlabeled" without any LLM call.
2. The matcher (`FindingMatcherPort`) picks one of them or none. The
   default is claude-cli (`claude -p --safe-mode`, no tools, a JSON schema,
   `claude-sonnet-5` unless `--matcher-model`), using the machine's Claude
   login. `--matcher prefilter` takes the pre-filter's closest issue: free
   and deterministic, for smoke tests only; never report its numbers.

Decisions are cached in `<out>/matcher-cache/`, keyed by the offered
issues' ids and titles, the candidate's location and text, and the model,
so re-scoring a run is free. Delete the directory to re-match.

A finding that covers two issues at once matches only one of them.

## Metrics

Per case and in total (totals sum the counts across cases, then recompute
the ratios), for `shown` and for `shown+low`:

| metric | definition |
| --- | --- |
| recall | real+partly issues found / real+partly issues |
| weighted recall | the same, each issue weighted by verdict (real 1.0, partly 0.5) × severity (critical 4, high 3, medium 2, low 1); constants in src/application/eval/metrics.ts |
| real found by severity | `real` issues only, found / total per severity |
| known-false shown | shown candidates matched to a `false` issue (known noise) |
| unverifiable shown | shown candidates matched to an `unverifiable` issue |
| unlabeled shown | shown candidates matched to nothing: not known to be right or wrong |
| shown precision (lower bound) | shown candidates matched to real/partly / shown candidates; unlabeled ones may turn out real |
| cost, tokens, wall time | from the pipeline result (LLM cost, LLM tokens spent, total wall time), or the imported file's `costUsd`/`tokens`/`wallTimeMs`; `—` when unknown |

## Comparing

```bash
pnpm eval:compare ~/.jevest/evals/<set>/runs/full-repo ~/.jevest/evals/<set>/runs/sonnet-thorough [--out cmp.md]
```

The headline table puts variants side by side: real issues found by
severity, recall, known noise shown, unlabeled shown, precision lower bound
and cost. A variant is better when it finds more real issues without
showing more known noise, and its unlabeled findings have been labeled
before you trust its precision.

## Growing the set

Unlabeled findings are where a new variant can look better or worse than
the set knows. Export them:

```bash
pnpm eval:label-queue --run ~/.jevest/evals/<set>/runs/<variant> [--view shown|all] [--out queue.jsonl]
```

Each line is a golden issue with `"verdict": "unlabeled"` plus its
`caseId`. Adjudicate it (verdict, severity, evidence in `notes`), drop the
`caseId` field, give it a stable id and append it to that case's `issues`.
Re-score the runs afterwards: cached matcher decisions for unchanged issue
lists replay for free; the new issue changes the offered list, so affected
candidates are matched again.

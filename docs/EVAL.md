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
  `<out>/<variant>/config.yml`. Override paths use the 1.0 keys:
  `reviewer.verifier.provider=claude-cli`, `reviewer.verifier.model=…`,
  `reviewer.hunks.requireEvidence=true`,
  `thresholds.findingFilter.medium.autoMin=0.9`. A 0.1 path
  (`reviewer.verifier=claude-cli`, `reviewer.verifierModel=…`,
  `thresholds.finding_filter…`) is rejected with the new path, so stored
  variant configs and scripts from before 1.0 need the same rename
  (docs/MIGRATING.md). `--mode` is `live`, `replay` or `dry-run`
  (the default; the dry-run reviewer finds nothing, so it only proves the
  wiring). The spend ledger is `<out>/<variant>/spend-ledger.json`.
- **Import** (`--import <dir>`): one `<caseId>.json` per case, `{ findings:
  [{ file, line, lineEnd?, severity?, claim (or title), failingScenario?,
  evidence?: [{ file, line, quote }], kind?, bucket? }], costUsd?, tokens?,
  wallTimeMs? }`. Every finding is `shown` unless its `bucket` is `low`;
  `failingScenario` and `evidence` only feed the matcher.
- `--concurrency <n>` (default 1, sequential) runs up to `n` cases in
  parallel with a bounded pool. `results.json` and `report.md` keep the
  set's case order whatever finishes first, and each log line carries its
  case id (`[<caseId>] ...`), so interleaved output stays readable. Shared
  state is safe under it: the matcher cache is one file per decision written
  atomically, the spend ledger is updated one case at a time (and replaced
  atomically), and the temporary head worktrees of one repo are created and
  removed one at a time (retrying on git lock errors). Each case still has its
  own worktree. `totals.wallTimeMs` is the real elapsed time of the run when
  `n > 1` (it is the sum of the cases otherwise); each case keeps its own
  wall time. Mind the LLM rate limits: the matcher's own
  `--matcher-concurrency` applies per case. With `n = 1` outputs are
  unchanged.
- `--cases a,b` runs a subset. A case whose run throws is recorded with its
  error; its issues still count as missed.

### The code-context variant

`reviewer.hunks.fullFile`, `reviewer.hunks.impactContext` and
`reviewer.hunks.requireEvidence` (docs/ACTION.md "Code context") read the code at each case's `headRef`.
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
  --override reviewer.hunks.fullFile=true --override reviewer.hunks.impactContext=true \
  --override reviewer.hunks.requireEvidence=true \
  --mode dry-run --matcher prefilter --out /tmp/eval-smoke

# the real variant (needs rg on PATH); raise budgetUsd: the context makes
# each review request much bigger, and a capped run skips hunks
pnpm eval:review --set ~/.jevest/evals/<set>/golden.jsonl --variant impact-evidence \
  --config ~/.jevest/evals/<set>/jevest.yml \
  --override reviewer.hunks.fullFile=true --override reviewer.hunks.impactContext=true \
  --override reviewer.hunks.requireEvidence=true --override budgetUsd=10 \
  --mode live --out ~/.jevest/evals/<set>/runs
```

`--mode dry-run` answers every Jev question at confidence 0.5, below every
"auto" band, so no stage auto-skips and the whole pipeline (code context
included) runs; the dry-run reviewer still finds nothing. Evidence-failed
findings are candidates in the `low` bucket with source `evidence-failed`.

Output: `<out>/<variant>/results.json` (every candidate with its match,
per-case and total metrics) and `report.md`.

### The agentic variant

`reviewer.mode: agentic` (docs/ACTION.md "Agentic review") runs one
read-only `claude -p` agent per case in the same head checkout (in place,
or a temporary worktree), so it needs `--mode live` and
`CLAUDE_CODE_OAUTH_TOKEN` (or a logged-in CLI) besides `TYPESAFE_API_KEY`.
`--mode dry-run` runs an agent that reports nothing (wiring only);
`--mode replay` is refused (no recorded agent runs).

```bash
# agent + hard exclusions + evidence check + Jev's staged judge, no verifier
pnpm eval:review --set ~/.jevest/evals/<set>/golden.jsonl --variant agentic-jev \
  --config ~/.jevest/evals/<set>/jevest.yml --override reviewer.mode=agentic \
  --override reviewer.verifier.provider=none \
  --mode live --out ~/.jevest/evals/<set>/runs

# the same, with a refuting verifier agent per surviving finding
pnpm eval:review --set ~/.jevest/evals/<set>/golden.jsonl --variant agentic-jev-verifier \
  --config ~/.jevest/evals/<set>/jevest.yml --override reviewer.mode=agentic \
  --override reviewer.verifier.provider=claude-cli --override reviewer.verifier.model=claude-sonnet-5 \
  --mode live --out ~/.jevest/evals/<set>/runs
```

The config must use `reviewer.provider: claude-cli`. Since 1.0 a claude-cli
config that leaves `reviewer.mode`, `model` and `verifier.provider` unset already
resolves to agentic + the verifier on `claude-opus-5-5`
(docs/MIGRATING.md); pin `--override reviewer.mode=hunks` for the per-hunk
baseline, and set `mode` explicitly in stored variant configs so an old run
can be reproduced. Each case logs the
agent's run and EVERY tool call it made, the read-only audit:

```
[pr-1] [review] agentic: status=ran · 31 turns · 80000 tokens (in 78000, out 2000) · $1.2000 · 95000 ms · diff 40000 chars
[pr-1] [review] agentic tool: Read /tmp/jevest-head-…/tree/src/cart/total.ts
[pr-1] [review] agentic tool: Grep computeTotal @ .
[pr-1] [review] agentic tools: {"Read":20,"Grep":9,"Glob":2} · denied 0
[pr-1] [review] agentic findings: 5 reported · {"published":2,"questions":1,"low":1,"discarded":1} · drops {"exclusion:excluded-claim":1,"judge:supports-noMatch":1} · verifier 0 calls $0.0000 · Jev judge 11 requests
```

`pipeline-result.json` keeps `metrics.agentic` and an `agentic` block with
the tool calls and, per finding, its bucket, claim and route (why it was
published, asked, or dropped). Candidates: published + questions are
`shown`; every dropped finding (hard exclusion, refuted, Jev discard) is
`low` with source `dropped`, evidence failures `low` with source
`evidence-failed`.

### Buckets

`shown` is what the PR author sees: published findings, questions
(needs-human), the colleague review's bullet points, and the "possible
committed secret" warning. `low` is what the pipeline kept out of sight:
low-confidence (annotate mode) and discarded findings, including the
agentic mode's drops (source `dropped`). A narrative point
that restates a finding matches the same issue, so recall is unchanged;
the shown counts say how much the reader had to read.

## Matching

A candidate finding is matched to at most one golden issue:

1. A deterministic shortlist (`shortlistIssues`,
   src/application/eval/prefilter.ts) offers every issue of the case with a
   location (its `file` or any of its `locations`) in the candidate's file,
   closest first, plus the top 3 other issues by title-word overlap (at
   least 25% of the title's words in the candidate; an issue pinned on a
   caller, an issue without a location, a narrative point without a file),
   at most 12. An empty shortlist means "unlabeled" without any LLM call.
2. The matcher (`FindingMatcherPort`) picks one of them or none. The
   default is the LLM matcher (`--matcher llm`, alias `claude-cli`: `claude
   -p --safe-mode`, no tools, a JSON schema) on `claude-opus-5-5` at effort
   `medium` (`--matcher-model`, `--matcher-effort low|medium|high|xhigh|max`),
   using the machine's Claude login. It sees, per issue, the id, title,
   `file:line`(s), verdict, category and notes (cut at 400 characters), and
   for the candidate its location, claim, failing scenario and evidence
   quotes when the source has them (agentic findings, imports that carry
   them). The rule it gets: match only when it is the SAME underlying
   problem (same root cause and same consequence), not merely the same file
   or similar words; prefer none when unsure. It answers decision-first,
   `{ match: <issueId>|"none", sameRootCause, reason }`; an id with
   `sameRootCause: false` counts as none.
3. `--matcher prefilter` is free and deterministic, for smoke tests only
   (never report its numbers): among the offered issues it takes the
   closest one that passes the strict pre-filter (`prefilterIssues`: same
   file within ±15 lines, or same file with 30% of the title's words,
   anywhere with 60%, 40% without a location).

Decisions are cached in `<out>/matcher-cache/`, one file per decision
with the matcher's reason, keyed by a cache version, everything the matcher
is shown (issues and candidate) and the model and effort, so re-scoring a
run is free. The key version was bumped with the root-cause matcher, so no
older decision is replayed. Delete the directory to re-match.

Why the stricter matcher: an adjudicator found the previous one mapping
about 1 finding in 6 to the wrong issue, nearly always an issue in the same
file whose title shared words with the finding but whose root cause was
different.

A finding that covers two issues at once matches only one of them.

## Re-scoring a run

```bash
pnpm eval:rescore --run ~/.jevest/evals/<set>/runs/<variant> \
  --set ~/.jevest/evals/<set>/golden.jsonl \
  [--matcher llm|prefilter] [--matcher-model <model>] [--matcher-effort <level>] \
  [--matcher-concurrency <n>] [--concurrency <n>] [--as <newVariantName>]
```

Matches the candidates a run already stored again — every case's
`candidates` in its `results.json`, with claim, failing scenario and
evidence for runs made since those were stored — against the given set,
and scores them, WITHOUT re-running the pipeline or needing the import
directory. Each case keeps its cost, tokens, wall time and error; the
total wall time is the run's. Only cases both the run and the set have are
scored (the others are logged). `results.json` and `report.md` are
overwritten in the run's directory, or written to `<out>/<newVariantName>/`
with `--as`, leaving the run as it was. `source` becomes `{ type:
"rescore", run, runVariant, runCreatedAt, original }`, `original` being
the source that first produced the candidates. The matcher cache is the
run's `<out>/matcher-cache/`: unchanged decisions replay for free.

Use it after growing or correcting the set, or to measure a matcher change
on existing runs (`--as` keeps both for `pnpm eval:compare`).

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

## Held-out validation

A set you tune on (prompts, effort, thresholds, policy) stops measuring
anything once you have tuned on it. Keep a second set of PRs the variants
never ran on during tuning, build its golden issues the same way (the
adjudicated union of the variant and an independent reference review), and
run only the final candidate on it. Report it separately, and say that its
recall is relative to that union. Results of both sets so far:
[docs/BENCHMARK.md](BENCHMARK.md#review-quality-on-real-prs-eval-harness).

## Growing the set

Unlabeled findings are where a new variant can look better or worse than
the set knows. Export them:

```bash
pnpm eval:label-queue --run ~/.jevest/evals/<set>/runs/<variant> [--view shown|all] [--out queue.jsonl]
```

Each line is a golden issue with `"verdict": "unlabeled"` plus its
`caseId`. Adjudicate it (verdict, severity, evidence in `notes`), drop the
`caseId` field, give it a stable id and append it to that case's `issues`.
Re-score the runs afterwards with `pnpm eval:rescore` ("Re-scoring a
run"): cached matcher decisions for unchanged issue lists replay for free;
the new issue changes the offered list, so affected candidates are matched
again.

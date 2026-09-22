# Benchmark

Every number Jevest has measured so far, on one page, each with the report it
comes from and the exact command that replays it from recorded fixtures with
no API key. Anything not in a report under `reports/`, `docs/analysis/` or
`datasets/FINDINGS.md` is marked **not measured**; nothing here is estimated.

Ground rules shared by every run (SPEC §13, NFR-14):

- Jev model: `jev-latest` (`jev-1.13.0` at the time of the phase 0/0b runs).
- One item per Jev request (`--batch-size 1`) unless the row says otherwise.
  Batching anchors the answers within a batch, see "Batch anchoring" below.
- Runs with `--limit N` are smoke tests, never evidence.
- Fixtures are keyed by a hash of the exact state and questions sent, so a
  replay reproduces the recorded answers byte for byte; the metrics can still
  differ from the original report when the *labels* file changed afterwards
  (noted where it applies).

## Verdicts at a glance

| Hypothesis | Question to Jev | Status | Where |
|---|---|---|---|
| H0 | Does this hunk contain a defect? | **FAIL** (closed, pivot) | below, `reports/spike-*.md` |
| H0′ | What kind of change is this hunk, what surface does it touch? | **PARTIAL** | below, `reports/spike-profile-*.md` |
| H1 | Is this LLM finding a real defect? (central) | **pending** | needs the thorough findings pass |
| H6 | Is the Jev filter ≥ 100× cheaper than an LLM judge at equal recall? | **pending** | same run as H1 |
| H3 | Is confidence calibrated over findings (ECE < 0.1)? | **pending** | same run as H1, needs ≥ 200 findings |
| H7 | Does the PR description match the change? | **PASS** with-summary (2026-09-21, 200 pairs): recall 0.99, precision 1.00 at 0.65, ECE 0.070, median derived confidence 0.90. **PARTIAL** without-summary: recall 0.88, ECE 0.102 | `reports/spike-coherence-2026-09-21T23-52-31-417Z.md`; replay `pnpm coherence --variant all --mode replay` |
| H5 | Does the pipeline resist adversarial PRs? | **PASS** 14/14 against live `jev-latest` (2026-09-21): 0 undue successes, 0 suppressed critical findings, 0 secret leaks | first record run found 2 suppressed criticals → FR-5.4 fix (reviewer's severity now counts); replayed clean |
| H2, H4 | LLM tokens saved by triage/profile; Jev latency per PR | **instrumented** (2026-09-22); every run reports both — see the "Efficiency" section of the summary comment and the `jev-latency-p95-ms` / `jev-requests` / `llm-tokens-saved-pct` outputs. No verdict yet: needs ≥ 20 real PRs | below, "H2 / H4 — measured per run" |

## H0 — defect detection (FAIL, closed 2026-09-19)

Criterion: recall ≥ 0.85 and F1 ≥ 0.75 on 100 hunks (50 defect / 50
benign). Three serializers of the same hunk, best threshold per serializer.

| Run | Dataset | Batch | Serializer | Precision | Recall | F1 | Confidence p50 | Verdict |
|---|---|---|---|---|---|---|---|---|
| A · `reports/spike-2026-09-19T06-52-29-703Z.md` | v1 | 10 | raw-diff | 0.573 | 0.860 | 0.688 | not reported | FAIL |
| A | v1 | 10 | before-after-json | 0.500 | 1.000 | 0.667 | not reported | FAIL |
| A | v1 | 10 | json-with-context | 0.760 | 0.760 | 0.760 | not reported | FAIL |
| B · `reports/spike-2026-09-19T07-27-41-337Z.md` | v2 | 10 | raw-diff | 0.837 | 0.720 | 0.774 | 0.000 | FAIL |
| B | v2 | 10 | before-after-json | 0.717 | 0.660 | 0.688 | 0.150 | FAIL |
| B | v2 | 10 | json-with-context | 0.760 | 0.760 | 0.760 | 0.130 | FAIL |
| C · `reports/spike-2026-09-19T10-28-26-581Z.md` | v2 | 1 | raw-diff | 0.561 | 0.920 | 0.697 | 0.355 | FAIL |
| C | v2 | 1 | before-after-json | 0.805 | 0.660 | 0.725 | 0.320 | FAIL |
| C | v2 | 1 | json-with-context | 0.645 | 0.800 | 0.714 | 0.420 | FAIL |

Cost and latency of run B (the one SPEC §4.1 cites): raw-diff 71,207 input
tokens, USD 0.0030, p50 275 ms, p95 592 ms; json-with-context 111,715 tokens,
USD 0.0047, p50 312 ms. Run C: raw-diff 94,427 tokens, USD 0.0040, p50 243 ms.

Reading: v1 → v2 removed a path confound (precision 0.57 → 0.84 on raw-diff);
one hunk per request (B → C) raised the reported confidence from ~0 to
0.32–0.42 but not F1. Judging a defect is a reasoning task; Jev's calibration
says so. This is the negative result the pivot rests on.

Replay:

```sh
pnpm spike --mode replay                    # run C (batch 1, dataset v2)
pnpm spike --mode replay --batch-size 10    # run B (batch 10, dataset v2)
```

Run A used dataset v1, whose fixtures were not kept; its report is the record.

## H0′ — surface profile (PARTIAL, 2026-09-19)

Criterion: `change_kind` accuracy ≥ 0.90; F1 ≥ 0.85 on each noul; median
confidence ≥ 0.5. Dataset v2, serializer raw-diff, AST ground truth in
`datasets/profile-labels.jsonl`.

| Question | D · batch 10, labels v1 | E · batch 1, labels v1 | F · batch 1, labels v2 (replay) | Bar | Verdict (F) |
|---|---|---|---|---|---|
| `change_kind` accuracy | 0.480 (conf p50 0.855) | 0.720 (conf p50 0.965) | **0.800** (conf p50 0.965) | 0.90 | close; `modify-behavior` F1 0.690 carries the error |
| `touches_error_handling` F1 | 0.310 | 0.774 | **0.889** (ECE 0.087) | 0.85 | **PASS** |
| `touches_async` F1 | 0.431 | 0.914 | **0.846** (ECE 0.110) | 0.85 | at the bar; 11 positives |
| `touches_io` F1 | 0.377 | 0.815 | 0.714 (ECE 0.169) | 0.85 | below; 6 positives |
| `touches_public_api` F1 | 0.314 | 0.581 | 0.645 (recall 1.000, precision 0.476) | 0.85 | definition gap: the `export` is usually outside the hunk |

Per-class `change_kind` in run F: add-behavior F1 0.911 (56), modify-behavior
0.690 (26), delete 0.667 (5), rename-or-format 0.571 (13). Cost of runs E and
F (same fixtures): 113,827 input tokens, USD 0.0048, p50 246 ms. Run D:
90,607 tokens, USD 0.0038, p50 289 ms.

Reports: D `reports/spike-profile-2026-09-19T10-16-05-895Z.md`,
E `reports/spike-profile-2026-09-19T10-29-06-149Z.md`,
F `reports/spike-profile-2026-09-19T10-46-26-481Z.md`.

Consequence in the pipeline (SPEC §4.3, provisional): Jev answers
`change_kind`, `touches_error_handling`, `touches_async`; `touches_public_api`
is derived by AST in code; `touches_io` is out until ≥ 30 labeled positives.

Replay:

```sh
pnpm spike:profile --mode replay                    # run F: batch-1 fixtures scored on the current (v2) labels
pnpm spike:profile --mode replay --batch-size 10    # run D's fixtures scored on the current labels (D itself used labels v1)
```

Run E cannot be reproduced from the current labels file (it used labels v1);
its report is the record.

## Batch anchoring (the finding behind NFR-14)

Source: `docs/analysis/h0-prime-error-analysis.md`, over run D's raw
predictions (`tests/fixtures/spike-profile/`, 10 batches of 10 hunks).

| Measurement | Value |
|---|---|
| Std. deviation of each noul *within* a batch of 10 unrelated hunks | 0.004 – 0.026 |
| `change_kind` picks in 100 hunks at batch 10 | 100/100 `add-behavior` (mean p 0.865) |
| `change_kind` accuracy, batch 10 → batch 1, same labels | 0.480 → 0.720 |
| `touches_error_handling` F1, batch 10 → batch 1, same labels | 0.310 → 0.774 |
| `confidence` ≠ `max(probabilities)` on `change_kind` | 77/100 answers |

Reading: the variance sat *between* batches, not between hunks; Jev was not
reading each hunk independently. Every runner now defaults to one item per
request and prints a warning when asked to batch. The same analysis found
three bugs in the AST labeler (barrel re-exports, declaration merging,
`#private` fields) and one in the label rule for the nouls (context vs.
changed lines), fixed in labels v2.

## Strict findings pass (input to H1, 2026-09-19)

Source: `datasets/FINDINGS.md`. The LLM reviewer (`claude-opus-5` via
`claude -p`, strict prompt) over the 100 hunks; each finding labeled real or
noise by line-overlap with the fix.

| Metric | Value |
|---|---|
| Hunks attempted | 100 / 100 |
| Findings | 14 (9 real, 5 noise) |
| By severity | nit 0, minor 11, major 3, critical 0 |
| Hunks with ≥ 1 finding | 12 (88 had none) |
| Findings on a benign hunk | 5 of 14 (35.7%) |
| Wall time (concurrency 2) | 453.9 s |
| Latency p50 / p95 / p99 | 8,994 / 24,386 / 24,386 ms |
| Cache hit share | 47.4% |
| Nominal cost | USD 2.28 (subscription quota, not cash) |

Reading: too little noise to measure H1's "≥ 40% of noise discarded" or H3's
ECE (SPEC §4.2 asks for ≥ 200 findings). A thorough-prompt pass and an
LLM-judge baseline are the next runs (`FINDINGS.md`, fixtures under
`tests/fixtures/findings-thorough/` and `tests/fixtures/filter-judge/`).

Reproducing the pass: `pnpm findings --provider claude-cli --record
--budget-usd 15` re-runs the reviewer (subscription quota) and rewrites the
100 fixtures in `tests/fixtures/findings/`; `pnpm findings` has no replay
mode, so `datasets/findings.jsonl` and `FINDINGS.md` are the record. Filter
metrics over these 14 findings: **not measured** in a committed report.

## H2 / H4 — measured per run (instrumented 2026-09-22)

Source: `src/application/pipeline/run-metrics.ts`, computed on every run
of the pipeline (Action and `pnpm review`) and rendered as the closing
"Efficiency" section of the summary comment; the Action also exposes
`jev-latency-p95-ms`, `jev-requests` and `llm-tokens-saved-pct` as outputs.
No verdict is claimed here: these are per-run numbers, and the SPEC §4.2
bars (H2: −30 % LLM tokens at the same detection rate; H4: p95 < 2 s for
PRs of ≤ 50 hunks) need at least 20 real PRs, on real repos, before either
row can turn PASS or FAIL. Until a run of that size is committed under
`reports/`, both stay **instrumented, no verdict**.

**H4, what is measured.** Every Jev request of the run reports its own
`latencyMs` (triage: one; hunk profile: one per profiled hunk; finding
filter: one per finding; merge gate: one). The section shows the request
count, the nearest-rank p95 and the sum ("total Jev time"). `metrics`
also carries the wall clock per stage, which includes the LLM calls and
the GitHub round trips and is therefore NOT the H4 number.

**H2, what is estimated.** The tokens actually spent on the LLM are
measured (review calls + the change summary, every input-side token
counted: uncached, cache read, cache write). The comparison point,
"tokens without Jev", is a COUNTERFACTUAL: what reviewing every hunk
would have cost. Reviewed hunks contribute their measured usage; each
hunk the run did not send to the reviewer (triage skip, `skipChangeKinds`,
secret, per-run budget, spend cap, reviewer disabled) contributes
`ceil(chars / 4)` input tokens from its diff plus the run's mean output
tokens per reviewed hunk (150 when nothing was reviewed). Then
`saved % = (without − spent) / without`.

Limits, stated on the comment itself:

- It is an estimate, not a measurement. The skipped hunk's real review
  call would also carry the prompt and the `before` context, which the
  estimate ignores, so the saving is a floor. 4 chars per token is a
  rule of thumb, not the provider's tokenizer.
- "Same detection rate" (the other half of H2) is not measured by this
  instrumentation at all. It needs the finding filter's recall from H1.
- Hunks beyond `maxHunks` are not profiled and their diff is not kept, so
  they are counted (`truncatedByMaxHunks`) but not priced.
- The change summary is counted as spent (it exists because of Jev's
  triage), so a tiny PR can report a negative saving. That is the honest
  number, not a bug.

## Runtime of the Action (2026-09-20)

Source: `docs/ACTION.md`, "Why no checkout"; one real run on
a private PHP + Vue monorepo (a 9.7 GB tree), Jev-only mode.

| Step | Time |
|---|---|
| `actions/checkout@v4` | 2m43s |
| Jevest's own work | 22s |
| Whole job with checkout | 3m09s |

Reading: the checkout was incidental infrastructure; the Action now fetches
the PR, the diff and `.jevest.yml` through the API and a job on that repo
takes about 25 seconds. Single run, one repo: an observation, not a
benchmark. Not replayable.

## Pending

| Hypothesis | What will fill the row | Command |
|---|---|---|
| H1 · finding filter (recall ≥ 0.95, ≥ 40% noise discarded) | the thorough findings pass scored by `pnpm filter` | `pnpm filter --findings datasets/findings-thorough.jsonl --mode record --judge claude-cli --judge-mode replay` |
| H6 · Jev vs. LLM judge (≥ 100× cheaper, equal recall) | same run, judge side | same command; judge fixtures first with `--mode dry-run --judge claude-cli --judge-mode record` |
| H3 · calibration (ECE < 0.1 over ≥ 200 findings) | same run, once ≥ 200 findings exist | same command |
| H7 · intent–change coherence (recall ≥ 0.90, precision ≥ 0.85, ECE < 0.1) | full 200-pair run, both variants | `pnpm coherence:summarize --mode record` then `pnpm coherence --mode record`; replay with `pnpm coherence --mode replay` |
| H5 · adversarial suite (0 undue successes, 0 suppressed critical findings) | Jev's recorded answers on the 14 cases | `pnpm adversarial --mode record`, then `pnpm adversarial --mode replay` (CI gate: `src/application/adversarial/adversarial-suite.test.ts`) |
| H2 · LLM tokens saved by triage + profile (−30%) | ≥ 20 real PRs' "Efficiency" sections (or `llm-tokens-saved-pct` outputs) collected in a report; the detection-rate half needs H1 | instrumented on every run; no collection command yet |
| H4 · Jev latency per PR (p95 < 2 s for ≤ 50 hunks) | same ≥ 20 PRs, `jev-latency-p95-ms` and total Jev time per run | instrumented on every run; no collection command yet |

H7 ran on 2026-09-21 over all 200 pairs against live Jev, both variants
(`reports/spike-coherence-2026-09-21T23-52-31-417Z.md`). With the LLM
summary of the diff in the state, Jev separates crossed descriptions almost
perfectly (1 false negative, 0 false positives at the best threshold; p95
latency 295 ms; 200 requests in 48 s). Without the summary, on title, body
and path-derived facts alone, recall drops to 0.88 and calibration slips to
ECE 0.102. Reading: the summary is what turns "code" into text Jev can judge;
the product-aware triage adopts it. Caveats: descriptions were crossed within
the same repo but not chosen to be near-duplicates, so this measures the easy
half of the problem; 6 of 100 incoherent pairs carry a basename leak (listed
in datasets/README.md) and none of them appears among the worst pairs.

H5 was recorded against live Jev on 2026-09-21
(`reports/adversarial-2026-09-21T21-38-55-741Z.md`, fixtures under
`tests/fixtures/adversarial/`): 14/14 pass, 0 undue successes, 0 suppressed
critical findings, 0 leaks. Two lessons from that run:

- The FIRST record run failed with 2 suppressed criticals (`adv-control-benign`,
  `adv-tests-pass-claim`): Jev scored the planted finding 2.3/3 (major) with a
  confident "not a real defect", and the FR-5.4 guard only looked at Jev's
  severity. The guard now honors the reviewer's `critical` too, and a critical
  finding is never discarded in any band. Replaying the same fixtures after the
  fix gives the numbers above.
- `contains_injected_instructions` only sees the triage state (title, body,
  labels, paths). Instructions hidden inside the diff (code comments, string
  literals, unicode) scored 0.03; instructions in the body/title scored
  0.72–0.99. Every attacked case still ended with a red check because the
  merge gate is conservative, not because the injection was detected. Fixed
  on 2026-09-22 with a hunk-level noul, `contains_reviewer_instructions`,
  asked at stage 2 where the diff IS the state. Re-recorded
  (`reports/adversarial-2026-09-22T11-47-44-425Z.md`): the two cases that
  hide instructions in the diff (`adv-code-comment`, `adv-string-literal`)
  score **0.99** on the hunk that carries them; every other case scores
  0.01–0.02 on that question, including the whitespace flood that hides a
  logic flip and not an instruction. 14/14 still pass, 0 undue successes,
  0 suppressed criticals, 0 missed in-diff injections. The merge gate now
  goes red on either signal, description or diff.

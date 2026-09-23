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
| H1 | Is this LLM finding a real defect? (central) | **PASS** on H1b (2026-09-23, reversed hunks vs. the fix-aware oracle, n=55 real / 154 noise): recall 0.964 (53/55) at threshold 0.45, 51.9% of noise discarded, AUC 0.792. The FAIL on the original (before → after) hunks stands as history — line-overlap AUC 0.592 (near chance), and the original oracle sample had only n=7 real, too small for a recall verdict. Caveats on the PASS: n=55 gives a wide recall interval, the oracle labeler and the H6 judge share a model, and the reversed diff is an artificial recall population (§ H1b) | below, "Thorough findings pass and finding filter" and "H1b — reversed hunks" |
| H6 | Is the Jev filter ≥ 100× cheaper than an LLM judge at equal recall? | **PASS** (2026-09-22): 188.9× cheaper, recall gap 0.035 vs. line-overlap; **PASS** vs. the original oracle: 182× cheaper; **PASS** on H1b (2026-09-23): 704.7× cheaper, and Jev's recall exceeds the judge's at Jev's own threshold (gap −0.218); at the judge's own best threshold it only matches Jev's recall, at ~700× the cost and ~25× the latency | same run as H1; H1b below |
| H3 | Is confidence calibrated over findings (ECE < 0.1)? | **FAIL** raw, every time measured: ECE 0.191 vs. line-overlap (N=299, 2026-09-22); 0.504 vs. the original oracle sample (base rate 0.028); 0.284 on H1b (2026-09-23, base rate 0.263) — Jev's probabilities keep running above the true real rate. **FAIL post-hoc too** (2026-09-23): a Platt map fitted on H1b reaches a held-out ECE of 0.071 there, well inside the bar, but carries 0.216 to the thorough set, whose base rate is ten times lower. Calibration is available and **off by default** | same run as H1; H1b and "Post-hoc calibration study" below |
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
`tests/fixtures/findings-thorough/` and `tests/fixtures/filter-judge/`), see
below.

Reproducing the pass: `pnpm findings --provider claude-cli --record
--budget-usd 15` re-runs the reviewer (subscription quota) and rewrites the
100 fixtures in `tests/fixtures/findings/`; `pnpm findings` has no replay
mode, so `datasets/findings.jsonl` and `FINDINGS.md` are the record. Filter
metrics over these 14 findings: **not measured** in a committed report.

## Thorough findings pass and finding filter (H1 / H6 / H3, 2026-09-22)

Source: `datasets/findings-thorough.jsonl`, the 100 hunks in
`datasets/hunks.jsonl` (v2), thorough reviewer prompt (`claude-cli`,
`claude-opus-5`). 299 findings, 137 labeled real / 162 noise by
line-overlap (base rate real = 0.458). Report:
`reports/filter-2026-09-22T14-36-07-230Z.md`. Fixtures: reviewer
`tests/fixtures/findings-thorough/`; Jev filter `tests/fixtures/filter/`
(299); judge (DeepSeek) `tests/fixtures/filter-judge-deepseek/` (294); judge
(claude-cli) `tests/fixtures/filter-judge/` (223, **frozen** since
2026-09-22 — the Claude subscription is reserved for reviews, not extended
further).

### Jev finding filter

| Metric | Value |
|---|---|
| Findings answered | 299 / 299 (one per request) |
| Best threshold (`is_real_defect`) | 0.20 |
| Precision / Recall / F1 at 0.20 | 0.485 / 0.920 / 0.635 |
| Noise discarded at 0.20 | 0.173 |
| ECE (H3) | 0.191 over N = 299 |
| AUC (real vs. noise) | 0.592 |
| Severity confidence p10 / p50 / p90 / mean | 0.558 / 0.800 / 0.950 / 0.776 |
| Cost | USD 0.015425, 367,267 input tokens |
| Latency p50 / p95 | 252 ms / 331 ms |
| H1 | **FAIL**: recall 0.920 < 0.95; noise discarded 0.173 < 0.40 |
| H3 | **FAIL**: ECE 0.191 ≥ 0.10 |

Threshold curve:

| Threshold | Recall | Noise discarded | Precision |
|---|---|---|---|
| 0.10 | 0.985 | 0.031 | 0.462 |
| 0.15 | 0.964 | 0.093 | 0.473 |
| 0.20 | 0.920 | 0.173 | 0.485 |
| 0.30 | 0.825 | 0.278 | 0.491 |
| 0.40 | 0.723 | 0.377 | 0.495 |
| 0.50 | 0.657 | 0.506 | 0.529 |

### LLM-judge baseline (H6), DeepSeek

`deepseek-v4-pro` via `json_object`, the same state per finding as Jev
(hunk diff + claim + rationale + file + lines, no label). 294 / 299
answered (5 truncated: reasoning exceeded the 8192-token `max_tokens`; a
first attempt at the 1024 default truncated 263/299, fixed in `d12fede`).

| Metric | Jev | Judge (DeepSeek) |
|---|---|---|
| Recall at threshold 0.20 | 0.920 | 0.955 |
| Precision at threshold 0.20 | 0.485 | 0.452 |
| Noise discarded at threshold 0.20 | 0.173 | 0.043 |
| AUC | 0.592 | 0.567 |
| Cost | USD 0.015425 | USD 2.9132 |
| Latency p50 / p95 | 252 / 331 ms | 32,813 / 85,811 ms |

Cost ratio judge/Jev: 188.9×. Recall gap (judge − Jev): 0.035. **H6: PASS**
(≥ 100× cheaper, recall within 0.05).

Judge threshold curve: 0.30 R 0.820 ND 0.230 P 0.468 | 0.40 R 0.737
ND 0.342 P 0.480 | 0.50 R 0.684 ND 0.398 P 0.484 | 0.60 R 0.451 ND 0.671
P 0.531 | 0.70 R 0.398 ND 0.720 P 0.541 | 0.90 R 0.135 ND 0.901 P 0.529.

Judge severity vs. label: major 67 real / 76 noise, minor 58 / 73, critical
4 / 10, nit 4 / 2.

### Reading: the label, not the filter, is what failed

Precision of both Jev and the reasoning LLM equals the base rate (0.458) at
every threshold, and both AUCs sit near 0.5 (0.592 and 0.567). A model that
reasons for roughly 30 seconds per finding cannot separate the two classes
either, so the line-overlap label (a finding's lines must intersect the
fix's lines on a hunk already labeled *defect*; anything on a benign hunk
is noise — weaknesses listed in `datasets/FINDINGS.md` §3) does not measure
"is this finding a real defect." The DeepSeek run served as a control on
the ground truth, not just as a cost baseline.

Verdict: **H1 FAIL on the current labels, inconclusive on the question it
asks.** H3's FAIL inherits the same caveat — ECE against an invalid label
is not a calibration verdict. **H6 PASS stands** on cost and latency, but
"equal recall" here means equal recall at near-chance discrimination.

What a valid H1 verdict needs:

- A human-labeled stratified sample (`datasets/FINDINGS.md` §5 step 2
  "manual verification"), at least 60–80 findings across real/noise ×
  severity.
- Re-score Jev and the judge from the existing fixtures at zero cost
  (replay) once that sample exists — no new LLM calls needed.
- An LLM labeler shown *the same information the filter had* would be
  circular. One shown the FIX is not — see the next section.

Pending product decision (not decided here): keep stage 4 (finding filter)
discarding findings below the confidence band, or switch it to
annotate-only (publish everything, mark confidence) until H1 has a valid
verdict. Triage, hunk profile and the merge gate are unaffected: H0′, H7
and H5 already passed. Per SPEC §4.2 ("si falla, Jev no aporta al review"),
the negative-on-current-labels result is published with its datasets and
fixtures (phase 3 "negative benchmark" path), not hidden.

Reproduce, zero cost:

```sh
pnpm filter --findings datasets/findings-thorough.jsonl --mode replay --judge deepseek --judge-mode replay
```

### Fix-aware oracle label (second ground truth, built 2026-09-22)

Rather than hand-label, the label is rebuilt from information neither Jev nor
the judge ever had: the code AFTER the real fix, the fix's commit message, and
the linked issue or pull-request text. Predicting a defect and checking a
prediction against what actually happened next are different problems, and only
the second has an answer in the data — which is what breaks the circularity.

Two framings on the same model, agreement required: *does this finding describe
what the fix fixed?* and *is the claimed problem present in the before code?*
Agreement gives `real` or `noise`; anything else is `unknown` and is **excluded
from H1/H3/H6**, with its share printed. Design, the combination rule and the
weaknesses: `datasets/FINDINGS.md` §10.

New artifacts: `datasets/hunk-evidence.jsonl` (issue/PR text per hunk),
`label.oracle` on every finding record, fixtures in
`tests/fixtures/findings-oracle/`.

How to reproduce:

```sh
# 1. Issue and PR text behind each fix. Public repos, read-only, resumable.
pnpm dataset:evidence

# 2. Label: 2 calls per finding (299 findings -> 598 calls). Resumable.
DEEPSEEK_API_KEY=... pnpm findings:label \
    --findings datasets/findings-thorough.jsonl \
    --out datasets/findings-thorough-oracle.jsonl \
    --labeler deepseek --mode record --concurrency 2

# 3. Re-score against the new label. ZERO new LLM calls — Jev and the judge
#    replay from the fixtures they already have.
pnpm filter --findings datasets/findings-thorough-oracle.jsonl \
    --mode replay --judge deepseek --judge-mode replay --label oracle

# The old numbers stay reproducible; --label defaults to line-overlap.
pnpm filter --findings datasets/findings-thorough.jsonl --mode replay --judge deepseek --judge-mode replay
```

Prove the chain at zero cost (seeded fake labeler, meaningless verdicts):

```sh
pnpm findings:label --findings datasets/findings-thorough.jsonl \
    --out /tmp/oracle.jsonl --labeler dry-run --mode dry-run
pnpm filter --findings /tmp/oracle.jsonl --mode replay --judge none --label oracle
```

Run 2026-09-22: 586 calls over the 299 findings (two runs — 15 findings first
truncated at the 8192-token reasoning cap, retried with `--max-tokens 32768`),
cost USD 4.96, latency per finding (both passes) p50 37 s / p95 113 s.
Report: `reports/oracle-2026-09-22T16-56-57-376Z.md`. Verdicts: 7 real (2.4%),
239 noise (81.6%), 47 unknown (16.0%), plus 6 findings the labeler could not
reach at all (DeepSeek returned `402 insufficient balance` on the retry;
scored as unknown, same as any other unknown — excluded from H1/H3/H6).
Framing agreement (Pass A vs. Pass B, before combination) 84.0%.

Cross-tab against the old line-overlap label: of the 133 findings line-overlap
called real, the oracle says 7 real / 106 noise / 20 unknown; of the 160 it
called noise, the oracle says 0 real / 133 noise / 27 unknown. The two labels
agree on 57% of the cases where the oracle reaches a decision. Sampled reasons
hold up under reading — for example, a noise verdict on a finding warning that
switching a `Map` to a `WeakMap` "drops size/clear/iteration" cites the PR's
own statement that the buckets only ever need `get` and `set`.

### Re-scored against the fix-aware oracle label (2026-09-22)

`pnpm filter --findings datasets/findings-thorough-oracle.jsonl --mode replay
--judge deepseek --judge-mode replay --label oracle` — zero new LLM calls,
Jev and the judge replay from the same fixtures scored in the line-overlap run
above. Report: `reports/filter-2026-09-22T16-58-00-234Z.md`. Scored
population 246 (7 real / 239 noise); 53 findings excluded as `unknown`.

| Metric | Jev vs. oracle | DeepSeek judge vs. oracle |
|---|---|---|
| Scored | 246 / 246 | 241 / 246 (5 truncated) |
| AUC | 0.708 (was 0.592 vs. line-overlap) | 0.700 (was 0.567 vs. line-overlap) |
| ECE | 0.504 (base rate 0.028) | not computed |
| Cost | USD 0.0128 | USD 2.33 |
| Latency p50 / p95 | 250 ms / 334 ms | 31.5 s / 85.8 s |

Jev threshold curve: 0.20 R 1.000 ND 0.146 | 0.30 R 1.000 ND 0.255 | 0.40
R 0.857 ND 0.360 | 0.50 R 0.714 ND 0.460. The report's own F1-best threshold
(0.85) gives R 0.429 ND 0.862 P 0.083 — meaningless at 7 positives; the curve
above is the number that matters here. P(real) Jev assigned the 7 real
findings: 0.39, 0.46, 0.73, 0.78, 0.85, 0.87, 0.90.

Judge threshold curve: 0.30 R 1.000 ND 0.226 | 0.40 R 1.000 ND 0.321 | 0.50
R 0.857 ND 0.372 | 0.60 R 0.714 ND 0.662 | 0.70 R 0.429 ND 0.697.

**H6 vs. oracle: PASS** — cost ratio 182×, recall gap within tolerance. **H1
vs. oracle: FAIL, formally** — no threshold reaches recall ≥ 0.95 AND noise
discarded ≥ 0.40 at once: at full recall (threshold 0.20–0.30) Jev discards
25.5% of the noise, the judge 32.1%. **H3 vs. oracle: FAIL** — ECE 0.504,
driven by Jev's probabilities running far above the oracle's 2.8% real rate.

Reading:

1. The oracle label is validated by two independent scorers, both rising on
   it (Jev 0.592 → 0.708, judge 0.567 → 0.700): it measures something the
   line-overlap label did not.
2. The structural reason there are only 7 real findings: `datasets/hunks.jsonl`
   presents the reviewer with the bugfix commit's own diff (before → after).
   A reviewer reviewing 100 already-fixed bugs can only produce a "real"
   finding when it happens to describe the defect being fixed — 7 times in
   299. The set is therefore a large, clean NOISE benchmark (239) and an
   unusable RECALL population (n=7, no confidence interval worth reporting).
3. What Jev does show on this set: at the threshold that keeps every real
   finding, it removes a quarter of the noise; the reasoning judge removes a
   third, at 182× the cost. Neither clears the 40% bar. Calibration is off in
   a known direction — probabilities too high for a 2.8% base rate.
4. Next step, at the time: H1b — a reversed-hunk dataset (present after →
   before, the buggy state as the change), so a real finding is one that
   flags the bug the fix later removed. It ran for real on 2026-09-23 and
   gives H1 a PASS — see "H1b" below.
5. Stage 4 stayed in annotate mode (`findingFilter.mode: "annotate"`) until
   H1b landed, and stays there still: H1b gives H1 a verdict, but flipping
   stage 4 to discard is a separate, still-pending product decision — see
   "H1b" below.

Reproduce, zero cost:

```sh
pnpm findings:label --findings datasets/findings-thorough.jsonl \
    --out datasets/findings-thorough-oracle.jsonl \
    --labeler deepseek --mode replay
pnpm filter --findings datasets/findings-thorough-oracle.jsonl \
    --mode replay --judge deepseek --judge-mode replay --label oracle
```

### H1b — reversed hunks (2026-09-23)

The set behind H1's original FAIL is a clean noise benchmark and an unusable
recall population, for a structural reason: the reviewer was shown the
bugfix commit's own diff. H1b turns the defect hunks around — the diff runs
after → before, so the change under review *introduces* the bug and a real
finding is one that flags it. The benign hunks are copied unchanged, so the
set still mixes both kinds at 50/50.

What is reversed is only the reviewer's view. `before`, `after`, `label` and
`evidence` stay in original orientation, so the fix-aware labeler keeps seeing
`before` = buggy and `after` = fixed and its verdicts mean on this dataset
exactly what they meant on the last one. No prompt was changed. Design and the
full protocol: `datasets/FINDINGS.md` §11, `datasets/README.md`
§ hunks-reversed.

All of the below ran on 2026-09-22/23 against the Claude subscription
(`claude-cli`, `claude-opus-5`), nominal costs (Claude Max quota, not cash).

**Dataset.** `pnpm dataset:reverse` built `datasets/hunks-reversed.jsonl`:
the 50 defect hunks with their diff reversed (after → before, the buggy state
presented as the change; removals before additions per block, self-inverse;
`before`/`after`/`evidence` kept in original orientation for the labeler, so
the reviewer is shown the fixed code as the pre-image), plus the 50 benign
hunks unchanged.

**Reviewer** (thorough prompt, `claude-cli`/`claude-opus-5`): 100/100 hunks,
246 findings (99 on reversed hunks, 147 on benign), 2.46 findings/hunk,
severity nit 33 / minor 107 / major 89 / critical 7. Cost USD 6.81 nominal,
wall time 1462 s, latency p50 21 s, cache-hit share 48.7%. Two hunks needed
one retry each (transient `claude-cli` exit code 1, same class of flake as
§7's thorough pass).

**Fix-aware oracle label**, same `claude-cli`/`claude-opus-5`, two framings
with agreement required (`FINDINGS.md` §10): real 55 (22.4% — every one on a
reversed hunk), noise 154 (62.6%: 119 benign + 35 reversed), unknown 37
(15.0%), 0 failures. Framing agreement 85.0%. Cost USD 22.97 nominal over 492
calls, latency p50 15.5 s per finding. Report:
`reports/oracle-2026-09-23T00-05-15-536Z.md`. Fixtures:
`tests/fixtures/findings-oracle/` (the fixture key now mixes in the labeler
id; the frozen DeepSeek keys are unaffected).

Cross-tab, line-overlap label × oracle label: of the 99 findings on a
reversed hunk (line-overlap "real" on this orientation), the oracle says 50
real / 29 noise / 20 unknown; of the 147 on a benign hunk (line-overlap
"noise"), the oracle says 5 real / 125 noise / 17 unknown.

**Scoring**
(`pnpm filter --findings datasets/findings-reversed-oracle.jsonl --hunks datasets/hunks-reversed.jsonl --mode replay --judge claude-cli --judge-mode replay --label oracle`,
report `reports/filter-2026-09-23T00-14-31-744Z.md`), scored population 209
(55 real / 154 noise), 37 excluded as `unknown`:

| Metric | Jev vs. oracle | claude-cli judge vs. oracle |
|---|---|---|
| Scored | 209 / 209 | 209 / 209 (246 calls) |
| AUC | 0.792 | 0.868 |
| Best threshold | 0.45 | — (own curve below) |
| Precision / Recall / F1 at 0.45 | 0.417 / 0.964 (53/55) / 0.582 | 0.603 / 0.745 / — |
| Noise discarded at 0.45 | 0.519 | 0.825 |
| ECE (H3) | 0.284 (base rate 0.263) | not computed |
| Cost | USD 0.0109 | USD 8.99 nominal |
| Latency p50 / p95 | 384 ms / 493 ms | 9.6 s / 25.6 s |

Jev threshold curve: 0.20 R 1.000 ND 0.240 | 0.25 R 1.000 ND 0.312 | 0.30
R 0.982 ND 0.370 | 0.40 R 0.982 ND 0.474 | 0.45 R 0.964 ND 0.519 | 0.50
R 0.909 ND 0.545.

Judge threshold curve: 0.10 R 1.000 ND 0.071 | 0.20 R 0.964 ND 0.584
P 0.453 | 0.30 R 0.891 ND 0.721 | 0.40 R 0.764 ND 0.792 | 0.50 R 0.673
ND 0.844 | 0.60 R 0.618 ND 0.890. Judge severity vs. label: major 40 real /
51 noise, minor 15/88, critical 0/5, nit 0/10.

**H1 vs. oracle, on H1b: PASS** — recall 0.964 (53/55) and 51.9% of noise
discarded at once, threshold 0.45. **H6 vs. oracle: PASS** — cost ratio
704.7×; at Jev's own threshold the judge's recall is actually *lower* than
Jev's (gap −0.218, judge 0.745 vs. Jev 0.964); at the judge's own best
threshold (0.20) it only reaches Jev's recall, with 58.4% of noise discarded
against Jev's 51.9% — a modest edge at ~700× the cost and ~25× the latency.
**H3 vs. oracle: FAIL** — ECE 0.284 against a 26.3% base rate, the same
"probabilities run high" pattern as every earlier run of this label.

Reading:

1. H1b closes the population gap that made the original oracle sample
   unusable: reversing the hunks turns every defect hunk into a chance to
   produce a real finding instead of 1-in-3, and the labeler agrees on 55 of
   them.
2. Both scorers separate real from noise convincingly (Jev AUC 0.792, judge
   AUC 0.868) — well above the 0.708/0.700 the same two scorers reached on
   the un-reversed oracle sample, and far above line-overlap's ~0.58. The
   oracle label keeps validating itself as sample size grows.
3. Jev clears the H1 bar for the first time: recall 0.964 with just over
   half the noise discarded. The reasoning judge reaches a higher AUC and,
   at its own threshold, discards more noise for the same recall — but at
   704.7× the nominal cost and roughly 25× the latency, which is exactly the
   trade-off H6 asks about.

**Caveats, stated plainly:**

- n = 55 real findings: a recall of 53/55 carries a wide confidence interval
  (roughly 0.87–0.99). The ≥ 0.95 bar is met, not statistically secured.
- The oracle labeler and the judge are the same model (`claude-opus-5`), so
  part of the judge's AUC edge may be shared-model bias. Jev is independent
  of the labeler.
- The reversed diff is an artificial change — a real PR rarely reintroduces
  a fixed bug verbatim. H1b measures "can the filter keep a finding that
  flags a known defect while dropping speculation", not the distribution of
  a production PR stream.
- H3 remains FAIL regardless of orientation.

**Verdict.** H1 **PASS** on H1b (reversed hunks, fix-aware oracle label);
the earlier FAIL against line-overlap and against the un-reversed oracle
sample stands as the record of an invalid or too-small label, not something
H1b overturns retroactively. Stage 4 stays in annotate mode
(`findingFilter.mode: "annotate"`) for now — flipping it to discard is a
separate product decision, pending a run on real PRs, not decided here.

Total nominal spend across the H1b run (reviewer + oracle + judge): ≈ USD
38.77, on top of the USD 8.28 of the original thorough reviewer pass.

Reproduce, all replay, zero cost (`pnpm dataset:reverse` is a deterministic
local computation, not a replay, but also free):

```sh
pnpm dataset:reverse

pnpm findings --provider claude-cli --prompt thorough --record \
              --hunks datasets/hunks-reversed.jsonl \
              --fixtures-dir tests/fixtures/findings-reversed \
              --out datasets/findings-reversed.jsonl

pnpm findings:label --findings datasets/findings-reversed.jsonl \
                    --hunks datasets/hunks-reversed.jsonl \
                    --out datasets/findings-reversed-oracle.jsonl \
                    --labeler claude-cli --mode replay

pnpm filter --findings datasets/findings-reversed-oracle.jsonl \
            --hunks datasets/hunks-reversed.jsonl \
            --mode replay --judge claude-cli --judge-mode replay --label oracle
```

The second command replays from the fixtures already on disk under
`tests/fixtures/findings-reversed/` (record mode is resumable and makes no
call once every hunk has a fixture). Every fixture set keys on something the
reversed run changes, so none of the frozen originals could be replayed into
it by accident (`FINDINGS.md` §11.2 has the table). The oracle labeler's key
now includes which labeler answered; an absent labeler id reproduces the
historical key exactly, so the DeepSeek fixtures behind the earlier numbers
still replay byte-for-byte.

## Post-hoc calibration study (H3, 2026-09-23)

H3 asks whether `is_real_defect` is calibrated (ECE < 0.1 over ≥ 200 labeled
findings). Raw, it is not, and never has been: 0.191 against line-overlap,
0.504 on the thorough oracle sample, 0.284 on H1b. Every one of those is the
same failure — the probabilities run above the rate at which the findings are
really defects.

This section asks the next question. The ranking is good (AUC 0.792 on H1b,
which is what H1's recall rides on); only the scale is wrong. Can a monotone
map fitted after the fact fix the scale without touching the ranking?

Source: `scripts/filter/calibrate.ts`, `src/application/filter/calibration-study.ts`,
`src/domain/calibration.ts`. Report: `reports/calibration-2026-09-23T14-21-22-555Z.md`.
Ground truth is the fix-aware oracle label; `unknown` findings are excluded.
Reproduce (replay only, no API call, zero cost):

```sh
pnpm calibrate
```

**Every number below is held out.** Fitting a map and reporting the ECE of the
same points is circular — isotonic can drive it near zero on any sample by
memorizing it. So the study uses 5-fold cross-validation, stratified on the
label, seed 20260923: fit on 4 folds, score the fold left out, pool every
out-of-fold prediction. And then it does the thing that actually decides
whether a map is worth shipping: fit on one whole set, score the other.

### The two sets

| Set | N | Real | Noise | Base rate | Raw ECE | Raw Brier | Raw AUC |
|---|---|---|---|---|---|---|---|
| `findings-reversed-oracle` (H1b, primary) | 209 | 55 | 154 | 0.263 | 0.284 | 0.242 | 0.792 |
| `findings-thorough-oracle` | 246 | 7 | 239 | 0.028 | 0.504 | 0.341 | 0.708 |

### Held-out cross-validation on the H1b set

| Method | Held-out ECE (mean ± sd) | Pooled held-out ECE | Pooled held-out Brier | AUC after the map | Order kept | Distinct values |
|---|---|---|---|---|---|---|
| none (identity) | 0.303 ± 0.035 | 0.284 | 0.242 | 0.792 | yes | 75 of 75 |
| platt | 0.150 ± 0.034 | **0.071** | 0.159 | 0.792 | yes | 75 of 75 |
| isotonic | 0.086 ± 0.038 | **0.030** | 0.159 | 0.811 | yes | 9 of 75 |
| temperature | 0.264 ± 0.024 | 0.264 | 0.228 | 0.792 | yes | 75 of 75 |

Both Platt and isotonic clear H3's 0.1 bar on held-out data. The Brier score
drops with the ECE (0.242 to 0.159), which is what rules out the cheap way to
win: a map that bought calibration by flattening everything towards the base
rate would improve ECE and leave Brier alone or worse.

**Temperature barely moves.** It has a slope and no intercept, so it can only
sharpen or flatten around 0.5. That it fails while Platt succeeds IS the
diagnosis: Jev's problem is not overconfidence in shape, it is a shift. The
fitted Platt map is `a = 0.952, b = −1.646` — a slope of essentially 1 and an
intercept doing all the work. Jev's log-odds are about 1.65 too high, flat
across the range.

**On the AUC column.** Platt and temperature are strictly increasing, so their
AUC matches the raw one to the last digit: the map moved the probabilities and
reordered nothing, and H1's recall at a rank cut is untouched. Isotonic is only
non-decreasing — it POOLS adjacent probabilities into one value (75 distinct
raw probabilities become 9), and a losing pair that becomes a tie counts as
half a win, so its AUC comes out *higher* at 0.811 without a single inversion.
That is not an improvement in judgment and it is not free either: findings that
share a calibrated value can no longer be separated by any threshold
downstream. The study checks the order directly rather than trusting AUC
equality.

### Cross-set: does the map travel?

| Method | Fitted on | Scored on | N | ECE | Brier |
|---|---|---|---|---|---|
| none | H1b | thorough | 246 | 0.504 | 0.341 |
| none | thorough | H1b | 209 | 0.284 | 0.242 |
| platt | H1b | thorough | 246 | 0.216 | 0.103 |
| platt | thorough | H1b | 209 | 0.233 | 0.240 |
| isotonic | H1b | thorough | 246 | 0.221 | 0.109 |
| isotonic | thorough | H1b | 209 | 0.233 | 0.239 |
| temperature | H1b | thorough | 246 | 0.489 | 0.282 |
| temperature | thorough | H1b | 209 | 0.237 | 0.250 |

It travels halfway. Platt fitted on H1b cuts the thorough set's ECE from 0.504
to 0.216 and its Brier from 0.341 to 0.103 — a large improvement, and still
double the 0.1 bar. The reason is not subtle: the base rates are 0.263 and
0.028. An intercept fitted against one base rate is the wrong intercept for the
other, and an intercept is exactly what this map is.

### Reliability, before and after (H1b, 10 bins)

| Bin | Before: mean predicted | Before: observed | N | After (out-of-fold Platt): mean predicted | After: observed | N |
|---|---|---|---|---|---|---|
| 0.0–0.1 | 0.076 | 0.000 | 5 | 0.052 | 0.014 | 70 |
| 0.1–0.2 | 0.158 | 0.000 | 32 | 0.145 | 0.310 | 29 |
| 0.2–0.3 | 0.240 | 0.048 | 21 | 0.254 | 0.208 | 24 |
| 0.3–0.4 | 0.342 | 0.000 | 16 | 0.347 | 0.360 | 25 |
| 0.4–0.5 | 0.434 | 0.267 | 15 | 0.443 | 0.520 | 25 |
| 0.5–0.6 | 0.546 | 0.417 | 12 | 0.553 | 0.545 | 22 |
| 0.6–0.7 | 0.651 | 0.238 | 21 | 0.660 | 0.385 | 13 |
| 0.7–0.8 | 0.748 | 0.333 | 30 | 0.721 | 1.000 | 1 |
| 0.8–0.9 | 0.849 | 0.533 | 45 | — | — | 0 |
| 0.9–1.0 | 0.918 | 0.500 | 12 | — | — | 0 |

The "before" column is the whole finding in one table: Jev puts 57 findings
above 0.8 and barely half of them are real, while the bin it labels 0.3–0.4
contains no real defects at all. After the map, the mass moves down to where
the evidence is, and predicted tracks observed within roughly 0.1 in the
populated bins.

### Verdict

**H3 post-hoc: FAIL.** The bar the study sets is pooled held-out ECE < 0.1 on
the H1b set AND cross-set ECE < 0.15. The first is met (Platt 0.071, isotonic
0.030); the second is not (0.216). What can be said honestly:

- A post-hoc map fixes the scale **on the distribution it was fitted on**, and
  it does so without touching the ranking. H3's own bar is clearable that way.
- It does **not** transfer across distributions with different base rates. A
  map shipped with Jevest and applied to somebody else's repo would be a guess.
- SPEC §4.2's H3, which is about Jev's RAW output, stays **FAIL**. Nothing here
  changes that.

**What shipped.** `findingFilter.calibration` (default `"none"`, i.e. the
identity), `findingFilter.calibrationPath` (default `.jevest/calibration.json`,
read from the PR's base commit like `.jevest/context.yml`), and Jevest's own
fitted map at `config/calibration/is_real_defect.json` with its caveats in
`config/calibration/README.md`. Turned on, stage 4 maps `is_real_defect` before
computing the band and the predicted-real cut, keeps Jev's raw answer on the
record as `rawIsRealDefectProb`, and the summary comment shows both. **The
default is off, and this study is the reason.**

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

H1, H6 and H3 ran on 2026-09-22 (see "Thorough findings pass and finding
filter" above) and were re-scored the same day against the fix-aware oracle
label (see "Re-scored against the fix-aware oracle label" above): H1 FAIL
(formally — n=7 real is too small to clear the recall bar), H6 PASS, H3 FAIL.
H1b (see "H1b — reversed hunks" above) ran on 2026-09-23 on a reversed-hunk
dataset with a real-finding population of 55: H1 now **PASS** (recall 0.964,
51.9% of noise discarded), H6 **PASS** again (704.7×), H3 stays **FAIL**
(ECE 0.284). The post-hoc calibration study (2026-09-23, see "Post-hoc
calibration study" above) closed H3 as far as it can be closed for now: a
fitted map reaches a held-out ECE of 0.071 on the set it was fitted on and
0.216 on a set with a different base rate, so the feature ships off by default
and H3 stays FAIL. What remains below is H7's harder near-duplicate variant,
H5's suite (already recorded, see below), and the H2/H4 real-PR collection.

| Hypothesis | What will fill the row | Command |
|---|---|---|
| H7 · intent–change coherence (recall ≥ 0.90, precision ≥ 0.85, ECE < 0.1) | full 200-pair run, both variants | `pnpm coherence:summarize --mode record` then `pnpm coherence --mode record`; replay with `pnpm coherence --mode replay` |
| H7 hard · near-duplicate crossed pairs (same criteria, harder negative — see datasets/README.md §4b) | full 200-pair run over `coherence-pairs-hard.jsonl`, both variants; numbers pending | `pnpm dataset:pairs --strategy hard --out datasets/coherence-pairs-hard.jsonl` (already generated, no network) then `TYPESAFE_API_KEY=… pnpm coherence --pairs datasets/coherence-pairs-hard.jsonl --mode record`; replay with `pnpm coherence --pairs datasets/coherence-pairs-hard.jsonl --mode replay` |
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
in datasets/README.md) and none of them appears among the worst pairs. The
harder near-duplicate half (`coherence-pairs-hard.jsonl`, generated, not yet
run against live Jev — see the "H7 hard" row above and datasets/README.md
§4b) crosses each PR with its most-similar same-repo PR by change footprint
instead of a random one.

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

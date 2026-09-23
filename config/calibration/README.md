# Calibration maps for `is_real_defect`

`is_real_defect.json` is the post-hoc calibration map Jevest fitted on ITS OWN
labeled findings. It is published so a consumer can look at one, copy it as a
starting point, and — this is the important part — replace it with one fitted
on their own data.

It is not a default. `findingFilter.calibration` defaults to `none`, and
nothing in the pipeline reads this file unless a repo explicitly opts in with
`findingFilter.calibration: file` and puts a map at
`findingFilter.calibrationPath` (default `.jevest/calibration.json`, read from
the PR's base commit).

## What the map is for

H3 (docs/SPEC.md §4.2) asks whether Jev's `is_real_defect` probability means
what it says. Measured, it does not: over the H1b reversed set the answers
average around 0.6 while 26.3% of those findings are real defects — an ECE of
0.284. The ranking is fine (AUC 0.792, which is what H1's recall rides on); the
NUMBER is inflated. That matters because the thresholds in `.jevest.yml` are
read against that number.

A calibration map is a monotone function applied to the probability before the
band and the predicted-real cut. It cannot make Jev a better judge — it
reorders nothing — it only makes the scale honest.

## This map

| Field | Value |
|---|---|
| Method | Platt, `sigmoid(a · logit(p) + b)` with a = 0.952, b = −1.646 |
| Fitted on | `datasets/findings-reversed-oracle.jsonl`, 209 oracle-labeled findings (55 real / 154 noise) |
| Fitted at | 2026-09-23 |
| Base rate of the fitting set | 0.263 |
| Raw ECE before | 0.284 |
| Held-out ECE (5-fold, stratified, pooled out-of-fold) | 0.071 |
| Held-out Brier | 0.159 |
| Cross-set ECE (scored on `findings-thorough-oracle`) | 0.216 |
| Study verdict | **H3 FAIL** — the held-out bar is cleared, the cross-set bar is not |

The slope is almost exactly 1 and the intercept does nearly all the work. That
is the whole diagnosis in two numbers: Jev is not badly shaped, it is shifted.
Its log-odds are about 1.65 too high across the board, which is why the
`temperature` method — a slope with no intercept — barely moved the ECE at all
(0.284 to 0.264).

Reproduce with `pnpm calibrate` (replay only, no API calls, no cost). The full
tables are in docs/BENCHMARK.md, section "Post-hoc calibration study".

## Caveats — read these before copying the file

1. **It did not generalize.** Fitted on the reversed set and scored on the
   thorough set, the same map carries an ECE of 0.216. That is far better than
   the 0.504 those raw probabilities had, and still nowhere near the 0.1 H3
   asks for. The two sets have base rates of 0.263 and 0.028; an intercept
   fitted against one base rate is simply wrong against the other. **A map
   fitted on somebody else's findings is not calibrated for yours.**
2. **The fitting set is artificial.** `findings-reversed-oracle` is the H1b
   reversed-hunk dataset (datasets/FINDINGS.md §11): defect hunks with the diff
   turned around, so the bug is being introduced rather than fixed. It exists
   to give H1 a recall population, and it is not a sample of real pull
   requests.
3. **n = 55 real findings.** Both parameters rest on those 55. The per-fold ECE
   spread (0.150 ± 0.034) is the honest picture of how much that wobbles.
4. **The oracle label came from an LLM.** The ground truth is `label.oracle`,
   written by the fix-aware labeler (datasets/FINDINGS.md §10), not by a human.

## Fitting your own

Label a few hundred of your own findings, then:

```
pnpm calibrate --set my-findings.jsonl:my-hunks.jsonl --emit .jevest/calibration.json
```

and set in `.jevest.yml`:

```yaml
findingFilter:
  calibration: file
  calibrationPath: .jevest/calibration.json
```

The CLI exits 2 when the verdict is FAIL, so it can gate a job. Two hundred
labeled findings is the floor SPEC §4.2 sets for an ECE to mean anything; below
that the number is indicative, and the study says so.

## File format

```json
{
  "version": 1,
  "question": "is_real_defect",
  "map": { "method": "platt", "a": 0.95, "b": -1.65 },
  "meta": { "source": "...", "fittedAt": "..." }
}
```

`map.method` is one of `none`, `platt` (`a`, `b`), `temperature` (`t`) or
`isotonic` (`knots`, a list of `{x, y}` with strictly increasing `x` and
non-decreasing `y`). `meta` is free-form documentation and is never read by the
pipeline. The schema lives in `src/domain/calibration.ts`; an invalid file
fails the run naming the path, it never silently degrades to the identity.

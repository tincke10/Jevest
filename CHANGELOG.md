# Changelog

All notable changes to Jevest are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). How a release is cut, and which
tags consumers should pin, is in [docs/RELEASING.md](docs/RELEASING.md).

## [0.1.0] - unreleased

First tagged release. Everything below exists on `main` today; nothing here
has been published under a version tag before.

### Added

- **Six-stage review pipeline** (`src/application/pipeline/`): triage,
  hunk profile, LLM review, finding filter, merge gate, publish. Jev answers
  recognition questions at every stage (one item per request, NFR-14); the
  LLM only writes findings. Confidence bands per stage and risk level pick
  the action (`auto` / `confirm` / `escalate`). Fails closed on any Jev
  failure (NFR-2). A critical finding is never discarded for low confidence
  (FR-5.4). The merge gate only ever emits a check conclusion; no merge call
  exists (FR-6.4).
- **Untrusted PR text** (NFR-7): `contains_injected_instructions` asked in
  triage and propagated to the merge gate, which fails when it is high
  (FR-6.3). Secrets in a hunk mark it as skipped and it is never sent to Jev
  or the LLM (NFR-3); the PR body is redacted before triage.
- **In-diff injection detection** (NFR-7, from the H5 record run): the
  hunk-profile stage asks `contains_reviewer_instructions` of every hunk,
  from its own pipeline question set (`hunk-profile-questions.ts`; the
  spike's set is untouched). The per-hunk probabilities fold in code into
  one verdict (max probability, flagged hunks) that reaches the merge gate
  as the word `injected_instructions_in_diff` (`yes` at P ≥ 0.5, `unclear`
  from 0.3, `no` below); `yes` fails the gate in code exactly like triage's
  injection flag. The summary comment reports both probabilities under
  Triage, and at `yes` the PR gets `jevest:injected-instructions` plus a
  "Needs human review" line naming the hunks. The adversarial suite gains
  `expect.expectInjectionInDiff` (set on `adv-code-comment` and
  `adv-string-literal`), an "Injection p (diff)" column and a separate
  "missed in-diff injections" count that does not enter the H5 verdict.
  The recorded H5 fixtures were deleted (state changed) and must be
  re-recorded; the replay gate skips until then.
- **Per-run efficiency metrics for H2 / H4** (`src/application/pipeline/run-metrics.ts`):
  every pipeline result carries `metrics` (never null): Jev request count
  per stage, latency sum / p50 / p95 / max across every Jev call of the run,
  Jev tokens and cost (H4); hunks reviewed vs skipped by reason (triage
  skip, skip-change-kind, secret, budget, spend cap, reviewer disabled),
  LLM tokens spent (review + change summary) and an estimated "tokens
  without Jev" counterfactual priced from the skipped hunks' diff size,
  with the saving in percent (H2); and the wall clock per stage from the
  pipeline's injectable `now`. The summary comment ends with an
  "Efficiency" section rendering them, excluded from the summary
  fingerprint so timing never breaks NFR-12; the Action gains the outputs
  `jev-latency-p95-ms`, `jev-requests` and `llm-tokens-saved-pct`; `pnpm
  review` prints the section and a wall-time line. The saving is an
  estimate, said so on the comment itself and in `docs/BENCHMARK.md`
  "H2 / H4 — measured per run"; no verdict on either hypothesis is claimed
  before ≥ 20 real PRs.
- **GitHub Action** (`action.yml`, `src/action/main.ts`): composite action,
  Node 20, runs the TypeScript source with `tsx` (no build). Publishes one
  upserted summary comment, fingerprinted inline comments, labels
  (`jevest:needs-human`, `jevest:auto-merge-ok`, spend labels) and a
  `jevest` check run. No `actions/checkout` needed: the PR, the diff and
  `.jevest.yml` are fetched through the API at the PR head sha.
- **Configuration** by partial override: `.jevest.yml` in the consumer repo
  is deep-merged onto `config/jevest.example.yml`, the single source of
  defaults. Unknown top-level keys fail loudly.
- **LLM reviewer providers** behind one `ReviewerPort` and one prompt:
  `anthropic`, `openai`, `deepseek` (OpenAI SDK against DeepSeek's endpoint,
  client-side schema validation, peak/off-peak pricing), `claude-cli`
  (a Claude Pro/Max subscription via `claude -p` and an OAuth token), and
  `none` (Jev-only runs, no LLM key).
- **Cost controls**: per-run `budgetUsd`, `maxHunks`, and a cumulative
  `spendCap` (per month or total) whose ledger is an issue in the consumer
  repo; reaching the cap turns runs Jev-only with a warning label.
- **Local CLI** `pnpm review --diff <file> | --git <base>..<head>` running
  the same six stages over a local diff and writing `review.md`/`review.json`.
- **Ports and adapters** (hexagonal, zero SDK imports in the domain):
  decision (TypeSafe, fake, recorded), reviewer (five providers plus
  recorded), change summarizer (claude-cli, fake, recorded), spend ledger
  (GitHub issue, local file, fake), VCS (GitHub, local diff, in-memory).
- **Datasets** under `datasets/` with their provenance documented in
  `datasets/README.md`: `hunks.jsonl` (100 labeled hunks, v2),
  `profile-labels.jsonl` (AST-derived surface labels), `findings.jsonl`
  (LLM findings with line-overlap labels), `prs.jsonl` (100 merged OSS PRs)
  and `coherence-pairs.jsonl` (200 pairs with exact labels), plus the
  hand-written H5 cases in `datasets/adversarial/`.
- **Spikes with recorded fixtures**, each with a CLI, a Markdown/JSON report
  in `reports/` and `live|record|replay|dry-run` modes: H0 defect detection
  (`pnpm spike`, FAIL, closed), H0′ surface profile (`pnpm spike:profile`,
  PARTIAL), H1/H6/H3 finding filter and LLM-judge baseline (`pnpm filter`),
  findings generation (`pnpm findings`), H7 intent–change coherence
  (`pnpm dataset:prs`, `pnpm coherence:summarize`, `pnpm coherence`).
  Consolidated in `docs/BENCHMARK.md`.
- **Thorough reviewer prompt and LLM-judge baseline**
  (`pnpm findings --prompt thorough`, `FindingJudgePort` with `deepseek` and
  `claude-cli` adapters): the thorough prompt produces a noise-heavy
  evaluation set (`datasets/findings-thorough.jsonl`, 299 findings, 137
  real / 162 noise) so H1's "≥ 40% noise discarded" and H3's "≥ 200
  findings" bars are measurable; the judge scores the same set at Jev's
  best threshold with the same per-finding state. `pnpm filter` now reports
  H1 (recall / noise-discard), H6 (judge cost and recall vs. Jev) and H3
  (calibration ECE) verdicts alongside the existing metrics.
- **Adversarial suite (H5)**: `datasets/adversarial/` (14 cases across 13
  attack families plus a benign control), `pnpm adversarial` with the four
  modes, a report with the H5 verdict, and a vitest regression test that
  replays recorded fixtures and is skipped until they exist.
- **Documentation**: `README.md`, `docs/SPEC.md` (design, hypotheses,
  decision log), `docs/ACTION.md` (install, secrets, permissions, security
  notes), `docs/analysis/` (error analyses), `docs/BENCHMARK.md`,
  `docs/RELEASING.md`.
- **Triage v2, product-aware (H7 adopted)**: triage now sees the H7
  three-layer state (the author's intent, change facts computed from
  paths, and an LLM summary of the diff written without the description)
  plus a `product` section from `.jevest/context.yml`, and asks
  `matches_intent`, `needs_product_owner`, `user_facing` and `breaking`
  next to the existing questions, still in one Jev request. The product
  context file (schema in `src/application/context/product-context.ts`,
  example in `config/context.example.yml`) is always read from the PR's
  base sha; its areas raise the effective risk to their criticality and
  their rules reach Jev verbatim. New config block `triage:` with
  `productContextPath` and `changeSummary: auto | always | never`. New
  summarizer adapters for `anthropic`, `openai` and `deepseek` next to
  the existing `claude-cli` one, built from the reviewer's provider and
  secret. The merge gate state gains `description_matches_change` and
  `product_areas_touched`. The summary comment gains an "Intent vs
  change" section and a "Change summary cost" line; the summary's cost
  counts against `budgetUsd` and the spend ledger. New labels
  `jevest:description-mismatch` (P(matches_intent) < 0.35 in the auto or
  confirm band; in the auto band a green check becomes neutral) and
  `jevest:needs-product-owner`. A summarizer failure never fails the run:
  triage falls back to the without-summary arm and the comment says so.
  Dependency added: `picomatch` (zero transitive dependencies).
- **Fix-aware oracle label for findings** (`pnpm dataset:evidence` collects
  the issue/PR text behind each fix into `hunk-evidence.jsonl`; `pnpm
  findings:label --labeler deepseek --mode record|replay|dry-run
  [--max-tokens N]` labels a findings file against it, two framings with
  agreement required, writing `label.oracle` alongside the existing
  line-overlap label; `pnpm filter --label oracle` re-scores H1/H6/H3
  against it at zero extra cost). `--max-tokens` raises DeepSeek's
  reasoning cap past the 8192 default for findings whose labeling was
  truncated. Non-circular by construction: the labeler sees the real fix,
  the commit message and the linked issue/PR, none of which the reviewer,
  Jev or the judge ever saw. Design, weaknesses and the 2026-09-22 run:
  `datasets/FINDINGS.md` §10.
- **Reversed-hunk dataset for H1b** (`pnpm dataset:reverse` →
  `datasets/hunks-reversed.jsonl`: the 50 defect hunks with their diff
  reversed after → before, so the change under review introduces the bug
  instead of fixing it, plus the 50 benign hunks unchanged; pure local
  computation, no network, no LLM, no cost). `--hunks <file>` added to
  `pnpm findings`, `pnpm findings:label` and `pnpm filter` so the reviewer,
  oracle labeler and scorer can all run against a hunk file other than the
  default. A `claude-cli` oracle labeler adapter next to the existing
  DeepSeek one, so the fix-aware label can be produced on the Claude
  subscription instead of a metered API; the oracle fixture key now mixes
  in which labeler answered. Built to give H1's fix-aware oracle a
  real-finding population large enough for a recall verdict — the original
  oracle sample had only 7. Design and the 2026-09-23 run:
  `datasets/FINDINGS.md` §11, `datasets/README.md` § hunks-reversed,
  `docs/BENCHMARK.md` "H1b — reversed hunks".

### Changed

- Batch size defaults to 1 everywhere a spike used to batch items into one
  Jev request: batching anchors the answers to each other
  (`docs/analysis/h0-prime-error-analysis.md`, NFR-14).
- AST profile labels are computed on changed lines only (labels v2).
- Stage 4 (finding filter) no longer discards findings by default
  (`findingFilter.mode: "annotate"`, product decision 2026-09-22): a
  low-confidence finding is now kept in a `lowConfidence` bucket, shown in
  a collapsed summary-comment section instead of being dropped, until H1
  has a valid verdict; the original discard behavior is available via
  `findingFilter.mode: "discard"`.

### Known limitations

- H1 (2026-09-22, `reports/filter-2026-09-22T14-36-07-230Z.md`): **FAIL**
  on the current line-overlap labels (recall 0.920, noise discarded
  0.173) and inconclusive on the question it asks — a DeepSeek LLM-judge
  control scored AUC 0.567 on the same labels Jev scores 0.592 on, both
  near chance, so neither separates real defects from noise under the
  current label. H6: **PASS** (188.9× cheaper than the judge, recall gap
  0.035). H3: **FAIL** (ECE 0.191 over N=299, same label caveat as H1).
  Re-scored the same day against a fix-aware oracle label instead of a
  human-labeled sample (`reports/filter-2026-09-22T16-58-00-234Z.md`): AUC
  rises to 0.708 (Jev) and 0.700 (judge), confirming the label carries
  real signal, but only 7 of 299 findings are confirmed real, too few for
  a recall verdict, so H1 stayed **FAIL formally** and H3 **FAIL**
  (ECE 0.504); H6 **PASS** stood (182×). H1b, a reversed-hunk dataset built
  to give that oracle label a real-finding population, ran on 2026-09-23 on
  the Claude subscription (`reports/filter-2026-09-23T00-14-31-744Z.md`,
  55 real / 154 noise): H1 **PASS** (recall 0.964, 51.9% of noise discarded
  at threshold 0.45, AUC 0.792), H6 **PASS** again (704.7× cheaper), H3
  still **FAIL** (ECE 0.284, base rate 0.263). Caveats: n=55 gives the
  recall a wide confidence interval, the oracle labeler and the H6 judge
  share a model, and the reversed diff is an artificial change that rarely
  matches a real PR. Stage 4 stays in `annotate` mode by default: H1b gives
  H1 a verdict, but flipping the default to `discard` is a separate,
  still-pending product decision, gated on a run over real PRs. See
  `docs/BENCHMARK.md` "H1b — reversed hunks". H0 failed and is closed; H7
  passed with an LLM diff summary (partial without one).
- `touches_public_api` is derived by AST only for TypeScript/JavaScript and
  Vue `<script>` blocks; other languages get the Jev questions on the raw
  diff but no AST labels.
- The redactor (`src/domain/redact.ts`) is deliberately over-eager: any
  `key`/`token`/`secret`/`password` identifier followed by `=` or `:` marks
  the hunk as containing a secret, so the hunk is skipped from review.

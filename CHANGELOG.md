# Changelog

All notable changes to Jevest are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). How a release is cut, and which
tags consumers should pin, is in [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Added

- **Eval harness** (docs/EVAL.md): measures a review variant against a
  golden set of adjudicated PRs before it ships. `pnpm eval:review` runs a
  pipeline variant per case (the local `pnpm review` flow, now importable
  as `runLocalReview`, with a config plus `--overrides`/`--override
  key=value`, in live, replay or dry-run mode; never posts to GitHub) or
  imports another review's findings, matches every finding to a golden
  issue (a deterministic pre-filter, then a new `FindingMatcherPort` with a
  claude-cli adapter on `claude-sonnet-5` and an on-disk decision cache),
  and writes `results.json` and a report: recall weighted and unweighted
  for what was shown and for shown + low-confidence, real issues found by
  severity, known-false noise shown, unlabeled findings, a precision lower
  bound, cost, tokens and wall time. `pnpm eval:compare` puts runs side by
  side, `pnpm eval:label-queue` exports unlabeled findings to adjudicate,
  and `pnpm eval:import-adjudication` builds a set from adjudication files
  with merge-base SHAs and resolved locations. Client sets stay outside the
  repo (`~/.jevest/evals/`).
- **Author context from the PR description** (`reviewer.descriptionContext`):
  the per-hunk reviewer now takes the PR description into account — design
  decisions, intended behavior changes, what is out of scope, constraints
  and business rules, linked tickets — without letting it steer the review.
  Three layers: (1) when triage flags injected instructions in the
  description, nothing from it reaches the reviewer; (2) one extra LLM call
  per PR (new `DescriptionContextPort`, claude-cli, anthropic, openai and
  deepseek adapters and a fake, using the reviewer's provider, model and
  credential) keeps only review-relevant items and discards every sentence
  that tries to skip or steer the review or asserts quality ("no review
  needed", "already tested", "ignore file X", "LGTM"), followed by a
  deterministic Spanish/English post-filter and size caps; (3) the reviewer
  prompt treats the kept items as untrusted, intent-only context that can
  never dismiss or soften a finding, and a contradiction between the code
  and a stated decision is itself a finding. The narrator gets the kept
  items instead of the raw description. The comment lists what was kept and
  discarded inside "Jevest details", plus one visible line in
  `reviewer.language` when something was discarded. Its cost counts against
  `budgetUsd`, the spend ledger and `cost-usd`; an extractor error never
  fails the run. Without author context the reviewer request is
  byte-identical to before, so recorded fixtures keep their keys. On by
  default for any LLM provider, off for `provider: none`.
- **Colleague review** (`reviewer.narrative`, `reviewer.language`): one extra
  LLM call per PR, after the finding filter, writes the top of the summary
  comment as a senior colleague would — an overall take, each point tied to
  `file:line` with what to change and why, and a verdict line that agrees
  with the `jevest` check — in the configured language (`es` by default).
  New `ReviewNarratorPort` with claude-cli, anthropic, openai and deepseek
  adapters and a fake, using the reviewer's provider, model and credential.
  The narrator only phrases what Jev kept: it gets the published and
  needs-human findings (the latter phrased as questions), never the
  low-confidence or discarded ones, and its prompt forbids raising anything
  else. The rest of the report moves into one collapsed "Jevest details"
  block, with the "LLM review failed" warning kept visible. Its cost counts
  against `budgetUsd`, the spend ledger and `cost-usd`. A narrator failure
  never fails the run: the comment falls back to the full report with a
  one-line note. The summary fingerprint still covers only the deterministic
  report, so a reworded narrative is not a new review (NFR-12). On by
  default for any LLM provider, off for `provider: none`.

- **Hard crossing strategy for H7** (docs/SPEC.md §4.4, docs/BENCHMARK.md "H7
  hard"): `pnpm dataset:pairs --strategy hard` builds
  `coherence-pairs-hard.jsonl` by crossing each PR with the most similar
  same-repo PR by directory Jaccard instead of a random donor (seed 42, donor
  reuse capped at 2), a harder near-duplicate negative for H7. `pnpm coherence
  --pairs <file>` runs the coherence spike over any pairs file, record or
  replay. Measured against live Jev on 2026-09-23 (400 requests): with-summary
  recall 0.970, precision 1.000, ECE 0.082 (**PASS**); without-summary recall
  0.830, precision 0.830, ECE 0.178 (**PARTIAL**) — near-duplicate donors cost
  2 points of recall with the LLM summary and 5 without it.
- **Post-hoc calibration of `is_real_defect`** (H3, docs/SPEC.md §4.6.3,
  docs/BENCHMARK.md "Post-hoc calibration study"), **off by default**. New
  `pnpm calibrate` CLI fits and cross-validates four monotone maps (identity,
  Platt, isotonic/PAV, temperature) over oracle-labeled findings sets, all from
  replayed Jev fixtures at zero cost, and reports held-out ECE (5-fold,
  stratified, mean ± sd and pooled out-of-fold), Brier, AUC and cross-set
  generalization, with reliability tables before and after. Exit code 2 on a
  FAIL verdict, like `pnpm filter`. Stage 4 can apply a fitted map to
  `is_real_defect` before computing the confidence band and the predicted-real
  cut, via `findingFilter.calibration` (`none` by default, or `file`) and
  `findingFilter.calibrationPath` (default `.jevest/calibration.json`, read
  from the PR's base commit like `.jevest/context.yml`); Jev's raw answer is
  kept on every finding as `rawIsRealDefectProb`, and the summary comment shows
  both. Jevest's own fitted map ships at
  `config/calibration/is_real_defect.json` with its caveats in
  `config/calibration/README.md` — as a worked example to copy, not as a
  default. **H3 remains FAIL**: the map reaches a held-out ECE of 0.071 on the
  set it was fitted on (from 0.284 raw) with the ranking untouched, but carries
  0.216 to a set whose base rate is ten times lower.

### Changed

- **BREAKING: the `jevest` check and labels now say what to do, not whether
  the PR may auto-merge.** Every run ends in ONE review verdict
  (src/domain/review-verdict.ts): `fix` (at least one published finding;
  check `failure`, the only red), `questions` (doubts or an auto-band
  description mismatch; `neutral`), `clear` (nothing to fix; `success`) or
  `unavailable` (every reviewer call failed, the spend cap skipped the
  review, or instructions to a reviewer were suspected; `neutral`). Before,
  the check carried the merge gate's conclusion, so a PR with zero
  findings and zero doubts could go red just for not being safe to
  auto-merge. The merge gate now only decides `jevest:auto-merge-ok`,
  which additionally requires a `clear` verdict. Kept as they were: the
  NFR-2 fail-closed exit still publishes a red check; a suspected
  injection or an auto-band description mismatch can never produce a
  green check; Jev-only mode and triage's low-risk skip are `clear` when
  Jev flagged nothing.
- **BREAKING: `jevest:needs-human` is gone.** It was on nearly every PR and
  said nothing. It is replaced by exactly one verdict label per run, created
  with a color and a description and localized by `reviewer.language`:
  `jevest: corregir antes de mergear` / `jevest: fix before merge`,
  `jevest: responder dudas` / `jevest: answer questions`,
  `jevest: listo para aprobar` / `jevest: ready to approve`,
  `jevest: revisar a mano` / `jevest: review manually`; plus a risk label
  (`riesgo: alto` / `risk: high` for high and critical, `riesgo: medio` /
  `risk: medium`). Every run removes the other verdict labels and the
  legacy `jevest:needs-human`, so open PRs migrate on their next run.
  **Anyone filtering PRs, issues or automations on `jevest:needs-human`
  must switch to the new labels.** Triage's needs-human signal (FR-2.4) is
  still reported in the summary comment.
- The check title and summary are action-oriented and localized (es by
  default, en for any other language), e.g. "Corregir 2 problemas antes de
  mergear" or "Nothing to fix", instead of "Jevest: failure".
- The colleague review's closing line is the check title word for word,
  taken from the same verdict function, so a review with nothing to flag
  can no longer end with "needs changes". `ReviewNarrativeInput.verdict` is
  now the review verdict and gains `verdictLine`.
- The summary comment's "Needs human review" section is now "Questions and
  manual checks", and the merge gate line says it only decides
  `jevest:auto-merge-ok`.
- The GitHub adapter creates missing labels with their color and
  description (`ReviewPublication.labelDefinitions`), leaves existing
  labels untouched, and tolerates a 422 when another run created the label
  first.
- `fail-on: failure` now fails the job on a `fix` verdict (or a fail-closed
  run), not on the merge gate's conclusion.
- **A hunk with a detected secret is reviewed, not skipped (NFR-3).** Its
  `diff` and `before` are redacted in the hunk-profile stage before Jev
  sees them, and every later stage (reviewer, narrator) only gets that
  redacted text, so it is profiled and reviewed like any other hunk. The
  summary comment replaces the collapsed "skipped — hunk contains a
  redacted secret" line with a visible warning near the top, localized by
  `reviewer.language` ("⚠️ Posible secreto commiteado en `file` (hunk):
  revisá y rotalo si es real." / "⚠️ Possible committed secret in `file`
  (hunk): check it and rotate it if it is real."), a line in "Questions and
  manual checks" and in the check summary; each flagged hunk counts as one
  question, so the verdict is at least `questions` (a published finding
  still makes it `fix`). `secret` is gone from the Efficiency skip reasons
  and from `metrics.llm.hunks.skipped`; `metrics.llm.hunks.withSecret`
  counts the flagged hunks and the Efficiency line says "N with a redacted
  secret".

### Fixed

- **A readable dummy password in a test file raised the "possible committed
  secret" warning**: a test payload like `'password' => 'Some-pass-123'`
  was enough. Redacting and warning are now two decisions. The redaction
  sent out stays as aggressive as before (NFR-3), but a password/secret
  name only warns when its value is long and varied enough to be a real
  credential (12+ characters with entropy ≥ 3.0 bits/char, or with upper,
  lower, digit and symbol all present), and in a test file (`tests/`,
  `test/`, `__tests__/`, `spec/`, `fixtures/`, `e2e/`, `*.test.*`,
  `*.spec.*`) a value made of readable words joined by `-`/`_` is a
  placeholder. `redact()` takes an optional `{ path }` and reports the
  warning-worthy count as `secrets`; hunk-profile passes the hunk's file.
  Known token formats, PEM blocks and key/token names warn as before.
- **The secret redactor flagged ordinary code and hid it from review**: any
  `name = value` / `name: value` whose name contained key, token, secret or
  password counted as a secret whatever the value, and `key === prev` even
  read as an assignment. On 6 real PRs it skipped key hunks in 5 of them
  (cache keys, CSRF lookups, `'key' => 'EUR'` maps, arrow functions), every
  hit a false positive, and defects in those hunks were missed. A named
  assignment now counts only when the VALUE looks like a literal
  credential: comparisons, arrows and code expressions (calls, variables,
  member references, interpolation, concatenation, cache-key shapes) never
  count; a quoted literal or an `.env` line counts at 8+ characters for
  password/secret names and 16+ for key/token names, which must also look
  random (entropy ≥ 3.0 bits/char or letters and digits over 20
  characters, not a word slug); placeholders (example, dummy, changeme,
  `<…>`, `***`, …) never count; and names like `cacheKey`, `csrfToken`,
  `tokenType`, `primaryKey` or `storageKey` are not secret names. Known
  formats still count wherever they appear, now also Anthropic `sk-ant-`,
  OpenAI `sk-proj-`, Stripe `sk_live_`/`rk_live_`, Google `AIza…`, JWTs
  and long `Bearer` tokens; a PEM block is redacted line by line, so a
  redacted hunk keeps its line numbers.
- **Unredacted text could reach an external LLM (NFR-3)**: the change
  summarizer got the raw patches, the narrator the raw title and
  description, the description-context extractor and Jev's triage the raw
  title, and a hunk's `before` context went to the reviewer unredacted.
  All of them now get redacted text.
- **Reviewer errors rendered as walls of JSON**: claude-cli failures embed the
  raw stdout envelope (with per-call values like `duration_ms`), so the
  "LLM review failed" section repeated the same 401 once per hunk. Errors are
  now cleaned to their human part (`result:` text, no stdout/stderr dumps,
  200 chars max) and deduplicated into one bullet listing each affected file
  once (6 shown, then "+N more"); the summarizer-failure line gets the same
  cleaning. An authentication failure adds one line saying which credential
  to renew. The raw error is still written to the action log.
- **A run whose LLM review failed entirely could be marked safe to merge**:
  when every attempted reviewer call threw (e.g. a 401 from an expired
  token), Jev's merge gate saw zero findings and could return green, and
  `jevest:auto-merge-ok` was applied. Per NFR-2 the check is now at most
  `neutral` in that case, the auto-merge label is never applied, and the PR
  gets `jevest:needs-human` plus a line in "Needs human review". A partial
  failure keeps the gate's conclusion and the existing warning.
- **`config-path` read Jevest's own `.jevest.yml`** in a workflow without
  checkout: the action step runs in `github.action_path`, so the relative path
  found Jevest's dogfood config (`reviewer.provider: none`) and the consumer's
  file was never fetched. A relative `config-path` now resolves against
  `GITHUB_WORKSPACE`, falling through to the PR base sha via the API as
  documented.

## [0.1.0] - 2026-09-23

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

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

### Changed

- Batch size defaults to 1 everywhere a spike used to batch items into one
  Jev request: batching anchors the answers to each other
  (`docs/analysis/h0-prime-error-analysis.md`, NFR-14).
- AST profile labels are computed on changed lines only (labels v2).

### Known limitations

- H1 (the finding filter, the central hypothesis), H6 (cost vs. an LLM
  judge), H3 (calibration) and H7 (coherence) have no verdict yet; H0 failed
  and is closed. See `docs/BENCHMARK.md` for what is measured and what is
  pending.
- `touches_public_api` is derived by AST only for TypeScript/JavaScript and
  Vue `<script>` blocks; other languages get the Jev questions on the raw
  diff but no AST labels.
- The redactor (`src/domain/redact.ts`) is deliberately over-eager: any
  `key`/`token`/`secret`/`password` identifier followed by `=` or `:` marks
  the hunk as containing a secret, so the hunk is skipped from review.

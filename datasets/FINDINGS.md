# `findings.jsonl` — Phase 1a findings dataset (dataset_version 2)

Seed dataset for hypothesis **H1** (docs/SPEC.md §4.2, §5 "Fase 1a"): does a
Jev-style filter recover real defects from an LLM reviewer's findings while
discarding noise? This file records the LLM reviewer's raw findings over the
100 hunks in `datasets/hunks.jsonl`, each automatically labeled *real* or
*noise* by line-overlap with the fix. **This is a seed, not final ground
truth** — every record carries `"needs_manual_review": true`, and SPEC §5
step 2 calls for manual verification of a 40-record sample before H1 numbers
are reported anywhere final.

## 1. Schema

One JSON object per line:

```jsonc
{
  "id": "zod-9446b5c-1::anthropic::0",   // `${hunk_id}::${provider}::${n}`, n = 0-indexed within that hunk+provider
  "hunk_id": "zod-9446b5c-1",             // foreign key into datasets/hunks.jsonl
  "dataset_version": 2,
  "reviewer": { "provider": "anthropic" | "openai" | "claude-cli", "model": "claude-opus-5" },
  "file": "packages/zod/src/v4/core/compile.ts",
  "line_start": 1270,                     // absolute BEFORE-side line numbers,
  "line_end": 1271,                       // computed by the reviewer from hunk_header
  "claim": "one sentence naming the defect",
  "rationale": "1-3 sentences: why this is a defect",
  "suggested_severity": "nit" | "minor" | "major" | "critical",
  "label": {
    "real": true,
    "source": "line-overlap",
    "overlap_lines": 2,                   // lines in [line_start, line_end] the fix actually changed
    "fix_changed_lines": 3                // total lines the fix changed, for context
  },
  "needs_manual_review": true,
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 80,
    "cache_read_input_tokens": 900,
    "cache_creation_input_tokens": 0
  },
  "cost_usd": 0.008,
  "latency_ms": 2140,
  "billing": "api" | "subscription"        // optional; omitted means "api" (real spend).
                                            // "subscription" (claude-cli only): cost_usd is
                                            // the CLI's own nominal list-price figure, not cash.
}
```

The domain-side (camelCase) type and a loud-failing parser/serializer live in
`src/domain/finding.ts` (`FindingRecord`, `parseFindingRecordLine`,
`parseFindingRecordsJsonl`, `stringifyFindingRecord`), mirroring
`src/application/spike/hunk-record.ts` for `hunks.jsonl`.

**A hunk with zero findings contributes zero rows.** The reviewer prompt
(`src/adapters/reviewers/review-prompt.ts`) explicitly allows an empty
findings list and is instructed never to invent an issue just to have
something to say — so "no rows for this hunk" means "the reviewer found
nothing to flag," not a failure.

**`cost_usd` and `latency_ms` are per-request, not per-finding.** A hunk that
produced 2 findings has the same `cost_usd`/`latency_ms` on both rows — that's
the cost of the one reviewer call that produced both findings, not half of it
each. Sum cost/latency **once per unique `hunk_id`**, never by summing every
row, or you'll double- (or triple-) count hunks with more than one finding.
`src/application/findings/summary.ts` does this dedupe correctly; hand
analysis should too.

## 2. How the label is derived (line-overlap)

Implemented in `src/domain/line-overlap.ts`, called from
`src/application/findings/generate-findings.ts`:

1. `computeFixChangedLines(diff, hunk_header)` walks the hunk's unified diff
   and returns the set of absolute BEFORE-side line numbers the fix actually
   touched:
   - a removed (`-`) or modified line contributes its own BEFORE-side line
     number;
   - a **pure insertion** (added lines with no paired removal) contributes
     the BEFORE-side line immediately preceding the insertion point, since
     there's no removed line to anchor to and that's the closest "before"
     line the fix is attached to;
   - multi-segment diffs (more than one `@@ ... @@` block) reset the line
     counter at each header, so every segment is counted correctly.
2. `labelFinding(finding, fixChangedLines, hunkIsDefect)` counts how many
   lines in `[line_start, line_end]` are in that changed-line set
   (`overlap_lines`), and sets:
   ```
   real = hunkIsDefect && overlap_lines >= 1
   ```
   A finding on a **benign** hunk (`hunk.label.defect === false`) is *always*
   noise, regardless of overlap — line-overlap only tells you the LLM pointed
   at the right *place*, not that there was a genuine bug there; that
   judgment still rests on `hunks.jsonl`'s own (semi-automatic, seed) defect
   label.

## 3. Known weaknesses of line-overlap labeling

- **A real finding outside the fix's line range counts as noise.** If the
  reviewer correctly diagnoses the defect but reports a line range that
  doesn't overlap exactly what the fix touched (off-by-a-few-lines, or it
  points at the call site instead of the buggy line itself), line-overlap
  marks it noise even though a human would call it a hit. This inflates the
  *noise* count and depresses recall of *real* findings — the direction that
  matters for H1's recall≥0.95 bar, so it's a conservative-against-H1 bias,
  not a favorable one.
- **Coincidental overlap on a defect hunk isn't verified as the *right*
  defect.** If a defect hunk has multiple lines changed by the fix and the
  reviewer's finding overlaps one of them for an unrelated (wrong) reason,
  line-overlap still labels it `real`. This is the mirror-image risk: it can
  inflate the *real* count with findings that happen to land in the right
  place for the wrong reason.
- **`hunks.jsonl`'s own defect label is itself a seed heuristic** (commit
  message / linked issue, not a line-by-line human read — see
  `datasets/README.md` §"This is a seed, not final ground truth"). Any noise
  in that upstream label propagates directly into `real`/`noise` here.
- **Pure-insertion attribution is a judgment call, not a fact.** Anchoring an
  insertion-only fix to "the line before the insertion point" is a reasonable
  convention, but a finding on the line *after* the insertion point (equally
  defensible as "near the change") is scored as non-overlapping and thus
  noise.

These are exactly why every record is `needs_manual_review: true`, and why
SPEC §5 step 2 calls for hand-verifying 40 records before trusting an H1
verdict computed from this heuristic alone.

## 4. Reviewers

Three providers are configurable behind `src/domain/ports/reviewer-port.ts`
(SPEC §13 "Ambos proveedores", widened 2026-09-19 to a third):

- **Anthropic** (`src/adapters/reviewers/anthropic-reviewer.ts`): model
  `claude-opus-5`, structured output via `client.messages.parse()` +
  `zodOutputFormat`, `output_config.effort: "medium"`, thinking left at its
  Opus 5 default (on, adaptive), no assistant prefill, system prompt cached
  (`cache_control: { type: "ephemeral" }`) since it repeats byte-for-byte
  across all 100 hunks.
- **OpenAI** (`src/adapters/reviewers/openai-reviewer.ts`): model
  `gpt-5.6-luna` (confirmed present in the installed `openai` SDK's
  `ChatModel` type union — not a guess), structured output via
  `client.chat.completions.parse()` + `zodResponseFormat`.
- **claude-cli** (`src/adapters/reviewers/claude-cli-reviewer.ts`): shells out
  to non-interactive Claude Code (`claude -p`) instead of calling the
  Anthropic API directly, so review calls draw on a Claude Max subscription
  instead of Anthropic Console API credits — added 2026-09-19 when the
  project had a subscription but no Console credits. Anthropic's help center
  states `claude -p` in your own projects bills against the subscription;
  `ANTHROPIC_API_KEY` must be **absent** from the child process's env or it
  shadows the subscription OAuth and the call is billed as API usage
  instead. See §5 for the exact flags and why, and §6 for the run.

Both API-based providers share one prompt
(`src/adapters/reviewers/review-prompt.ts`): concrete defects only (logic,
boundary, async, error handling, type misuse), absolute BEFORE-side line
ranges, empty findings list is a valid and expected answer. claude-cli reuses
the exact same prompt and structured-output schema (via `client.messages.parse`'s
Zod schema converted to plain JSON Schema with `z.toJSONSchema`, see
`src/adapters/reviewers/review-output-schema.ts`'s `REVIEW_OUTPUT_JSON_SCHEMA`)
so the three providers are comparable.

## 4.1 claude-cli prompt-size minimization (measured 2026-09-19)

`claude -p` loads Claude Code's own default system prompt, tool schemas, and
(unless disabled) this repo's `CLAUDE.md` on every call — none of which the
reviewer prompt needs, and all of which cost tokens. Three real calls were
made on one hunk (`zod-9446b5c-1`) to measure the cheapest working flag
combination, `cache_creation_input_tokens + cache_read_input_tokens + input_tokens`
being the total tokens billed for that call:

| Combination | Total tokens | Nominal cost | Notes |
|---|---:|---:|---|
| `--disallowedTools "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent"` (baseline, + `--safe-mode`) | 11,009 | $0.1227 | tool schemas still shipped, just blocked from use |
| baseline + `--exclude-dynamic-system-prompt-sections` | 11,009 | $0.0209 (cache hit) | **no token reduction** — confirmed the CLI's own help text: "ignored with `--system-prompt`" (this adapter always sets one). The lower cost here is a same-run prompt-cache hit on the identical baseline prompt, not the flag doing anything |
| `--safe-mode` + `--tools ""` (**chosen default**) | 2,560 | $0.0357 (cache write) | `--tools ""` disables tool support outright instead of shipping-then-blocking tool schemas — **4.3x fewer tokens** than `--disallowedTools` |

**`--safe-mode` is not optional — it's a correctness fix, not just a cost
one.** A call made *without* it, with a neutral prompt and a fully custom
`--system-prompt`, still answered in this repo's own `CLAUDE.md` persona
("Hey dude... Last session left H0' partially passing...", unprompted,
referencing actual project state) — `CLAUDE.md` auto-discovery loads
regardless of `--system-prompt`. That call cost 29,742 cache-creation tokens
($0.30 nominal) for a trivial prompt; the same call with `--safe-mode` cost
1,150 tokens ($0.013) and answered cleanly with no persona bleed — a ~25x
token reduction and the actual reason `--safe-mode` is mandatory here, not
merely cheaper. `--safe-mode` was checked to still leave OAuth/subscription
auth intact (unlike `--bare`, which forces API-key-only auth and would
defeat the whole point of this adapter).

**Chosen defaults, hardcoded in `claude-cli-reviewer.ts`:** `--safe-mode`
and `--tools ""`. `--exclude-dynamic-system-prompt-sections` is omitted
(confirmed no-op with a custom `--system-prompt`).

## 5. Cost accounting

`src/application/findings/pricing.ts` has the confirmed Anthropic rate table
(current as of 2026-09-19 — verify against the provider's pricing page before
trusting these for a future run):

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| `claude-opus-5` | $5/MTok | $25/MTok | $0.50/MTok (0.1x) | $6.25/MTok (1.25x) |
| `claude-sonnet-5` | $2/MTok | $10/MTok | $0.20/MTok | $2.50/MTok |

**OpenAI's `gpt-5.6-luna` has no confirmed pricing** in any source available
for this task. Rather than guess a number, `scripts/findings/generate.ts`
reports `cost_usd: 0` for an OpenAI run and prints a loud warning. This is
consistent with the task brief: live OpenAI generation was explicitly out of
scope for this run (see §6).

`scripts/findings/generate.ts --estimate` for `anthropic` uses
`client.messages.countTokens` on a 3-hunk sample and extrapolates — see
`src/application/findings/estimate-cost.ts`. It's a **conservative upper
bound**: it prices every hunk's tokens at the full (non-cached) input rate,
ignoring the discount the real run gets from prompt-caching the repeated
system prompt, and assumes a flat 150 output tokens/hunk (output size isn't
knowable without actually calling the model). The real run should therefore
cost at or under the printed estimate, never over it.

**claude-cli is billed differently: nominal, not real, and per-call, not
per-token-table.** There's no free token-counting endpoint for `claude -p`,
so `--estimate` for `claude-cli` (`src/application/findings/estimate-claude-cli-cost.ts`)
makes 3 REAL calls (nominal subscription cost, not cash) on a stratified
sample and extrapolates the average `total_cost_usd` the CLI itself reports.
`generate-findings.ts` prefers a reviewer's own `nominalCostUsd` (set only by
claude-cli) over the token-pricing table for `cost_usd`, and marks that
record's `billing: "subscription"` (omitted — meaning `"api"`, real spend —
for Anthropic/OpenAI). **`cost_usd` on a `billing: "subscription"` record is
the CLI's own nominal list-price figure, not cash actually charged** — the
call was paid for by Claude Max subscription quota. Don't sum these records'
`cost_usd` into a real-dollars total across providers without accounting for
that distinction.

## 6. Run summary

**Anthropic and OpenAI: not run.** Neither `ANTHROPIC_API_KEY` nor
`OPENAI_API_KEY` is set in this environment, and no `ant` CLI / `ant auth
login` profile is present to resolve Anthropic credentials another way. Both
adapters are built and unit tested against fakes/injected clients only; the
CLI was smoke-tested against the real `datasets/hunks.jsonl` up to the point
where it needs a real provider client (dataset loads, `--limit` stratified
sampling runs, then it fails cleanly with a "requires credentials" message).
Per the task brief, `--provider openai` must not be run live regardless (no
confirmed pricing either, per §5).

**claude-cli: run for real, 2026-09-19.** `pnpm findings --provider
claude-cli --estimate` first (~$2.99 nominal projected for 100 hunks, well
under the $15 nominal budget), then `pnpm findings --provider claude-cli
--record --budget-usd 15` over the full dataset:

| Metric | Value |
|---|---|
| Hunks attempted | 100 / 100 (no failures, not stopped early) |
| Wall time | 453.9 s (concurrency 2) |
| Total run cost | $2.2803 nominal (Claude Max subscription quota, not cash) |
| Total findings | 14 |
| Real / noise | 9 real, 5 noise |
| By severity | nit 0, minor 11, major 3, critical 0 |
| Findings per hunk | mean 0.14; max 2 on any single hunk; 88/100 hunks had zero findings |
| % of findings on a benign hunk | 35.7% (5 of 14) |
| Latency ms p50/p95/p99 | 8994 / 24386 / 24386 |
| Cache hit share | 47.4% |

`datasets/findings.jsonl` (14 lines) and `tests/fixtures/findings/` (100
files, one per hunk) were both validated after the run: every line parses
cleanly with `parseFindingRecordLine`, every record's `reviewer.provider` is
`"claude-cli"` and `billing` is `"subscription"`, and every fixture file was
scanned for a `sessionId` key, any UUID-shaped string, `ANTHROPIC_API_KEY`,
an API-key prefix, and absolute user paths — zero matches. The 100 fixture
files' total cost ($2.28) exceeds `summarizeFindings`'s `totalCostUsd`
($0.4947 in this run) exactly as documented above: the summary only sums
cost for the 12 hunks that produced ≥1 finding, not all 100 attempted —
`generateFindings`'s own result (`totalCostUsd: 2.2803`) is the authoritative
run total.

**Read with caution, not as an H1/H6/H3 verdict**: 14 findings (12 hunks with
≥1 finding) is far short of the "≥200 findings" SPEC §4.2 calls for before
computing ECE (H3), and 9 real / 5 noise is too small a sample to estimate
H1's recall or noise-discard rate meaningfully. This run demonstrates the
claude-cli reviewer pipeline end-to-end (schema-validated structured output,
line-overlap labeling, cost/billing accounting) at low nominal cost; it is
not the dataset SPEC §5 step 5 needs for a hypothesis verdict. Anthropic and
OpenAI runs (or a larger claude-cli run) are still needed for that.

## 7. Thorough pass (2026-09-21/22): `findings-thorough.jsonl`

The strict pass above left 5 noise findings: nothing to measure a "discard
40% of the noise" bar against. SPEC §13 (2026-09-21) adds a second reviewer
prompt, `REVIEW_SYSTEM_PROMPT_THOROUGH` (`pnpm findings --prompt thorough`,
same output schema and line-number rules, deliberately low bar: report every
plausible or suspected issue, one finding per location). It exists to
produce a labeled real/noise mix for H1/H6/H3; it is **not** the production
reviewer. Records carry `reviewer.prompt_mode: "thorough"` (absent means
strict, so `findings.jsonl` is unchanged); fixtures live in
`tests/fixtures/findings-thorough/` because the fixture key hashes the
ReviewInput, not the prompt. One prompt, no revisions.

Command, run for real with claude-cli:

```
pnpm findings --provider claude-cli --prompt thorough --record --concurrency 2 \
              --budget-usd 15 --out datasets/findings-thorough.jsonl
```

| Metric | Value |
|---|---|
| Hunks attempted | 100 / 100 |
| Total findings | 299 (2.99 per hunk; strict was 0.14) |
| Real / noise | 137 real, 162 noise |
| By severity | nit 54, minor 157, major 85, critical 3 |
| % of findings on a benign hunk | 46.2% |
| Total run cost | $8.28 nominal (Claude Max subscription quota, not cash) |
| Wall time | 1454 s first attempt + 327 s resume (concurrency 2) |
| Latency ms p50/p95/p99 (per hunk) | 29570 / 68821 / 86299 |
| Cache hit share | 47.1% |

The first attempt reached all 100 hunks but 24 (mostly consecutive trpc
hunks near the end) failed with a claude-cli exit code 1 and a zero-usage
envelope; a fresh call worked minutes later, so it was a transient window.
The recorded reviewer's record mode is resumable (an existing fixture is
served from disk, the CLI is only called for what is missing), so the same
command re-run recovered the 24 hunks for $1.52 more. Two fixes came out of
it: the seam now surfaces the envelope's `result` text on a non-zero exit
instead of a 500-char stdout excerpt that cut it off, and a usage-limit
message there is classified as a rate limit and retried with backoff.

**Read as an evaluation set, not as reviewer quality.** 162 noise findings
out of 299 is exactly the point: enough noise for H1's "≥ 40% discarded"
bar and N = 299 ≥ 200 for H3's ECE. The label is still line-overlap (§2, §3
weaknesses apply, `needs_manual_review: true` everywhere).

## 8. LLM-judge baseline (H6)

`FindingJudgePort` (`src/domain/ports/finding-judge-port.ts`) answers the
same four filter questions about one finding with the same state Jev sees
(hunk diff + claim + rationale + file + lines, no label). `pnpm filter
--judge <judge> --judge-mode record|replay` runs it over the same findings
and the report scores it at Jev's best threshold: recall, precision, noise
discarded, cost, latency p50/p95, and the H6 verdict (judge cost / Jev cost
≥ 100 and judge recall − Jev recall ≤ 0.05).

- **claude-cli judge** (`tests/fixtures/filter-judge/`, 223 of 299 findings
  recorded, ~9 s and ~$0.044 nominal per call): stopped on 2026-09-22 by the
  rule that the Claude subscription is reserved for reviews. Kept for
  replay only; **do not extend it**.
- **DeepSeek judge** (`src/adapters/judges/deepseek-finding-judge.ts`,
  `tests/fixtures/filter-judge-deepseek/`, per-token billed via
  `pricingForModel`): the judge for the H6 numbers. Not yet run (no
  `DEEPSEEK_API_KEY` at the time of writing). The H1/H6/H3 command:

```
DEEPSEEK_API_KEY=... pnpm filter --findings datasets/findings-thorough.jsonl \
    --mode replay --judge deepseek --judge-mode record
```

(`--mode replay` reads the Jev fixtures under `tests/fixtures/filter/` once
the Jev side has been recorded with `--mode record`.)

## 9. Filter results (2026-09-22)

The H1/H6/H3 run against `findings-thorough.jsonl`. Report:
`reports/filter-2026-09-22T14-36-07-230Z.md`. Fixtures: Jev filter
`tests/fixtures/filter/` (299); DeepSeek judge
`tests/fixtures/filter-judge-deepseek/` (294 of 299 — 5 truncated,
reasoning exceeded the 8192-token `max_tokens`); claude-cli judge
`tests/fixtures/filter-judge/` (223 of 299, **frozen** — the Claude
subscription is reserved for reviews and this judge is not extended
further).

**Jev finding filter** (299/299 answered, one finding per request):

| Metric | Value |
|---|---|
| Best threshold (`is_real_defect`) | 0.20 |
| Precision / Recall / F1 at 0.20 | 0.485 / 0.920 / 0.635 |
| Noise discarded at 0.20 | 0.173 |
| ECE (H3) | 0.191 over N = 299 |
| AUC (real vs. noise) | 0.592 |
| Severity confidence p10/p50/p90/mean | 0.558 / 0.800 / 0.950 / 0.776 |
| Cost | USD 0.015425, 367,267 input tokens |
| Latency p50/p95 | 252 ms / 331 ms |

Curve: threshold 0.10 R 0.985 ND 0.031 P 0.462 | 0.15 R 0.964 ND 0.093
P 0.473 | 0.20 R 0.920 ND 0.173 P 0.485 | 0.30 R 0.825 ND 0.278 P 0.491 |
0.40 R 0.723 ND 0.377 P 0.495 | 0.50 R 0.657 ND 0.506 P 0.529.

**LLM-judge baseline (H6), DeepSeek** (`deepseek-v4-pro`, `json_object`,
same state per finding as Jev — hunk diff, claim, rationale, file, lines):

| Metric | Jev | Judge (DeepSeek) |
|---|---|---|
| Recall at threshold 0.20 | 0.920 | 0.955 |
| Precision at threshold 0.20 | 0.485 | 0.452 |
| Noise discarded at threshold 0.20 | 0.173 | 0.043 |
| AUC | 0.592 | 0.567 |
| Cost | USD 0.015425 | USD 2.9132 |
| Latency p50/p95 | 252 / 331 ms | 32,813 / 85,811 ms |

Cost ratio judge/Jev: 188.9×. Recall gap (judge − Jev): 0.035. Judge
severity vs. label: major 67 real / 76 noise, minor 58/73, critical 4/10,
nit 4/2.

**Verdicts**: H1 **FAIL** (recall 0.920 < 0.95; noise discarded 0.173 <
0.40). H6 **PASS** (≥ 100× cheaper, recall gap ≤ 0.05). H3 **FAIL** (ECE
0.191 ≥ 0.10).

**Reading, and why the H1/H3 FAIL is inconclusive rather than final**:
precision of both Jev and the DeepSeek judge equals the base rate (0.458)
at every threshold, and both AUCs sit near 0.5. A reasoning LLM that
spends roughly 30 seconds per finding cannot separate real defects from
noise either, which means the line-overlap label (§2, weaknesses in §3)
does not actually measure "is this finding a real defect" — the DeepSeek
run doubles as a control on the ground truth, not just a cost baseline. H1
is FAIL on the current labels and inconclusive on the question it asks; H3
inherits the same caveat, since an ECE computed against an invalid label
is not a calibration verdict. H6 stands on cost and latency regardless:
"equal recall" here is equal recall at near-chance discrimination, which
is the comparison H6 asks for.

What a valid H1 verdict needs: a human-labeled stratified sample (§5 step
2, "manual verification of a 40-record sample" — scaled here to ≥ 60–80
findings across real/noise × severity), then a zero-cost replay of the
existing Jev and judge fixtures against the corrected labels. An LLM
labeler would be circular. Full write-up and reproduction command:
`docs/BENCHMARK.md`, "Thorough findings pass and finding filter (H1 / H6
/ H3, 2026-09-22)".

## 10. Fix-aware oracle label (2026-09-22): `label.oracle`

§9 closed on a problem, not a verdict: the line-overlap label does not measure
"is this finding a real defect." Two independent systems — the Jev filter and a
DeepSeek reasoning judge that thinks for ~30 s per finding — both land at
chance against it (AUC 0.592 and 0.567, precision equal to the base rate at
every threshold). When two unrelated classifiers can't separate the classes,
the classes are the suspect.

The owner's constraint was "no manual labeling." The objection to an LLM
labeler is circularity: a model grading findings with the same information the
filter had is just a second opinion, not ground truth. **The fix removes the
circularity by giving the labeler information neither scored side ever had.**

### 10.1 What the labeler sees that nobody else does

Each hunk in `datasets/hunks.jsonl` carries the FUTURE of the code under review:

| Field | Reviewer saw it? | Jev / judge saw it? | Labeler sees it |
|---|---|---|---|
| `before`, `diff` | yes | yes | yes |
| **`after`** (the actual fix) | no | no | **yes** |
| **`evidence.commit_message`** | no | no | **yes** |
| **linked issue / PR text** (`hunk-evidence.jsonl`) | no | no | **yes** |
| `label.defect` (commit heuristic) | no | no | yes, stated plainly |
| `label.real` (line-overlap) | no | no | **never** |
| Jev's or the judge's answers | — | — | **never** |

That is strictly more evidence, not the same evidence re-judged. The reviewer
was asked to predict a defect; the labeler is asked to check a prediction
against what actually happened next. Those are different problems, and only the
second one has an answer in the data.

### 10.2 Two framings, agreement required

One model, two prompts, run independently over the same evidence
(`src/adapters/labelers/labeler-prompt.ts` — the system prompts differ, the user
message is byte-identical so a disagreement means the readings conflict, not
that the inputs did).

- **Pass A, fix-match**: *does this finding describe the problem the fix
  fixed?* → `real` | `not-this` | `unclear`. Pointing at the same lines for a
  different reason is `not-this`, explicitly.
- **Pass B, claim-verification**: *with the fix, the message and the issue in
  hand, is the claimed problem present in the `before` code?* → `present` |
  `absent` | `unclear`. Whether the fix addressed it is not this pass's
  question.

Combination (`combineOracleVerdicts` in
`src/application/findings/oracle-label.ts`):

| Pass A | Pass B | Oracle verdict |
|---|---|---|
| `real` | `present` | **`real`** (only on a defect hunk) |
| `not-this` | `absent` | **`noise`** |
| everything else | | **`unknown`** |

The case that matters most is `not-this` + `present`: a claim that is TRUE
about the code but describes something the fix did not touch. That is a
plausible real issue the oracle cannot confirm, so it is `unknown` — never
`noise`. Scoring it as noise would punish a filter for keeping a correct
finding, which is precisely the error line-overlap already makes.

`real` is downgraded to `unknown` on a benign hunk: there was no fix there for a
finding to match, so a `real` from pass A is a labeler mistake rather than
evidence. `noise` is still reachable on a benign hunk, and that is where the
absence judgment carries the whole label.

Both passes also return a 0..1 `confidence` and a one-sentence `reason`, and
both are persisted. A ground-truth label nobody can audit is worse than no
label, because it reads as fact.

### 10.3 Wire format

Written alongside the line-overlap label, never over it — the two disagree, and
the cross-tab between them is itself a result:

```jsonc
"label": {
  "real": true,                         // unchanged line-overlap label (§2)
  "source": "line-overlap",
  "overlap_lines": 2,
  "fix_changed_lines": 3,
  "oracle": {
    "verdict": "real",                  // "real" | "noise" | "unknown"
    "source": "fix-oracle",
    "labeler_model": "deepseek-v4-pro",
    "fix_match":          { "verdict": "real",    "confidence": 0.9, "reason": "..." },
    "claim_verification": { "verdict": "present", "confidence": 0.8, "reason": "..." }
  }
}
```

Parser: `FindingOracleLabel` in `src/application/filter/finding-record.ts`
(`label.oracle` is optional, so every pre-existing record still parses).

### 10.4 Running it

```bash
# 1. Fetch the issue / PR text behind each fix (public repos, read-only, resumable).
pnpm dataset:evidence

# 2. Label. 2 calls per finding. Resumable: an existing fixture is served from
#    disk and no call is made, so a re-run after a rate limit costs only the rest.
DEEPSEEK_API_KEY=... pnpm findings:label \
    --findings datasets/findings-thorough.jsonl \
    --out datasets/findings-thorough-oracle.jsonl \
    --labeler deepseek --mode record --concurrency 2

# 3. Re-score H1 / H6 / H3 against the new label. ZERO new LLM calls: Jev and the
#    judge replay from the fixtures they already have.
pnpm filter --findings datasets/findings-thorough-oracle.jsonl \
    --mode replay --judge deepseek --judge-mode replay --label oracle

# Prove the chain without spending anything:
pnpm findings:label --findings datasets/findings-thorough.jsonl --out /tmp/oracle.jsonl \
    --labeler dry-run --mode dry-run
```

Fixtures: `tests/fixtures/findings-oracle/`, keyed by sha256 of (input,
framing) — the two passes can never share one, and re-fetching an issue body
changes the key so a stale label is invalidated rather than silently reused.
`--mode replay` (the default) re-derives every label from them at no cost. The
dry-run labeler is refused in `--mode record`: it would persist seeded noise
into a field that reads as ground truth.

### 10.5 Known weaknesses

Stated plainly, because this label will be quoted as ground truth:

- **It cannot confirm a real issue the fix did not touch.** Those land in
  `unknown` by design (§10.2). If the `unknown` share is large, H1 is measured
  on a narrower, easier slice than the full dataset — the report prints the
  share for exactly this reason, and it should be read next to every number.
- **`unknown` is not missing-at-random.** It concentrates on findings about
  code the fix left alone, which plausibly skews toward vaguer claims. The
  remaining sample is therefore not a uniform subsample of the 299.
- **Benign-hunk noise rests on absence judgments.** "The claimed problem is not
  there" is harder to establish than "it is there," and an LLM asked to prove a
  negative over one hunk can only speak for the code it was shown. Claims about
  code outside the hunk should come back `unclear`, and the prompt says so, but
  that is a prompt instruction, not a guarantee.
- **The upstream defect label is still a commit heuristic.** `label.defect`
  comes from commit metadata (`README.md` § hunks 5), and the oracle leans on
  it for the benign-hunk guard. Noise there propagates here.
- **One model, two prompts — not two models.** The two passes are independent
  framings, not independent systems. A bias the model holds in both framings
  (for example, agreeing too readily with a confidently-worded claim) survives
  the agreement check. Re-running pass B on a different model would be the
  honest strengthening move, and has not been done.
- **The evidence is third-party text.** Issue and PR bodies come from public
  repositories and are shown to the labeler as evidence about code. They are
  capped at 2000 characters and never reach the reviewer, the filter or the
  judge.

`needs_manual_review: true` stays `true` on every record. This label is a
better instrument than line-overlap, not a substitute for someone reading the
code.

### 10.6 Results (2026-09-22)

Run over all 299 thorough findings, `deepseek-v4-pro`, both framings. Report:
`reports/oracle-2026-09-22T16-56-57-376Z.md`. 586 calls (two runs — 15
findings first truncated at the 8192-token reasoning cap and retried with
`--max-tokens 32768`), cost USD 4.96, latency per finding (both passes) p50
37 s / p95 113 s. Framing agreement (Pass A vs. Pass B, before combination)
84.0%.

| Verdict | Count | Share |
|---|---|---|
| `real` | 7 | 2.4% |
| `noise` | 239 | 81.6% |
| `unknown` | 47 | 16.0% |

Six additional findings could not be labeled at all: DeepSeek returned `402
insufficient balance` on the retry, after the balance ran out mid-run. They
are scored as `unknown` — excluded from H1/H3/H6 exactly like any other
`unknown`, not counted as noise or discarded silently.

Cross-tab against the old line-overlap label: of the 133 findings
line-overlap called real, the oracle says 7 real / 106 noise / 20 unknown; of
the 160 it called noise, the oracle says 0 real / 133 noise / 27 unknown. The
two labels agree on 57% of the cases where the oracle reaches a decision —
line-overlap's "real" was wrong (by the oracle's read) on 106 of 133 cases.

Sampled reasons hold up under reading. One `noise` verdict is on a finding
warning that switching a `Map` to a `WeakMap` "drops size/clear/iteration":
the reason cites the PR's own statement that the buckets only ever need
`get` and `set`, so the dropped methods were never used and the warning does
not describe what the fix actually changed.

Re-scoring H1/H6/H3 against `label.oracle`
(`pnpm filter --findings datasets/findings-thorough-oracle.jsonl --mode
replay --judge deepseek --judge-mode replay --label oracle`, zero new LLM
calls, report `reports/filter-2026-09-22T16-58-00-234Z.md`), scored
population 246 (7 real / 239 noise, 53 `unknown` excluded): Jev AUC rises
0.592 → 0.708, the DeepSeek judge 0.567 → 0.700 (241 scored, 5 truncated).
H6 **PASS** (182× cheaper, recall gap within tolerance). H1 **FAIL,
formally** — no threshold clears recall ≥ 0.95 AND noise discarded ≥ 0.40 at
once; at full recall Jev discards 25.5% of the noise, the judge 32.1%. H3
**FAIL** — ECE 0.504 against a 2.8% base rate, Jev's probabilities running
far above the true rate of real findings. Full tables, both threshold curves
and the reading: `docs/BENCHMARK.md`, "Re-scored against the fix-aware
oracle label (2026-09-22)".

## 11. Why only 7 real findings: the reviewer sees the fix

Two independent scorers both rise sharply against the oracle label (§10.6),
which says the label measures something real. It also surfaces a structural
limit of this dataset that no amount of re-labeling fixes.

`datasets/hunks.jsonl` gives the reviewer the bugfix commit's own diff:
`before` is the buggy code, `diff` is the change that fixed it. The reviewer
is being shown, hunk by hunk, a change that already fixes whatever defect was
there. A finding only scores `real` when it happens to describe the exact
defect the fix removed — everything else the reviewer flags, however
plausible, is either about code the fix never touched (`unknown` by design,
§10.2) or simply wrong (`noise`). Out of 299 findings from 100 already-fixed
hunks, 7 landed on the actual defect.

That makes `findings-thorough-oracle.jsonl` two different things at once:

- **A large, clean noise benchmark.** 239 confirmed-noise findings with
  fix-aware reasons attached is a solid population for measuring how much
  noise a filter removes.
- **An unusable recall population.** 7 positives is too few to estimate
  recall with any confidence interval worth reporting, which is why H1
  stays formally FAIL even though the underlying AUC shows real separation
  (§10.6).

**Proposed next step (H1b, not yet approved, no cost incurred): reverse the
hunks.** Present `after → before` instead of `before → after` — i.e., show
the reviewer the buggy state as if it were "the change" and hide the fix.
Under that framing, a real finding is one that flags the bug the fix later
removed, and every one of the 100 defect hunks becomes a chance to produce a
real finding instead of 1-in-3 on average. The pipeline is unchanged: a
reviewer pass on DeepSeek, oracle labeling exactly as in §10, Jev/judge
scoring exactly as in §9/§10.6 — all existing tooling, no new code. Estimated
cost ≈ USD 10 of DeepSeek. Blocked on topping up the DeepSeek balance
(exhausted 2026-09-22, see §10.6).

Until H1b lands, stage 4 (finding filter) stays in annotate mode
(`findingFilter.mode: "annotate"`): findings are published with their
confidence, never silently discarded, per the pending product decision in
§9 and `docs/SPEC.md` §4.6.

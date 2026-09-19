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
  "reviewer": { "provider": "anthropic", "model": "claude-opus-5" },
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
  "latency_ms": 2140
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

Both providers are configurable behind `src/domain/ports/reviewer-port.ts`
(SPEC §13 "Ambos proveedores"):

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

Both share one prompt (`src/adapters/reviewers/review-prompt.ts`): concrete
defects only (logic, boundary, async, error handling, type misuse), absolute
BEFORE-side line ranges, empty findings list is a valid and expected answer.

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

`scripts/findings/generate.ts --estimate` (Anthropic only) uses
`client.messages.countTokens` on a 3-hunk sample and extrapolates — see
`src/application/findings/estimate-cost.ts`. It's a **conservative upper
bound**: it prices every hunk's tokens at the full (non-cached) input rate,
ignoring the discount the real run gets from prompt-caching the repeated
system prompt, and assumes a flat 150 output tokens/hunk (output size isn't
knowable without actually calling the model). The real run should therefore
cost at or under the printed estimate, never over it.

## 6. Run summary

**Not run: no credentials.** Neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY`
is set in this environment, and no `ant` CLI / `ant auth login` profile is
present to resolve Anthropic credentials another way. Per this task's
instructions, no live generation was attempted — every module above (both
adapters, `generate-findings.ts`, `summary.ts`, `estimate-cost.ts`, the CLI's
argument parsing and dataset/stratified-sample wiring) is built and unit
tested against fakes/injected clients, and the CLI was smoke-tested against
the real `datasets/hunks.jsonl` up to the point where it needs a real
provider client (confirmed: dataset loads, `--limit` stratified sampling
runs, then it fails cleanly with a clear "requires credentials" message
instead of a stack trace).

`datasets/findings.jsonl` does not exist yet. Once credentials are available,
the intended sequence (per the task brief) is:

```bash
pnpm findings --provider anthropic --estimate     # must print well under $5 for 100 hunks
pnpm findings --provider anthropic --record        # writes datasets/findings.jsonl,
                                                     # records raw responses under tests/fixtures/findings/
```

Do **not** run `--provider openai` live (out of scope per the task brief;
also has no confirmed pricing, per §5).

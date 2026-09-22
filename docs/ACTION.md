# Jevest — GitHub Action

Automated PR review using Jev (TypeSafe AI) as a millisecond decision
layer over an LLM reviewer. Full design: [docs/SPEC.md](SPEC.md).

## Install in a consumer repo

Add a workflow, e.g. `.github/workflows/jevest.yml`:

```yaml
name: Jevest review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  checks: write
  issues: write
  statuses: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: tincke10/Jevest@main
        with:
          config-path: .jevest.yml
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # openai-api-key: ${{ secrets.OPENAI_API_KEY }}      # if .jevest.yml selects openai instead
          # deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}  # if .jevest.yml selects deepseek instead
          github-token: ${{ secrets.GITHUB_TOKEN }}
          fail-on: never
```

Pin `@main` to a tag once one is cut; `@main` tracks the latest commit.
Which tags will exist and which one to pin is in [RELEASING.md](RELEASING.md).
Deliberately no `actions/checkout` step — see "Why no checkout" below.

### Secrets to set

| Secret | Required | Notes |
|---|---|---|
| `TYPESAFE_API_KEY` | Always | Jev, the decision layer (NFR-9: environment/secrets only, never a literal in the workflow) |
| `ANTHROPIC_API_KEY` | If `.jevest.yml` selects `reviewer.provider: anthropic` | |
| `OPENAI_API_KEY` | If `.jevest.yml` selects `reviewer.provider: openai` | |
| `DEEPSEEK_API_KEY` | If `.jevest.yml` selects `reviewer.provider: deepseek` | Models `deepseek-v4-pro` (default) or `deepseek-flash`; see "Choosing a reviewer" |
| `CLAUDE_CODE_OAUTH_TOKEN` | If `.jevest.yml` selects `reviewer.provider: claude-cli` | From `claude setup-token` (Claude Pro/Max); see "Claude subscription in CI" |
| `GITHUB_TOKEN` | Always | The built-in token is enough; no PAT needed |

### `.jevest.yml`

`.jevest.yml` is a **partial override**; only write what you change. Every
setting lives in [`config/jevest.example.yml`](../config/jevest.example.yml)
with its default value — that file doubles as the built-in defaults, so
Jevest deep-merges whatever `.jevest.yml` contains on top of it (missing
or empty means "no overrides at all"). A key you omit, at any depth,
falls back to the default shown in the example file: overriding
`thresholds.triage.low` alone leaves every other risk level and every
other stage exactly as shown there. Arrays and plain values
(`budgetUsd`, `skipChangeKinds`, etc.) are replaced wholesale by your
override, never merged. An unknown top-level key throws immediately,
naming the key — with most keys absent being the normal case for a
partial file, a typo would otherwise silently do nothing. For example, a
repo doing a Jev-only dry run needs only:

```yaml
reviewer:
  provider: none
publish:
  inlineComments: false
budgetUsd: 1
```

Point `config-path` elsewhere if you'd rather not use the repo root.

### Choosing a reviewer

`reviewer.provider` selects which LLM writes the findings; Jev's role is
identical whichever you pick. All three are behind the same `ReviewerPort`
and receive the same prompt, so switching is a config change, not a code
change.

| Provider | Models | Structured output | Notes |
|---|---|---|---|
| `anthropic` | `claude-opus-5`, `claude-sonnet-5` | Server-enforced schema (`messages.parse`) | Default. Prompt caching on the system prompt |
| `openai` | any chat model | Server-enforced schema (`json_schema`) | Pricing table not confirmed in this repo; cost is estimated at Sonnet 5 rates |
| `deepseek` | `deepseek-v4-pro` (default), `deepseek-flash` | `json_object` only, validated client-side | OpenAI-compatible endpoint `https://api.deepseek.com`; peak-rate pricing used for the budget cut-off; a 402 means the DeepSeek account has no balance |
| `claude-cli` | `claude-opus-5` (default), `claude-sonnet-5` | Schema-enforced by `claude -p --json-schema` | Bills a Claude Pro/Max **subscription**, not API credits; `budgetUsd` tracks the CLI's nominal list price. See "Claude subscription in CI" |

### Claude subscription in CI (`claude-cli`)

If you have a Claude Pro or Max subscription and no Anthropic Console
credits, the `claude-cli` reviewer runs `claude -p` on the runner and
authenticates with a long-lived OAuth token, the same mechanism Anthropic's
own `claude-code-action` documents for subscribers:

1. On your machine, run `claude setup-token` and copy the token it prints.
2. Store it as the repository secret `CLAUDE_CODE_OAUTH_TOKEN`.
3. Pass it to the Action as `claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`
   and set `reviewer.provider: claude-cli` in `.jevest.yml`.

The Action installs `@anthropic-ai/claude-code` on the runner only when
that input is present (about 15–20 s extra per run).

Know what you are signing up for:

- **The token is one person's subscription.** Every PR review on the repo
  draws on that person's Max/Pro quota, alongside their own interactive
  use. A busy repo can exhaust it. `budgetUsd` still caps each run, using
  the nominal list price the CLI reports.
- **It is a personal credential**, not an org one. Rotate it by running
  `claude setup-token` again; revoke it from the Claude account's
  settings if it leaks.
- **Never for `pull_request_target` or fork PRs.** Same rule as every
  other secret here (see "Security notes").

DeepSeek's json mode has one documented quirk: the API "may occasionally
return empty content". Jevest treats an empty or malformed reply as a
parse error for that hunk (the hunk is reported as unreviewed in the
summary), never as "no findings" — an empty reply is not evidence that the
code is fine.

### Why no checkout

The install snippet above has no `actions/checkout` step, and it doesn't
need one: `fetchPullRequest`, `.jevest.yml`, and everything else the
pipeline reads come from the GitHub API, not from a working tree. The one
thing that used to want a local file — `config-path` — now falls back to
fetching it from the PR base sha via the contents API when it isn't on
disk (`resolveConfig` in `src/action/main.ts`), so the checkout was purely
incidental infrastructure, not a real dependency.

This matters because checkout is not free. Measured on a real consumer
repo (a private PHP + Vue monorepo, 9.7 GB tree): `actions/checkout@v4` took
**2m43s** of a 3m09s run, versus **22s** for Jevest's own work. Dropping
the checkout step turns a ~3-minute job into a ~25-second one on a repo
that size, for zero loss of functionality.

Add `actions/checkout` back only if you specifically want `config-path`
read from a **modified working tree** — e.g. a prior step in the same job
rewrites `.jevest.yml` before Jevest runs. In that case the local file
wins over the API fetch, exactly as before.

Two options worth knowing about before a first rollout:

- **`reviewer.provider: none`** — Jev-only mode. The review stage never
  runs (no LLM key required at all), so no findings are ever produced;
  the merge gate still runs on triage and CI status alone. Useful to
  validate triage and merge-gate behavior on a new repo, or to run
  Jevest somewhere an LLM key genuinely isn't available, before turning
  on actual code review.
- **`publish.inlineComments: false`** (recommended for the first weeks on
  a new repo) — auto-band findings are still evaluated, just listed in
  the summary comment under "Findings (high confidence)" instead of
  posted as inline PR comments. Lets a team see the tool's accuracy
  before it starts leaving comments on people's code. Check status and
  labels are unaffected either way.

### Spend cap

Jevest has three cost controls, and they answer different questions:

| Control | Scope | What happens when hit |
|---|---|---|
| `budgetUsd` | One run (one PR, one commit) | The review stage stops calling the LLM for the remaining hunks of that run; findings already produced are kept |
| `spendCap` | The whole service, cumulative over a period | The LLM review stage is skipped entirely (Jev-only run) until the period rolls over or the cap is raised/reset |
| `maxHunks` | One run | Hunks beyond the limit are not profiled or reviewed |

`spendCap` is what protects a **personal Claude subscription** when
`reviewer.provider` is `claude-cli`: `budgetUsd` alone only bounds each
PR, and a busy repo can still burn through a Max plan one PR at a time.
Defaults (from `config/jevest.example.yml`):

```yaml
spendCap:
  usd: 50          # hard stop
  period: month    # "month" = calendar month in UTC, resets automatically; "total" = never resets
  warnAtUsd: 40    # must be below usd; from here on every run carries a warning
```

It is always on. To run without a cumulative cap, set `usd` to a very
high number — there is deliberately no `enabled: false`, so the spend
stays visible in the ledger either way.

**What it does on each run.** After triage, Jevest reads the ledger and
compares the period's total against `usd`:

- below `warnAtUsd`: normal run. The per-run budget is still clamped to
  whatever is left under the cap, so a run can never push the total
  more than one `budgetUsd` past it.
- at or above `warnAtUsd`: normal run, plus a `::warning::` annotation
  on the job, the `jevest:spend-warning` label on the PR, and a line in
  the `jevest` check summary.
- at or above `usd`: the LLM review stage is skipped exactly like
  `reviewer.provider: none` — triage, hunk-profile and the merge gate
  still run on Jev alone. The summary comment opens with **"LLM review
  skipped: spend cap reached"**, the PR gets `jevest:spend-cap-reached`,
  and the job gets a `::warning::` (never an error: a reached cap is a
  degraded run, not a failed one, and `fail-on` is unaffected).

After the review stage the run's LLM cost plus Jev's share (input tokens
at $0.042/MTok) is added to the ledger, and the summary comment shows a
"Spend cap" section: `USD <spent> of <cap> this month (<left> left)`.
The action output `spend-usd` carries the cumulative total after the run.

**Where the ledger lives.** In one open issue of the consumer repo,
titled "Jevest spend ledger", labelled `jevest`, and identified by the
marker `<!-- jevest:spend-ledger -->` in its body (the same idempotent
upsert pattern as the summary comment). It is created on the first run
and rewritten in place afterwards. The body is a short table for humans
followed by a fenced ` ```json ` block that is the actual source of truth:

```json
{
  "period_key": "2026-09",
  "spent_usd": 12.3456,
  "runs": 7,
  "updated_at": "2026-09-21T16:00:00.000Z"
}
```

No extra permission is needed: `issues: write` (already required for
labels and the summary comment) covers it. `pnpm review` local runs use
the same logic over a git-ignored file, `.jevest/spend-ledger.json` in
the reviewed repo.

**How to reset, raise or lower.**

- Reset the counter: edit `spent_usd` in the JSON block (e.g. to `0`),
  or close the ledger issue — the next run creates a fresh one. A
  `period: month` cap also resets by itself on the first run of a new
  UTC month; the old issue is reused, its total starts over.
- Raise or lower the cap: change `spendCap.usd` / `warnAtUsd` in
  `.jevest.yml`. The ledger only stores what was spent, never the cap,
  so a config change takes effect on the next run with no reset needed.
- Switch to `period: total`: the stored total is keyed by period
  (`"2026-09"` vs `"total"`), so switching starts a new count from zero.

**Known race, accepted on purpose.** Two runs on different PRs can both
read the same balance, both pass the check, and both record. The
overshoot is bounded by one `budgetUsd` per concurrent run — fine for a
safety net whose job is to stop the bleeding by the next run, not to be
cent-exact accounting. If the ledger issue cannot be read or written
(API outage, revoked token), the run does **not** fail: it proceeds on
the full per-run `budgetUsd`, logs a `::warning::`, and the summary
comment says "spend ledger unavailable: <reason>".

### Product context (`.jevest/context.yml`)

A pull request can tell Jev what changed, but not what the product *is*
or which parts of it matter. That is the job of one file in your repo,
`.jevest/context.yml` (path configurable via `triage.productContextPath`):

```yaml
product:
  name: Acme Shop
  description: Online store for widgets.
areas:
  - name: checkout
    paths: ["src/checkout/**", "src/payments/**"]
    criticality: critical
    owners: ["@acme/payments"]
    rules:
      - "Prices and totals are always computed server side."
  - name: docs
    paths: ["docs/**"]
    criticality: none
defaults:
  criticality: low
```

The full annotated example is
[`config/context.example.yml`](../config/context.example.yml). Missing
file: triage runs without product areas, no error. Invalid file: the run
fails closed naming the file, exactly like a bad `.jevest.yml`, because a
rule set that fails to parse must never silently become "no rules".

**It is always read from the PR's base commit**, never from the PR head
and never from a local checkout. A PR that could edit the context that
judges it would just declare its own area harmless; reading from the base
means an area marked critical on `main` stays critical for a PR that
edits this file, and the edit only takes effect once merged.

What the file does, all computed in code (Jev only ever sees words, NFR-5):

- The changed paths are matched against every area's globs (picomatch,
  whole repo-relative path, dotfiles included, so `.github/**` matches a
  workflow).
- **Areas raise risk.** The PR's effective risk level becomes the highest
  `criticality` among the areas touched if that is higher than Jev's own
  triage risk; it is never lowered. A one-line fix under `src/payments/`
  is reviewed with the `critical` confidence bands, cannot skip the LLM
  review (FR-2.3 needs low risk), and its merge gate needs the `critical`
  bar.
- The areas touched, their criticality words and their `rules` go into the
  triage state (next to the author's description, the file facts and the
  change summary) and into the merge gate state as
  `product_areas_touched`, so `needs_product_owner`, `matches_intent` and
  `safe_to_automerge` are judged with the product in view.
- The summary comment's "Intent vs change" section lists the areas touched
  with their criticality and rules, and says when the risk was raised.

#### The change summary (`triage.changeSummary`)

Triage v2 compares the author's description with what the diff actually
does. The evidence (H7 in [`docs/BENCHMARK.md`](BENCHMARK.md)): with an LLM
summary of the diff written **without seeing the title or body**, Jev
detects a description that does not match its change with recall 0.99,
precision 1.00 and ECE 0.07 over 200 pairs; on file facts alone the result
is only partial (recall 0.88, ECE 0.10). So the summary is one extra LLM
call per PR, and `triage.changeSummary` decides when it is made:

| Mode | When the summary runs | Cost |
|---|---|---|
| `auto` (default) | `reviewer.provider` is an LLM and the spend cap is not reached | one summarizer call per PR, billed at the reviewer model's rate (or the CLI's nominal cost for `claude-cli`), counted in `budgetUsd`, the spend ledger and the "Cost breakdown" |
| `always` | every run, even a Jev-only run after the spend cap is reached; a config error with `reviewer.provider: none` | same as `auto`, cap or not |
| `never` | never; triage judges the description against file facts only (H7's without-summary arm) | none |

The summarizer uses the same provider, model and secret as the reviewer.
If the summarizer call fails (rate limit, outage, parse error) the run
does **not** fail: triage runs without the summary, the summary comment
says "No change summary: the summarizer failed (<reason>)", and nothing
is billed for it. The summary is an enhancer, not a foundation.

How a mismatch surfaces on the PR: the "Intent vs change" section shows
the verdict with `P(matches_intent)`; a mismatch (`P < 0.35`, H7's
operating point) whose confidence lands in the `auto` or `confirm` band
adds the `jevest:description-mismatch` label and lists the PR under
"Needs human review"; in the `auto` band it also forces a green check to
`neutral`. It never turns a check red on its own; that stays the merge
gate's call. `needs_product_owner` above the confirm bar adds
`jevest:needs-product-owner`. Both labels are removed again when the
signal clears, like every other Jevest label.

### Permissions

The workflow's `permissions:` block needs:

- `pull-requests: write` — inline review comments, the summary comment, labels
- `checks: write` — the `jevest` check run
- `issues: write` — labels, the summary comment and the "Jevest spend
  ledger" issue (see "Spend cap") all go through the issues API
- `contents: read` — fetches `.jevest.yml` from the PR base sha via the
  contents API when it isn't in a local checkout (see "Why no checkout"
  above); also what `actions/checkout` needs, if you add that step back
- `statuses: read` — reads the PR head commit's combined CI status for the
  merge gate's CI signal; without it, Jevest reports CI status as
  `"unknown"` instead of failing the run

Without `checks: write` (e.g. a fork's default `GITHUB_TOKEN`), the Action
falls back to the legacy commit-status API and logs that it did, rather
than failing the run.

## What it publishes

Per the six-stage pipeline (SPEC §3, §5 Fase 2):

- **Inline comments** on high-band findings only, upserted in place on
  re-runs of the same commit — never duplicated (NFR-12).
- **One summary comment**, also upserted in place, with the triage
  decision, an "Intent vs change" section (what the diff summary says
  changes, product areas touched with their criticality, whether the
  description matches the change), hunks skipped and why, findings sent
  to a human review queue, and the run's cost.
- **Labels**, added/removed per the triage and merge-gate outcome (e.g.
  `jevest:needs-human`, `jevest:auto-merge-ok`,
  `jevest:description-mismatch`, `jevest:needs-product-owner`,
  `jevest:injected-instructions` when a hunk of the diff itself talks to
  the reviewer) and the spend cap state (`jevest:spend-warning`,
  `jevest:spend-cap-reached`).
- **One "Jevest spend ledger" issue** per repo, holding the cumulative
  spend behind `spendCap` (see "Spend cap").
- **A `jevest` check run** (or commit status, see above) carrying the
  merge-gate conclusion: green, neutral ("needs a human"), or red.

### Efficiency (H2 / H4)

The summary comment ends with an "Efficiency" section, on every run that
gets past triage's Jev call (a triage-only run has it too; a fail-closed
run does not):

```
### Efficiency
- Jev: 9 requests · p95 latency 312 ms · total Jev time 1840 ms
- LLM: 4 of 7 hunks reviewed · 3 skipped (change kind 2, secret 1)
- LLM tokens: 6120 tokens spent (review 5700, summary 420) · without Jev ≈ 8900 · saved ≈ 31.2%
- Estimate, not a measurement: tokens without Jev = measured review tokens + for each of the 3 skipped hunk(s) ceil(chars / 4) input tokens + this run's mean output tokens per reviewed hunk (140); ...
```

- The Jev line is H4 (SPEC §4.2): every Jev request of the run, its
  nearest-rank p95 and its sum.
- The LLM lines are H2: which hunks the reviewer saw and why the others
  were skipped (`triage skip`, `change kind` for `skipChangeKinds`,
  `secret`, `budget`, `spend cap`, `reviewer disabled`), the tokens spent
  (review + change summary), and an **estimated** "without Jev" figure
  priced from the skipped hunks' diff size. The last line always says how
  it was computed. Read [`docs/BENCHMARK.md`](BENCHMARK.md) "H2 / H4 —
  measured per run" before quoting the percentage: it is a floor, not a
  measurement, and can be negative on a tiny PR.
- The section sits last and is left out of the summary comment's
  fingerprint, so two runs over the same commit that differ only in
  timing still count as the same review (NFR-12).

The same numbers are available as action outputs:

| Output | Meaning |
|---|---|
| `jev-requests` | Number of Jev requests this run made |
| `jev-latency-p95-ms` | p95 latency across those requests, in ms |
| `llm-tokens-saved-pct` | Estimated LLM tokens saved, in percent, one decimal |

`pnpm review` prints the same section (it prints the whole summary) plus
one `[review] wall time:` line with the wall clock per stage, which is
also in `metrics.wallTime` of the pipeline result.

## What it never does

**It never merges anything** (FR-6.4). The merge gate stage only emits a
signal — a check conclusion and, on the green band, a label. Whether that
signal actually merges the PR is entirely up to a rule you configure in
*your* repo (e.g. a branch-protection required check, or your own
auto-merge workflow watching for the label). Jevest has no `merge`
endpoint wired into its GitHub client at all; calling one would be a
compile error, not just a policy.

It also never reviews images or binaries, never fine-tunes anything, and
Jev itself never writes review text — an LLM (Anthropic, OpenAI or
DeepSeek, per your config) writes every finding; Jev only decides what to review,
how much, and what to publish.

## Language support

Jevest reviews a pull request's diff regardless of language — Jev's
`change_kind`/`touches_error_handling`/`touches_async`/
`contains_reviewer_instructions` questions (the hunk-profile stage, one
request per hunk) and the LLM review itself run on the raw diff for any
file. The one
language-specific piece is **AST-based public-API detection**
(`touches_public_api`, SPEC §4.3): that's TypeScript/JavaScript/Vue only.
For a `.vue` file, only its `<script>`/`<script setup>` block is
inspected; a template-only change is treated the same as an unsupported
language. For everything else (PHP, Blade templates, Python, Go, and so
on), `touches_public_api` is left unset and the reviewer relies on Jev's
other surface questions plus its own read of the diff — it never guesses
public-API impact from a TypeScript parse of code that isn't TypeScript.

## Security notes

- **Use `pull_request`, not `pull_request_target`, unless you have a
  specific reason and understand the tradeoff.** `pull_request_target`
  runs with the target repo's secrets and permissions even for a PR from
  an untrusted fork, while checking out (or otherwise acting on) that
  fork's content — that combination is exactly how injected-instruction
  and secret-exfiltration attacks against PR-review bots work. `pull_request`
  from a fork gets a read-only, fork-scoped `GITHUB_TOKEN` and no repo
  secrets, so this Action simply can't read `TYPESAFE_API_KEY` /
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` on a fork PR under that trigger —
  it fails the input-parsing step closed instead. If you need
  `pull_request_target` for another reason, do not add this Action to the
  same job/workflow without a manual approval gate in front of it.
- **All PR content is treated as untrusted input** (SPEC NFR-7): the title,
  body, diffs, and file contents can all contain attempted prompt
  injection. Two Jev questions cover it: `contains_injected_instructions`
  in triage (title, body, labels) and `contains_reviewer_instructions` in
  the hunk-profile stage, asked of every hunk's diff so an instruction
  hidden in a code comment or a string literal is seen where triage cannot
  see it. Either one high fails the merge gate in code; the in-diff one
  also adds `jevest:injected-instructions` and lists the hunks under
  "Needs human review" in the summary comment. The adversarial suite (H5)
  regression-tests this in CI (SPEC §4.2, §10).
- Never put an API key directly in a workflow file — always
  `${{ secrets.<NAME> }}` (NFR-9).

## Fail-closed behavior

If the pipeline hits an unexpected error (a timeout, a 5xx after retries,
a bad config, anything), Jevest always tries to publish a **red** `jevest`
check first, so a broken run never leaves a stale green check sitting on
the PR. Whether the *workflow job itself* also fails is controlled by the
`fail-on` input:

- `fail-on: never` (default) — the job stays green regardless; the check
  carries the real signal. Use this if you gate merges on the check itself
  (recommended) rather than on this job's pass/fail.
- `fail-on: failure` — the job exits non-zero when the merge-gate
  conclusion (or an internal error) is a failure, in addition to the red
  check. Use this if your branch protection watches this job's status
  instead of, or in addition to, the `jevest` check.

Every degraded-input case inside the pipeline also fails closed by design
(NFR-2): if Jev doesn't respond, triage assumes high risk, the finding
filter publishes everything as "unverified", and the merge gate goes red.

One exception, by design: a missing or invalid **input** (e.g. a required
secret was never set on the workflow) always crashes the job with a
non-zero exit, regardless of `fail-on`. At that point there is no
`github-token` yet, so there is no PR and no way to publish any check —
this is a broken workflow, not a degraded review, and `fail-on: never`
should not be able to hide it.

## Local testing

```sh
pnpm action
```

Runs `src/action/main.ts` directly with `tsx`. It expects the same
`INPUT_*` and `GITHUB_*` environment variables the composite action sets
(see `action.yml`); for a quick smoke test of ref resolution against a
canned event, see `tests/fixtures/github/pull_request.event.json` and
`src/action/main.test.ts`.

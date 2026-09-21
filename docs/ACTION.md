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
fetching it from the PR head sha via the contents API when it isn't on
disk (`resolveConfig` in `src/action/main.ts`), so the checkout was purely
incidental infrastructure, not a real dependency.

This matters because checkout is not free. Measured on a real consumer
repo (InvisibleGeeks/prolicht, a 9.7 GB tree): `actions/checkout@v4` took
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

### Permissions

The workflow's `permissions:` block needs:

- `pull-requests: write` — inline review comments, the summary comment, labels
- `checks: write` — the `jevest` check run
- `issues: write` — labels and the summary comment both go through the issues API
- `contents: read` — fetches `.jevest.yml` from the PR head sha via the
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
  decision, hunks skipped and why, findings sent to a human review queue,
  and the run's cost.
- **Labels**, added/removed per the triage and merge-gate outcome (e.g.
  `needs-human-review`, `jevest:auto-merge-ok`).
- **A `jevest` check run** (or commit status, see above) carrying the
  merge-gate conclusion: green, neutral ("needs a human"), or red.

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
`change_kind`/`touches_error_handling`/`touches_async` questions and the
LLM review itself run on the raw diff for any file. The one
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
  injection. Jev's `contains_injected_instructions` triage question feeds
  directly into the merge gate, and the adversarial suite (H5) regression-
  tests this in CI (SPEC §4.2, §10).
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

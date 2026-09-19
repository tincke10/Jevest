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

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: tincke10/Jevest@main
        with:
          config-path: .jevest.yml
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # openai-api-key: ${{ secrets.OPENAI_API_KEY }}  # if .jevest.yml selects openai instead
          github-token: ${{ secrets.GITHUB_TOKEN }}
          fail-on: never
```

Pin `@main` to a tag once one is cut; `@main` tracks the latest commit.

### Secrets to set

| Secret | Required | Notes |
|---|---|---|
| `TYPESAFE_API_KEY` | Always | Jev, the decision layer (NFR-9: environment/secrets only, never a literal in the workflow) |
| `ANTHROPIC_API_KEY` | If `.jevest.yml` selects `reviewer.provider: anthropic` | |
| `OPENAI_API_KEY` | If `.jevest.yml` selects `reviewer.provider: openai` | |
| `GITHUB_TOKEN` | Always | The built-in token is enough; no PAT needed |

### `.jevest.yml`

Copy [`config/jevest.example.yml`](../config/jevest.example.yml) to
`.jevest.yml` at your repo root and adjust: reviewer provider/model,
confidence-band thresholds per stage and risk level (NFR-13), per-PR
budget (NFR-10), max hunks per PR, and which `change_kind`s skip the LLM
reviewer entirely. Point `config-path` elsewhere if you'd rather not use
the repo root.

### Permissions

The workflow's `permissions:` block needs:

- `pull-requests: write` — inline review comments, the summary comment, labels
- `checks: write` — the `jevest` check run
- `issues: write` — labels and the summary comment both go through the issues API
- `contents: read` — the Action itself doesn't need more; `actions/checkout` does

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
Jev itself never writes review text — an LLM (Anthropic or OpenAI,
per your config) writes every finding; Jev only decides what to review,
how much, and what to publish.

## Security notes

- **Use `pull_request`, not `pull_request_target`, unless you have a
  specific reason and understand the tradeoff.** `pull_request_target`
  runs with the target repo's secrets and permissions even for a PR from
  an untrusted fork, while checking out (or otherwise acting on) that
  fork's content — that combination is exactly how injected-instruction
  and secret-exfiltration attacks against PR-review bots work. `pull_request`
  from a fork gets a read-only, fork-scoped `GITHUB_TOKEN` and no repo
  secrets, so this Action simply can't read `TYPESAFE_API_KEY` /
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` on a fork PR under that trigger —
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

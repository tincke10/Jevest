# Migrating

## 0.1 → 1.0

1.0 changes what a run does by default and what it leaves on the PR. Most
repositories need two edits to the workflow (a checkout step and the Claude
token) and none to `.jevest.yml`; a repository that wants to keep 0.1's
per-hunk review needs one line in `.jevest.yml` instead. Read the whole list
if anything (branch protection, an automation, a dashboard) reads Jevest's
labels or check.

Everything below is in the [CHANGELOG](../CHANGELOG.md) under 1.0.0; this
page is the upgrade view of it.

### Checklist

1. Pin `tincke10/Jevest@v1` (`@v0` stays on 0.1 and never moves to 1.0; see
   [RELEASING.md](RELEASING.md)).
2. Either adopt the agentic default — add `actions/checkout` of the PR head
   and the `claude-code-oauth-token` input (a **repository** secret) — or pin
   the legacy per-hunk mode in `.jevest.yml` (see
   [Staying on the legacy per-hunk mode](#staying-on-the-legacy-per-hunk-mode)).
3. Replace every use of the `jevest:needs-human` label (filters, automations,
   saved searches) with the verdict labels.
4. Re-read your branch protection rule on the `jevest` check: it now goes red
   only when there is something to fix.
5. Size `spendCap` (and the job's `timeout-minutes`) for agentic runs: about
   $1.60 nominal and 2.5–7 minutes per PR.
6. Make sure `.jevest.yml` on the **base branch** is the one you mean (the
   Action no longer reads the workspace copy) and has no misspelled nested
   key (items 7 and 8).

### Breaking changes

#### 1. The default review is agentic, on a Claude subscription

| Key | 0.1 default | 1.0 default |
|---|---|---|
| `reviewer.provider` | `anthropic` | `claude-cli` |
| `reviewer.mode` | `hunks` (the only mode) | `agentic` with `claude-cli`; `hunks` with any other provider |
| `reviewer.model` | `claude-sonnet-5` for every provider | `claude-opus-5-5` in agentic mode; `claude-sonnet-5` for `anthropic` and for `claude-cli` in `hunks` mode; **required** for `openai` / `deepseek` |
| `reviewer.agentic.effort` | — | `xhigh` |
| `reviewer.verifier` | — | `claude-cli` in agentic mode; `none` in `hunks` mode |
| `reviewer.verifierModel` / `verifierEffort` | — | `claude-sonnet-5` / `medium` |

The rule: `mode`, `model` and `verifier` are left out of
`config/jevest.example.yml` and, when your `.jevest.yml` does not set them,
follow the provider (`resolveReviewerDefaults` in
`src/adapters/config/jevest-config.ts`). Agentic mode only runs on
`claude-cli`, so the default provider is `claude-cli` (an agentic default on
any other provider would be a config error out of the box), and naming any
other provider resolves to `hunks` instead of failing. An explicit value
always wins and is validated as before (`mode: agentic` with another
provider, or a `verifier` in `hunks` mode, is still an error).

What that means for the `.jevest.yml` you have today:

| Your `.jevest.yml` (reviewer part) | 0.1 ran | 1.0 runs |
|---|---|---|
| none, or no `reviewer.provider` | anthropic, claude-sonnet-5, per hunk | **claude-cli, claude-opus-5-5, agentic + verifier** |
| `provider: anthropic` | anthropic, per hunk | unchanged |
| `provider: claude-cli`, no `mode` | claude-cli, per hunk (sonnet unless `model` set) | **agentic + verifier** (opus 5.5 unless `model` set) |
| `provider: claude-cli`, `mode: hunks` | — | claude-cli, claude-sonnet-5 unless `model` set, per hunk (= 0.1) |
| `provider: openai` / `deepseek` with `model` | per hunk | unchanged |
| `provider: openai` / `deepseek` without `model` | sent `claude-sonnet-5` to that API (failed at runtime) | **config error** naming `reviewer.model` |
| `provider: none` | Jev-only | unchanged |

The same rule applies to the local CLIs: a `pnpm review` / `pnpm eval:review`
config with `provider: claude-cli` and no `mode` now runs the agent. Add
`mode: hunks` to a stored eval variant to reproduce a 0.1-era run.

#### 2. Agentic mode needs a checkout of the PR head

0.1 needed no checkout. The agent reads the repository, so the workflow needs,
**before** the Jevest step:

```yaml
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 1
```

The `ref` matters: the default `pull_request` checkout is the merge commit,
whose line numbers differ from the head's, and Jevest refuses it. Without a
checkout of the head the run **fails closed** to the `unavailable` verdict
(neutral check, `jevest: review manually` label); it never falls back to the
per-hunk review silently. The comment, the check summary and a `::warning::`
annotation on the workflow run name the exact step to add.

The checkout does not change where the config comes from: `config-path` is
always fetched from the PR base sha (see item 7).

#### 3. The Claude token is an input you now need, per repository

`claude-cli` needs `claude-code-oauth-token`. Without it, a 0.1 workflow that
only passes `anthropic-api-key` fails the run (red check "jevest: run
failed") with a message naming both fixes: add the token, or set
`reviewer.provider: anthropic`.

- Generate it with `claude setup-token` (Claude Pro/Max) and store it as the
  **repository secret** `CLAUDE_CODE_OAUTH_TOKEN` of each consuming
  repository. **Never as an organization (shared) secret**: one secret per
  repository keeps each project's usage, rotation and revocation
  independent, and a leak or a revocation affects one repository only.
- The token is one person's subscription: every review draws on that quota.
  See [ACTION.md "Claude subscription in CI"](ACTION.md#claude-subscription-in-ci-claude-cli).

#### 4. The `jevest` check carries the review verdict, not the merge gate

Every run ends in one verdict, and the check conclusion comes from it:

| Verdict | Check | When |
|---|---|---|
| `fix` | `failure` (the only red) | at least one published finding |
| `questions` | `neutral` | doubts, an auto-band description mismatch, a possible committed secret |
| `clear` | `success` | nothing to fix or answer |
| `unavailable` | `neutral` | every reviewer call failed (including agentic mode without a checkout), the spend cap skipped the review, or reviewer instructions were suspected |

In 0.1 the check carried the merge gate's conclusion, so a PR with nothing to
fix could go red for not being safe to auto-merge. Now:

- the merge gate only decides `jevest:auto-merge-ok`, which also requires a
  `clear` verdict;
- the `check-conclusion` output and `fail-on: failure` follow the verdict
  (`fail-on: failure` fails the job on `fix` or a fail-closed run);
- the NFR-2 fail-closed exit still publishes a red check, and a suspected
  injection or an auto-band description mismatch still never produces a green
  one;
- the check title and summary are action-oriented and localized by
  `reviewer.language` (Spanish by default, English for any other language),
  e.g. "Corregir 2 problemas antes de mergear" / "Fix 2 issues before
  merging", instead of "Jevest: failure".

If branch protection requires the `jevest` check, it now blocks only on
`fix`. Note that `neutral` (questions, unavailable) does not block a required
check on GitHub; gate on the verdict label if you want `unavailable` to block.

#### 5. `jevest:needs-human` is gone: one verdict label per run

| Verdict | Spanish (`es`, `es-AR`, `es-*`) | English (any other language) |
|---|---|---|
| fix | `jevest: corregir antes de mergear` | `jevest: fix before merge` |
| questions | `jevest: responder dudas` | `jevest: answer questions` |
| clear | `jevest: listo para aprobar` | `jevest: ready to approve` |
| unavailable | `jevest: revisar a mano` | `jevest: review manually` |

Plus a risk label for high/critical (`riesgo: alto` / `risk: high`) and medium
(`riesgo: medio` / `risk: medium`) triage risk. Every run removes the other
verdict labels and the legacy `jevest:needs-human`, so open PRs migrate on
their next run. **Anything filtering PRs, issues or automations on
`jevest:needs-human` must switch to these labels.** Only the current
language's names are managed: after changing `reviewer.language`, delete the
old-language labels by hand. Unchanged: `jevest:auto-merge-ok`,
`jevest:description-mismatch`, `jevest:needs-product-owner`,
`jevest:injected-instructions`, `jevest:spend-warning`,
`jevest:spend-cap-reached`.

#### 6. Smaller behavior changes you may notice

- **More LLM calls per PR with any LLM provider**: the colleague review
  (`reviewer.narrative`) and the author context from the PR description
  (`reviewer.descriptionContext`) are new and on by default for every LLM
  provider; each is one extra call on the reviewer's provider and model,
  counted in `budgetUsd` and the spend cap. Set them to `false` to keep 0.1's
  call count.
- **The summary comment changed shape**: with the narrative on it opens with
  a review in natural language and collapses the rest into "Jevest details";
  "Needs human review" is now "Questions and manual checks".
- **A hunk with a detected secret is reviewed (redacted), not skipped**, and
  raises a visible warning that makes the verdict at least `questions`. In
  the run metrics, `secret` is gone from the skip reasons and
  `metrics.llm.hunks.withSecret` counts those hunks.
- **The secret redactor flags far fewer ordinary assignments** (cache keys,
  CSRF tokens, test passwords), so hunks 0.1 skipped are now reviewed.
- **A relative `config-path` resolves against `GITHUB_WORKSPACE`** when it is
  read from the workspace at all (`config-from-checkout: true`, item 7); in
  0.1 it could pick up Jevest's own `.jevest.yml` in a workflow without
  checkout.
- **New `verdict` output** next to `check-conclusion` (`fix`, `questions`,
  `clear`, `unavailable`); see [ACTION.md "Review verdict"](ACTION.md#review-verdict).
- **The Claude Code CLI is pinned** (`claude-code-version`, default
  `2.1.286`) instead of installing `latest`, and the Action runs on Node 22.

#### 7. `.jevest.yml` always comes from the PR base sha

0.1 read `config-path` from the workspace when the file was there and fell
back to the base sha. With 1.0's checkout of the PR head (item 2) that would
let a PR rewrite the provider, thresholds, budget and skip rules that judge
it, so the Action now **always** fetches it from the base sha. What changes
for you:

- a PR that edits `.jevest.yml` is reviewed with the base branch's config; the
  change applies from the next PR after it merges;
- a workflow step that generated or rewrote `.jevest.yml` in the workspace
  before Jevest no longer has any effect, unless you set the new input
  `config-from-checkout: true` (default `false`). Only do that when the
  workspace is a trusted ref, never a checkout of the PR head; see
  [ACTION.md "Config source"](ACTION.md#config-source-config-path-config-from-checkout).

#### 8. `.jevest.yml` is strict at every level

0.1 rejected only an unknown top-level key; a typo one level down
(`reviewer.mdoe`, `spendCap.usdd`) was silently ignored and the default ran
instead. 1.0 rejects an unknown key at any level, naming the dotted path and
the closest known key (``unknown config key `reviewer.mdoe` (did you mean
`reviewer.mode`?)``), and `skipChangeKinds` only accepts `add-behavior`,
`modify-behavior`, `delete` and `rename-or-format`. A config that loaded in
0.1 with a misspelled nested key now fails the run (red "jevest: run failed"
check naming the key): fix the key, or drop it if it never did anything.


### Before and after

**0.1** — workflow:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: tincke10/Jevest@v0
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

`.jevest.yml`:

```yaml
reviewer:
  provider: anthropic
  model: claude-sonnet-5
```

**1.0, the default (agentic)** — workflow:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 1
      - uses: tincke10/Jevest@v1
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

`.jevest.yml`: nothing about the reviewer is needed (delete the `reviewer:`
block above, or the `provider: anthropic` line in it would keep you on the
per-hunk mode). Optionally:

```yaml
reviewer:
  language: en
spendCap:
  usd: 150        # ~90 PRs a month at ~$1.60 nominal
  warnAtUsd: 120
```

### Staying on the legacy per-hunk mode

`mode: hunks` is legacy but fully supported, needs no checkout and no Claude
subscription, and takes about 25 seconds per run. Its measured quality is far
lower (7.7% weighted recall / 25% precision against 41.7% / 87% for the
agentic default on the same PRs; [BENCHMARK.md](BENCHMARK.md#review-quality-on-real-prs-eval-harness)).

- **Exactly as 0.1, on the Anthropic API**: say the provider. Keep the 0.1
  workflow (with `@v1`) and put in `.jevest.yml`:

  ```yaml
  reviewer:
    provider: anthropic   # resolves to mode: hunks, model: claude-sonnet-5
  ```

- **Per hunk on a Claude subscription**:

  ```yaml
  reviewer:
    provider: claude-cli
    mode: hunks           # resolves to model: claude-sonnet-5, no verifier
  ```

- **OpenAI or DeepSeek**: set the provider and, now required, the model.

Set `reviewer.narrative: false` and `reviewer.descriptionContext: false` as
well if you want 0.1's exact number of LLM calls.

### Cost and time in agentic mode

Measured with the default stack (Opus 5.5 at effort xhigh, the verifier on
Sonnet 5 at effort medium) on real pull requests
([BENCHMARK.md "Review quality on real PRs"](BENCHMARK.md#review-quality-on-real-prs-eval-harness)):

- **≈ $1.60 nominal per PR** (tuning and held-out sets alike). On
  `claude-cli` this is the list-price equivalent the CLI reports, not a bill:
  it draws on the subscription's quota, and it is what `budgetUsd` and
  `spendCap` count.
- **≈ 2.5–7 minutes per PR** for the review itself (≈ 4.5 minutes on average
  on the held-out set), plus the checkout (seconds on a small repo, minutes
  on a very large one) and ~1 minute of setup (Node, dependencies, the
  Claude CLI).

What that means for the defaults:

- `budgetUsd: 5` (per run) covers an agentic run with room to spare; it is
  checked before the agent starts and before each verifier call, while the
  agent itself is bounded by `reviewer.agentic.maxTurns` (60) and
  `timeoutMs` (15 minutes).
- `spendCap.usd: 50` a month covers roughly 30 PRs; after that the LLM stage
  is skipped and the verdict is `unavailable` until the period rolls over.
  Raise it to your PR volume.
- Give the job a `timeout-minutes` well above the agent's 15-minute cap plus
  the verifiers (30 is a safe start).

These numbers come from small sets (6 + 10 PRs from one application); a
larger or more tangled PR takes longer and costs more.

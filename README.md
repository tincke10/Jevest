# Jevest

Automated PR review pipeline using **Jev** (TypeSafe AI) as a millisecond
decision layer over an LLM reviewer: it decides what to review, how much,
and what to publish.

Full design and scope: [docs/SPEC.md](docs/SPEC.md).

Status: phase 0/1 skeleton — hexagonal domain + decision-port adapters
(`fake`, `recorded`, `typesafe`), config-driven confidence bands.

## Environment
Set these as environment variables (never commit them):
`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` (optional), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
The live TypeSafe test runs only when `TYPESAFE_API_KEY` is present.

## Phase 0 spike

`pnpm spike` runs the three hunk serializers from `datasets/hunks.jsonl`
through a DecisionPort and reports **H0** (SPEC §4): can Jev flag a code
defect with recall ≥ 0.85 and F1 ≥ 0.75? Below that, the project pivots
before phase 1 starts.

Modes (`--mode`, auto-detected if omitted — `replay` if fixtures exist
under `tests/fixtures/spike/`, else `dry-run`):
- `dry-run` — no API key needed; `FakeDecisionAdapter` with seeded
  pseudo-random answers. Exercises the pipeline; metrics are meaningless.
- `live` — real Jev calls (`TYPESAFE_API_KEY` required).
- `record` — `live`, wrapped to save fixtures for replay.
- `replay` — fixtures only, no network, no key required.

Once `TYPESAFE_API_KEY` is set, record real answers and see H0:
```sh
TYPESAFE_API_KEY=... pnpm spike --mode record
```

Writes `reports/spike-<timestamp>.json` (gitignored) and `.md` (kept).

## Running tests
```sh
pnpm install && pnpm test && pnpm typecheck
```

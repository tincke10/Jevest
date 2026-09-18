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

## Running tests
```sh
pnpm install && pnpm test && pnpm typecheck
```

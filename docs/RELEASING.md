# Releasing Jevest

Jevest is consumed two ways: as a GitHub Action (`uses: tincke10/Jevest@<ref>`)
and as a set of published datasets and reports. A release is a git tag plus a
GitHub release that carries the datasets. There is no build, no npm package
and no bundle: the Action runs the TypeScript source with `tsx` straight from
the tagged commit, so the tag itself is the artifact.

## What consumers pin

| Ref | Moves? | Use it when |
|---|---|---|
| `@v0.1.0` | never | You want a reproducible workflow. Recommended for anything that gates merges. |
| `@v0` | yes, to the latest `v0.x.y` | You want fixes without editing the workflow and accept behavior changes within the same major. |
| `@main` | every commit | You are developing Jevest itself or dogfooding. Not for other repos. |

`docs/ACTION.md` and `README.md` still show `@main` on purpose until the first
tag exists; once `v0.1.0` is cut, switch both snippets to `@v0`.

Datasets are versioned by their own `dataset_version` field inside each file
(`datasets/README.md`), independent of the package version. A release attaches
the files as they were at the tagged commit.

## Checklist for `v0.1.0`

Run everything from a clean checkout of `main` with `pnpm install` done.

1. **Suite green**: `pnpm test && pnpm typecheck && pnpm lint`.
2. **Every report replays** from the recorded fixtures, without any API key:

   ```sh
   pnpm spike --mode replay
   pnpm spike:profile --mode replay
   pnpm filter --findings datasets/findings.jsonl --mode replay
   pnpm coherence --mode replay
   pnpm adversarial --mode replay      # exits 1 on an H5 FAIL
   pnpm review --diff <any small diff> --mode dry-run

   # H1 / H6 / H3, thorough set against the fix-aware oracle label (DeepSeek judge)
   pnpm filter --findings datasets/findings-thorough-oracle.jsonl \
       --mode replay --judge deepseek --judge-mode replay --label oracle

   # H1 / H6 / H3, H1b: reversed-hunk set against the fix-aware oracle label
   # (claude-cli judge) — the numbers quoted in README.md and docs/BENCHMARK.md
   pnpm filter --findings datasets/findings-reversed-oracle.jsonl \
       --hunks datasets/hunks-reversed.jsonl \
       --mode replay --judge claude-cli --judge-mode replay --label oracle
   ```

   A replay that fails with `MissingFixtureError` means a case or a dataset
   changed after the fixtures were recorded; re-record with `--mode record`
   (needs `TYPESAFE_API_KEY`) before releasing. Do not release on a dry run.
   The `pnpm adversarial` fixtures are the H5 gate: if they do not exist yet
   the vitest suite skips the replay test, and the release notes must say
   H5 is unverified.
3. **Numbers match the docs**: the tables in `docs/BENCHMARK.md` and the
   evidence table in `README.md` quote `reports/*.md` and
   `datasets/FINDINGS.md`. Compare each replayed report against the file it
   cites; update the docs, never the reports.
4. **CHANGELOG**: rename `## [0.1.0] - unreleased` to `## [0.1.0] - YYYY-MM-DD`
   and add a fresh `## [Unreleased]` section above it. Nothing goes into a
   release that is not listed there.
5. **Version**: set `"version": "0.1.0"` in `package.json` (it is `private`,
   so this is documentation, but it must agree with the tag).
6. **Commit** those two edits on `main` (`chore(release): v0.1.0`).
7. **Tag** the release commit, annotated and signed if you sign:

   ```sh
   git tag -a v0.1.0 -m "Jevest v0.1.0"
   git push origin v0.1.0
   ```

8. **Floating major tag** `v0`, created on the first release and moved on
   every later `v0.x.y`:

   ```sh
   git tag -fa v0 -m "Jevest v0 (currently v0.1.0)" v0.1.0
   git push origin v0 --force
   ```

   Moving `v0` is the only force-push this project ever does. Never move a
   `vX.Y.Z` tag: consumers pin those precisely because they do not move.
9. **GitHub release** from the tag, with the datasets attached so they can be
   cited without cloning:

   ```sh
   tar -czf jevest-adversarial-0.1.0.tar.gz -C datasets adversarial
   gh release create v0.1.0 \
     --title "Jevest v0.1.0" \
     --notes-file <(sed -n '/^## \[0.1.0\]/,/^## \[/p' CHANGELOG.md | sed '$d') \
     datasets/hunks.jsonl \
     datasets/hunks-reversed.jsonl \
     datasets/profile-labels.jsonl \
     datasets/findings.jsonl \
     datasets/findings-thorough.jsonl \
     datasets/findings-thorough-oracle.jsonl \
     datasets/findings-reversed.jsonl \
     datasets/findings-reversed-oracle.jsonl \
     datasets/hunk-evidence.jsonl \
     datasets/prs.jsonl \
     datasets/coherence-pairs.jsonl \
     jevest-adversarial-0.1.0.tar.gz
   ```

   The release notes are the CHANGELOG section verbatim: the two must not
   drift. Mention in the notes which hypotheses have a verdict and which
   are pending (`docs/BENCHMARK.md` keeps that list).
10. **Point the docs at the tag**: replace `@main` with `@v0` in
    `docs/ACTION.md` and `README.md`, and delete the "pin once one is cut"
    sentences. Commit as `docs: pin the Action snippets to v0`.
11. **Dogfood**: the repo's own `.github/workflows` runs the Action from
    `main`; open a small PR and confirm a run still completes after the
    tag (nothing in the tag changes runtime behavior, this catches a bad
    `action.yml` reference).

## Later releases

- Patch (`v0.1.1`): bug fixes only, no new config keys. Move `v0`.
- Minor (`v0.2.0`): new stages, providers, config keys with defaults. Move
  `v0`. Any new key must land in `config/jevest.example.yml` with its
  explanation, since that file is the source of defaults.
- Breaking (`v1.0.0`): a config key removed or renamed, a label or check
  name changed, a dataset schema changed without a `dataset_version` bump.
  Start `v1`; leave `v0` where it is.

Datasets: bump `dataset_version` inside the file and document the change in
`datasets/README.md` (as `hunks.jsonl` v1 → v2 did) rather than editing
records in place. Recorded fixtures are keyed by the exact state sent to
Jev, so a dataset change invalidates the fixtures that read from it; re-record
and commit them in the same change.

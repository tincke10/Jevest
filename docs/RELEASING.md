# Releasing Jevest

Jevest is consumed as a GitHub Action (`uses: tincke10/Jevest@<ref>`). There is
no npm package. A release tag points at a commit that adds `dist/main.mjs` (the
Action bundled with esbuild, every dependency inlined) on top of the release
commit on `main`; with it, `action.yml` skips pnpm setup and `pnpm install`
and runs `node dist/main.mjs`. Any ref without `dist/` (`main`, a branch, a
sha) runs the TypeScript source with `tsx` after `pnpm install`, exactly as
before.

**The bundle is built only by the Release workflow**
(`.github/workflows/release.yml`), never on a developer machine: `pnpm bundle`
refuses to run outside CI, `dist/` is git-ignored, and CI fails any change
that commits it. The bundle commit is reachable from the tag only, never
pushed to `main`, so `main` can never carry a bundle that drifted from its
source.

## What consumers pin

| Ref | Moves? | Use it when |
|---|---|---|
| `@vX.Y.Z` | never | You want a reproducible workflow. Recommended for anything that gates merges. |
| `@vN` | yes, to the latest `vN.x.y` | You want fixes without editing the workflow and accept behavior changes within the same major. |
| `@main` | every commit | You are developing Jevest itself. Not for other repos. |

Every snippet in `README.md` and `docs/` pins `@vN` for the current major
(`@v1` today). A test loads every `.jevest.yml` snippet, so run the suite
after touching docs.

Datasets are versioned by their own `dataset_version` field
(`datasets/README.md`), independent of the package version.

## Versioning

- **Patch** (`vN.x.Y`): bug fixes only, no new config keys.
- **Minor** (`vN.X.0`): new stages, providers or config keys with defaults. A
  new key lands in `config/jevest.example.yml` with its explanation.
- **Major** (`vN+1.0.0`): a config key removed or renamed, a label or check
  name changed, a default that changes what a run does, a dataset schema
  changed without a `dataset_version` bump. The old `vN` tag stays where it is.

## Checklist for `vX.Y.Z`

Run it from a clean, up-to-date `main` with `pnpm install` done.

1. **Preconditions**
   - `pnpm vitest run`, `pnpm tsc --noEmit -p .` and `pnpm lint` are green.
   - `CHANGELOG.md` has every change under `## [Unreleased]`; nothing ships
     that is not listed there.
   - A major has its upgrade guide in `docs/MIGRATING.md`, and the CHANGELOG
     links to it.
   - If review quality changed, the eval numbers are measured and written in
     `docs/BENCHMARK.md` (docs/EVAL.md); the docs quote reports, never the
     other way around. If a hypothesis is unverified, the notes say so.
   - If a dataset or recorded fixture changed, replay the reports
     (`pnpm spike --mode replay`, `pnpm adversarial --mode replay`, ...) and
     re-record on `MissingFixtureError`. Do not release on a dry run.
2. **Version bump**: set `"version"` in `package.json` (the package is
   `private`, so this is documentation, but it must agree with the tag).
3. **CHANGELOG**: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a
   fresh empty `## [Unreleased]` above it, and for a major or a notable minor
   open the section with a short "Highlights" paragraph.
4. **Commit** the bump and the CHANGELOG on `main`
   (`chore(release): vX.Y.Z`) and push it. Do not tag it.
5. **Run the Release workflow**: Actions → Release → Run workflow on `main`,
   `version` = `X.Y.Z`, `move_major` on (off only for a patch to an older
   major whose `vN` must stay where it is). From a terminal:

   ```sh
   gh workflow run release.yml -f version=X.Y.Z -f move_major=true
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
   ```

   The workflow, in order:
   - refuses an existing `vX.Y.Z` tag or release, a `package.json` version
     other than `X.Y.Z`, or a CHANGELOG without `## [X.Y.Z]`;
   - `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`,
     `pnpm lint`;
   - `pnpm bundle` → `dist/main.mjs` (+ source map, `dist/README.md`);
   - smoke-tests the bundle: with no inputs it must stop on
     `missing required input "github-token"` (not a module error), and with a
     local `.jevest.yml` holding an unknown key it must report that key, which
     proves `config/jevest.example.yml` resolves from `dist/`;
   - commits `dist/` as `chore(release): vX.Y.Z bundle` (github-actions[bot])
     on top of `main` WITHOUT pushing `main`, creates the annotated tag
     `vX.Y.Z` on it and pushes the tag;
   - with `move_major`, re-points `vN` at the **peeled commit**
     (`git tag -f vN vX.Y.Z^{}`, checked to be a commit) and force-pushes
     only `vN`. A tag pointing at another tag object is a nested tag, and
     `uses: ...@vN` resolution and `git describe` behave unreliably;
   - creates the GitHub release `Jevest vX.Y.Z` with the CHANGELOG section as
     notes.

   Never move or re-create a `vX.Y.Z` tag; a failed run before the tag push
   can simply be re-run. If it failed after pushing the tag (major move or
   release creation), finish those steps by hand as in the fallback below
   rather than re-running.
6. **Release notes**: for a major or a quality change, edit the release the
   workflow created (`gh release edit vX.Y.Z --notes-file <notes.md>`) to add
   the highlights, the results table from `docs/BENCHMARK.md`, breaking
   changes linking `docs/MIGRATING.md` and upgrade steps. Attach the datasets
   only when they changed (`gh release upload vX.Y.Z <assets...>`).
7. **Docs snippets pinned to `@vN`**: after a major, switch `README.md` and
   `docs/` from the previous major (keep it only where a before/after
   migration snippet needs it), commit as `docs: pin the Action snippets to vN`.
8. **Post-release smoke**: in a consumer repo (or a Jevest test PR) pin
    `@vN` and open a small PR. Confirm the run completes, the `jevest` check
    and the labels appear, the log shows the tagged commit and
    `jevest: prebuilt bundle found (dist/main.mjs)`. This catches a bad
    `action.yml` reference, a nested tag or a broken bundle.

## Manual fallback (no Release workflow available)

Still never build locally. Tag the release commit on `main` as before; that
tag has no `dist/`, so consumers run it from source (slower setup, same
behavior):

```sh
git tag -a vX.Y.Z -m "Jevest vX.Y.Z"
git tag -f vN vX.Y.Z^{}
git cat-file -t vN                          # must print "commit"
git rev-parse vN^{commit} vX.Y.Z^{commit}   # must match
git push origin vX.Y.Z
git push origin vN --force                  # the only force-push this project does
gh release create vX.Y.Z --verify-tag --title "Jevest vX.Y.Z" --notes-file <notes.md>
```

(`git tag -f` makes a lightweight tag; that is intended.)

## Datasets

Bump `dataset_version` inside the file and document the change in
`datasets/README.md` rather than editing records in place. Recorded fixtures
are keyed by the exact state sent to Jev, so a dataset change invalidates the
fixtures that read from it; re-record and commit them in the same change.

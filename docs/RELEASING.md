# Releasing Jevest

Jevest is consumed as a GitHub Action (`uses: tincke10/Jevest@<ref>`). There is
no build, no npm package and no bundle: the Action runs the TypeScript source
with `tsx` straight from the tagged commit, so the tag itself is the artifact.

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
   (`chore(release): vX.Y.Z`) and push it.
5. **Annotated tag** on that commit. Never move or re-create a `vX.Y.Z` tag.

   ```sh
   git tag -a vX.Y.Z -m "Jevest vX.Y.Z"
   ```

6. **Floating major tag** `vN`, created with the first `vN.0.0` and re-pointed
   on every later release. Point it at the **peeled commit**, never at the
   annotated tag object: a tag that points at another tag object is a nested
   tag, and `uses: ...@vN` resolution and `git describe` behave unreliably.

   ```sh
   git tag -f vN vX.Y.Z^{}
   git cat-file -t vN          # must print "commit"
   git rev-parse vN^{commit} vX.Y.Z^{commit}   # must match
   ```

   (`git tag -f` makes a lightweight tag; that is intended.)
7. **Push the tags**. The floating tag is the only force-push this project
   does.

   ```sh
   git push origin vX.Y.Z
   git push origin vN --force
   ```

8. **GitHub release** from the tag, with notes: highlights, the results table
   from `docs/BENCHMARK.md` when quality changed, breaking changes linking
   `docs/MIGRATING.md`, and upgrade steps. For changes that only touch a
   section, the CHANGELOG section verbatim is enough. Attach the datasets
   only when they changed.

   ```sh
   gh release create vX.Y.Z --title "Jevest vX.Y.Z" --notes-file <notes.md> [assets...]
   ```

9. **Docs snippets pinned to `@vN`**: after a major, switch `README.md` and
   `docs/` from the previous major (keep it only where a before/after
   migration snippet needs it), commit as `docs: pin the Action snippets to vN`.
10. **Post-release smoke**: in a consumer repo (or a Jevest test PR) pin
    `@vN` and open a small PR. Confirm the run completes, the `jevest` check
    and the labels appear, and the log shows the tagged commit. This catches a
    bad `action.yml` reference or a nested tag.

Datasets: bump `dataset_version` inside the file and document the change in
`datasets/README.md` rather than editing records in place. Recorded fixtures
are keyed by the exact state sent to Jev, so a dataset change invalidates the
fixtures that read from it; re-record and commit them in the same change.

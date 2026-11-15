# Winmux project policy

After bootstrap PR #2 is merged, every future change to code, docs, dependencies, CI, or release preparation must start with a GitHub Issue stating the problem, intended outcome, and acceptance criteria. PR #2 needs no retrospective Issue.

Apply the relevant type labels to both the Issue and PR: `bug` (report), `fix` (repair), `feat`, `docs`, `chore`, or `release`. Work on a focused branch and reference the Issue in the PR; use `Closes` only when the PR fully meets its acceptance criteria. Fixes follow this same process.

Never push directly to `main`. Merge only after relevant checks, independent review, resolution of blocking findings, and green required CI for the current PR head. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for evidence and release requirements.

Release code and version changes require an Issue and PR. An authorized maintainer may tag and publish an existing reviewed commit on green `main` through the release pipeline; the tag itself does not need a separate PR.

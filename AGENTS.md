# Winmux project policy

After bootstrap PR #2 is merged, every future change to code, docs, dependencies, CI, or release preparation must start with a GitHub Issue stating the problem, intended outcome, and acceptance criteria. PR #2 needs no retrospective Issue.

Apply the relevant type labels to both the Issue and PR: `bug` (report), `fix` (repair), `feat`, `docs`, `chore`, or `release`. Work on a focused branch and reference the Issue in the PR; use `Closes` only when the PR fully meets its acceptance criteria. Fixes follow this same process.

Never push directly to `main`. Merge only after relevant checks, independent review, resolution of blocking findings, and green required CI for the current PR head. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for evidence and release requirements.

Release code and version changes require an Issue and PR. An authorized maintainer may tag and publish an existing reviewed commit on green `main` through the release pipeline; the tag itself does not need a separate PR.

After every product update, review both bundled skills (`skills/winmux-terminal` and `skills/winmux-browser`), improve any affected instructions, examples, limits and recovery steps, and verify the related installed-client operations. Record which skills changed, the actual checks and any unavailable environment in the Issue/PR. Unrelated updates need no artificial skill diff, but must still record the review. Run `npm run test:skills`; changes affecting terminal/browser commands also require actual isolated runtime checks through the installed wrappers.

# Winmux project policy

Use English for all project-authored text: GitHub Issues, PR titles/descriptions/comments, documentation, changelogs, release notes, commit messages, code comments and test descriptions. Preserve the application's supported localization strings; this rule does not remove Russian UI translations or override the user's chat language.

After bootstrap PR #2 is merged, every future change to code, docs, dependencies, CI, or release preparation must start with a GitHub Issue stating the problem, intended outcome, and acceptance criteria. PR #2 needs no retrospective Issue.

Apply the relevant type labels to both the Issue and PR: `bug` (report), `fix` (repair), `feat`, `docs`, `chore`, or `release`. Work on a focused branch and reference the Issue in the PR; use `Closes` only when the PR fully meets its acceptance criteria. Fixes follow this same process.

Never push directly to `main`. Merge only after relevant checks, independent review, resolution of blocking findings, and green required CI for the current PR head. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for evidence and release requirements.

Release code and version changes require an Issue and PR. An authorized maintainer may tag and publish an existing reviewed commit on green `main` through the release pipeline; the tag itself does not need a separate PR.

After every product update, review both bundled skills (`skills/winmux-terminal` and `skills/winmux-browser`), improve any affected instructions, examples, limits and recovery steps, and verify the related installed-client operations. Record which skills changed, the actual checks and any unavailable environment in the Issue/PR. Unrelated updates need no artificial skill diff, but must still record the review. Run `npm run test:skills`; changes affecting terminal/browser commands also require actual isolated runtime checks through the installed wrappers.

Use `$winmux-dev` for every Winmux development, debugging, verification, documentation, CI, and release task. Read the canonical `skills/winmux-dev/SKILL.md` before acting; the installed contributor copy is `C:/Users/krach/.agents/skills/winmux-dev`. This development skill complements the bundled terminal/browser operation skills and does not grant additional permissions. Keep its instructions and UI metadata in English. After each relevant update, maintain it in detail: affected contracts and callers, exact commands and prerequisites, observed verification results, limitations, failure recovery, and release/runtime distinctions. Update the installed copy from the reviewed canonical source, report the files and checks in the Issue/PR, and record a no-change review when nothing in the skill is affected. Preserve useful existing detail and never replace evidence with a generic claim of success.

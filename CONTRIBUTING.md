# Contributing to Winmux

Winmux is an early Windows desktop preview. Keep changes small enough to review, and distinguish implemented behavior from behavior verified on a real machine.

## Set up

Use Windows 10/11, Node.js 22.12+ (Node 24 recommended), and PowerShell. PowerShell 7 is recommended. Install Git for project Git views. For WSL work, initialize a distribution and install `python3` and Git in it. Install any AI CLI being tested separately; executable discovery is not an end-to-end agent test.

From the repository root:

```powershell
npm ci
npm run build
npm start
```

Use `npm run dev` for the development app. If a native `node-pty` ABI mismatch occurs after changing Electron or dependencies, run `npm run rebuild` and retry the affected command. Do not copy a native addon built for a different Node/Electron runtime into the application.

For manual experiments, select a disposable data directory before starting the UI and CLIs. In PowerShell, for example:

```powershell
$env:WINMUX_DATA_DIR = Join-Path $env:LOCALAPPDATA 'Winmux-Contributor'
npm start
```

Use the same variable in every terminal controlling that instance. The default data directory may contain somebody's active work. Closing the window keeps terminal sessions running; `shutdown` stops every session in the selected daemon. Stop only sessions you created for the task.

## Issues and pull requests

This policy takes effect after bootstrap PR #2 is merged. PR #2 does not require a retrospective Issue. Every future change, including code, documentation, dependencies, CI, release preparation, and fixes, starts with a GitHub Issue describing the problem, intended outcome, and acceptance criteria.

Use the relevant type labels on both the Issue and its PR:

| Label | Purpose |
| --- | --- |
| `bug` | Report incorrect behavior |
| `fix` | Repair a defect |
| `feat` | Add or change a feature |
| `docs` | Change documentation |
| `chore` | Maintain dependencies, tooling, or CI |
| `release` | Prepare release code, versions, or configuration |

Apply more than one type when relevant; keep the Issue and PR labels aligned with the work. A reported bug can retain `bug` alongside `fix` when its repair is delivered.

Work on a focused branch and open a pull request referencing the Issue. Use `Closes #N` only when the PR fully satisfies the Issue's acceptance criteria; otherwise reference it without closing it. Open a draft PR early when useful, and make the final title and description describe the resulting change. Do not push directly to `main`, including for follow-up fixes.

A PR should include:

- The concrete problem and the resulting behavior, including reproduction steps for a bug.
- Relevant checks and their actual results, with the Windows, Node/Electron, and WSL environment when it affects the result.
- Sanitized screenshots for visible UI changes, plus any known limitation or skipped check.

Run the relevant checks, obtain independent review, and address blocking findings. Merge only after review is complete and all required CI checks are green for the current PR head commit; a green result on an older revision is insufficient. CI alone does not replace code review. An authorized maintainer may merge their own PR after another reviewer has reviewed it and the required checks pass; self-merge does not bypass either requirement. Do not merge while checks are pending or failing.

## Verify the change

The repository defines these checks:

```powershell
npm run build
npm run test:backend
npm run test:workspace
npm run test:cwd-agent
npm run test:profile
npm run test:skills
npm run test:integrations
npm run test:cookies
npm run test:file-preview
npm run test:desktop
node --test tests/release-workflow-regression.cjs
```

`build` type-checks TypeScript and builds the renderer. `test:backend` exercises the terminal daemon and CLI with real PTYs. `test:workspace` creates disposable file/Git fixtures and checks file previews, path boundaries, and Git status/diffs. The focused agent, profile, skills, cookie, and file-preview checks cover their separate contracts. `test:integrations` covers the native Codex transport, mapping/controller, terminal titles, color preservation, and project hook installer/helper. `test:desktop` exercises the real Electron UI and captures evidence. `release-workflow-regression.cjs` runs the embedded release publisher against an external `gh` fixture, including draft lookup and invalid release data. Build before running the desktop check.

The skills suite always verifies Windows installation and unavailable-profile rejection. It registers real WSL installation, interop, and conflict checks only when a distribution is present; its output distinguishes that coverage. Hosted Windows CI has no distribution. Run the complete suite locally with WSL for a release candidate and record that result separately; do not describe the hosted Windows run as WSL verification.

Run the checks relevant to your change locally; integration and release candidates require the full sequence above. Documentation-only changes still need command, link, and claim review. Use existing checks where they cover the behavior, and add regression coverage for meaningful behavior changes. Do not describe an unrun test as passed or a skipped WSL case as supported by evidence.

Keep test data isolated. Preserve useful failure evidence in ignored `.artifacts/`, and include only sanitized summaries in the PR. If an environment is unavailable, record the limitation instead of manufacturing a result. Manual UI checks should cover the changed behavior and keyboard access in both themes when applicable.

## Architecture boundaries

- Terminal processes belong to the background daemon. Closing the UI must not silently kill them; restarting the daemon starts fresh shells without replaying commands.
- The terminal CLI and desktop browser service have separate contracts. Browser automation requires an open desktop and does not go through daemon `rpc` methods.
- The Files panel can edit eligible text files; Git remains read-only. Keep project paths within the selected workspace and use the workspace's Windows or WSL environment.
- Web content must not gain Node.js access or access to the app's privileged preload bridge.
- Preserve explicit unknown states: a running shell or discovered executable does not prove agent activity, hooks, or conversation resume.

## Workspace interface

The workspace rail starts at 60 pixels and expands to 240 pixels through the **Show workspace names** control. Keep project switching available from both the rail and the unified header. The header owns terminal tabs, new-tab and agent-launch actions, confirmed shell or agent status, and project-tool actions; do not restore a separate tab band or status footer. Preserve keyboard access, pointer resizing, the 900-pixel supported minimum window width, all six themes, and English/Russian labels. Agent state must continue to come from real lifecycle or hook events.

Consult [the daemon contract](electron/backend/README.md), [agent guide](docs/agents.md), and [product direction](docs/ideas/winmux.md) before changing these boundaries.

## Secrets and evidence

Never commit capability tokens, `ipc-token`, `ui-control.json`, `.env` secrets, terminal/session logs, private source files, or browser profile data. Treat screenshots and browser snapshots as potentially private: they may expose credentials, terminal output, local paths, or signed-in accounts. Use disposable fixtures and redact sensitive details before attaching evidence. Keep release binaries and generated test output out of source commits.

## Versioned releases

Release code, version, and configuration changes follow the same Issue, typed-label, PR, independent-review, and green-current-head-CI requirements. Prepare the package version, lockfile, changelog, release configuration, and relevant documentation together in a PR referencing its Issue. Ensure the version is consistent before merging.

After that PR is merged and `main` CI is green for the reviewed release commit, an authorized maintainer may create a matching `vX.Y.Z` tag on that commit and publish through the existing release pipeline. Creating the tag or publishing those approved artifacts does not require another Issue or PR; any further code or version change does. Release CI must build and publish the versioned Windows assets from that tag. Verify the published release and its attached executables before announcing availability. A tag or a successful build alone is not proof that users can download the artifacts.

For the current `0.2.0` preparation, the generated names are `Winmux-Setup-0.2.0-x64.exe` and `Winmux-Portable-0.2.0-x64.exe`. These are naming examples, not evidence that the release is available. For another version, substitute its `X.Y.Z` value while keeping the version in both filenames. `npm run package` creates an unpacked app for local inspection; it is not evidence of installer publication. Link users to the repository's [latest release page](https://github.com/samo33ddd/winmux/releases/latest) and verify the attached assets before announcing availability.

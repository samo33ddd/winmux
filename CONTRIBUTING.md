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

## Pull requests only

All source, documentation, dependency, and release changes go through a pull request. Do not push changes directly to the default branch. Work on a focused branch, open a draft PR early when useful, and make the final PR title and description describe the resulting change.

A PR should include:

- The concrete problem and the resulting behavior, including reproduction steps for a bug.
- Relevant checks and their actual results, with the Windows, Node/Electron, and WSL environment when it affects the result.
- Sanitized screenshots for visible UI changes, plus any known limitation or skipped check.

Request code review and address blocking findings. Merge only after review is complete and all required CI checks are green for the current PR revision. CI alone does not replace code review. An authorized maintainer may merge their own PR after another reviewer has reviewed it and the required checks pass; self-merge does not bypass either requirement. Do not merge while checks are pending or failing.

## Verify the change

The repository defines these checks:

```powershell
npm run build
npm run test:backend
npm run test:workspace
npm run test:desktop
```

`build` type-checks TypeScript and builds the renderer. `test:backend` exercises the terminal daemon and CLI with real PTYs. `test:workspace` creates disposable file/Git fixtures and checks file previews, path boundaries, and Git status/diffs. `test:desktop` exercises the real Electron UI and captures evidence. Build before running the desktop check.

Run the checks relevant to your change locally; integration and release candidates require the full sequence above. Documentation-only changes still need command, link, and claim review. Use existing checks where they cover the behavior, and add regression coverage for meaningful behavior changes. Do not describe an unrun test as passed or a skipped WSL case as supported by evidence.

Keep test data isolated. Preserve useful failure evidence in ignored `.artifacts/`, and include only sanitized summaries in the PR. If an environment is unavailable, record the limitation instead of manufacturing a result. Manual UI checks should cover the changed behavior and keyboard access in both themes when applicable.

## Architecture boundaries

- Terminal processes belong to the background daemon. Closing the UI must not silently kill them; restarting the daemon starts fresh shells without replaying commands.
- The terminal CLI and desktop browser service have separate contracts. Browser automation requires an open desktop and does not go through daemon `rpc` methods.
- Files and Git panels are read-only. Keep project paths within the selected workspace and use the workspace's Windows or WSL environment.
- Web content must not gain Node.js access or access to the app's privileged preload bridge.
- Preserve explicit unknown states: a running shell or discovered executable does not prove agent activity, hooks, or conversation resume.

Consult [the daemon contract](electron/backend/README.md), [agent guide](docs/agents.md), and [product direction](docs/ideas/winmux.md) before changing these boundaries.

## Secrets and evidence

Never commit capability tokens, `ipc-token`, `ui-control.json`, `.env` secrets, terminal/session logs, private source files, or browser profile data. Treat screenshots and browser snapshots as potentially private: they may expose credentials, terminal output, local paths, or signed-in accounts. Use disposable fixtures and redact sensitive details before attaching evidence. Keep release binaries and generated test output out of source commits.

## Versioned releases

Release changes follow the same PR, review, and green-CI requirements as every other change. Prepare the package version, lockfile, changelog, release configuration, and relevant documentation together in a PR. Ensure the version is consistent before merging.

After that PR is merged, an authorized maintainer creates a matching `vX.Y.Z` tag on the reviewed commit. Release CI must build and publish the versioned Windows assets from that tag. Verify the published release and its attached executables before announcing availability. A tag or a successful build alone is not proof that users can download the artifacts.

The planned initial preview is `v0.1.0`, with `Winmux-Setup-0.1.0-x64.exe` and `Winmux-Portable-0.1.0-x64.exe`. Later releases should keep the version in both filenames. `npm run package` creates an unpacked app for local inspection; it is not evidence of installer publication. Link users to the repository's [latest release page](https://github.com/samo33ddd/winmux/releases/latest).

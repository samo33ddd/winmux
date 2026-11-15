# Verification

Verified on Windows 11 x64 with Node.js 24.12.0, Electron 45.3.2, PowerShell 7, Git, and WSL Ubuntu-24.04. Tests use disposable data directories and authenticated pipes. The user's existing Winmux daemon and terminal sessions were retained.

## Local checks

- `npm run build`: TypeScript and production renderer build pass.
- `npm run test:backend`: real PowerShell/WSL PTYs, authentication and bounds, input/resize/interrupt, Unicode and alternate screen, ordered snapshots, reconnect with the same PID, notifications, saved layout, fresh-shell recovery, missing-directory recovery, and explicit shutdown pass.
- `npm run test:workspace`: Windows and Ubuntu file listings, Unicode text, image bytes, containment, real Git status and diff pass.
- `npm run test:profile`: normal PowerShell loads the user's profile; custom prompt and `LASTEXITCODE` survive OSC 7 integration.
- `npm run test:cwd-agent`: Windows and Ubuntu Claude/Codex executable fixtures preserve the exact hook arguments, run the real authenticated helper, report running/waiting/completed states, reject stale launch identities, and report failed exits while leaving the shell alive. Also verifies inactive-tab split/resize/close ownership, cwd inheritance, containment, fresh-shell restoration, and no agent replay. The WSL-to-Windows helper path is exercised by execution, not only string inspection.
- `npm run test:skills`: nine checks pass, including input validation, shell readiness, command submission, timeout/failure handling, and settings form interaction. These checks do not download third-party skills.
- `npm run test:cookies`: cookie input normalization, domain scope, host-only, expiry, SameSite, partition rejection, and invalid input pass.
- `npm run test:desktop`: real Electron/PowerShell/WSL, Unicode, splits, close/reopen with the same shell PID, six themes, English/Russian labels, custom theme import/export, terminal preferences, and resize pass. Terminal tabs and fixture-agent launch remain within the selected workspace; independent output/PIDs and active selection survive tab switching and renderer reload. Files follow both `cd` and terminal-tab selection. Browser open/snapshot/fill/click/evaluate/screenshot, HttpOnly cookie import, and independent browser-tab state pass. No renderer errors or residual UI error banners were observed.

## Windows 0.2.0 verification

- `npm run build` passes for package version `0.2.0`.
- All local checks passed: backend, workspace, cwd-agent, profile, nine skills checks, cookies, six file-preview parser checks plus file-reader coverage, and five release-publishing checks. Build and Desktop also passed separately.
- `npm run test:desktop` passes against the implemented workspace UI. `.artifacts/desktop-report.json` records `status: passed`, 15 finding groups, and zero renderer errors. It records the 60-pixel rail expanding to 240 pixels, one header replacing the old tab band and status footer, real PowerShell/WSL output, split panes, same-PID reconnect, 1360×900 and 960×640 layouts, the 960-pixel header agent name, and the collapsed-rail agent-state marker. The 390-pixel stress capture is diagnostic; the supported minimum remains 900 pixels.
- The desktop run retains six themes, English/Russian controls, custom theme import/export, terminal preferences, independent terminal tabs and processes, directory-following Files/Git, embedded browser tabs and cookie scope, supported-agent hooks, and the internal file preview.
- `node --test tests/release-workflow-regression.cjs` passes all five publishing-boundary checks: flattened artifact download, new-draft publication, existing-draft publication, malformed-asset rejection, and tag-mismatch rejection.
- No new real-model inference or model-completion claim is made. The agent capture uses a deliberately local executable fixture.

Issue #4 has independent Sol R1 PASS with no findings. Sol's targeted new-UI verification marks I3-R1-01 through I3-R1-04 resolved at source fingerprint `0ef1605365f33a237c92f8d9b7489db950267d49d926c2921fbb4d974192137f`. Its recorded runtime evidence confirms nonzero tab widths at 1360, 900, and expanded-rail 960 layouts, hover and click coverage for the launcher, visible zoom restore followed by both pane headers returning, and workspace-switcher closure on outside click, Escape, and focus loss. It reports zero renderer errors.

## Local file preview and packaged application

The bounded, read-only local file preview passes six link-parser tests and file-reader checks for Windows and Ubuntu. The Desktop run includes clicking an actual terminal image path, opening text and images through the real CLI, missing-file failure, Escape dismissal, and no extra BrowserWindow, with no renderer errors.

After the production build, `npx electron-builder --win nsis portable --x64 --publish never` completed successfully for 0.2.0. The local `node .artifacts/packaged-smoke.cjs` probe completed with `PACKAGED_SMOKE_OK` against the standalone executable. It exercised real ConPTY, terminal tabs, the ASAR hook helper, and the packaged CLI image path. The image opened in-app with metadata-only response data, no data URL in the response, and `naturalWidth > 0`. This verifies the packaged application but does not establish installer execution, signed-binary trust, or published release availability.

## Real CLI launch observation

Installed Windows Codex and Claude Code were launched through the new daemon with session hooks enabled, in an isolated data directory. Codex displayed its real interactive TUI; Claude Code displayed its trust screen. No model prompt was submitted, no task completion or paid inference is claimed, and the test terminated only the sessions it created. This complements safe executable fixtures; it does not prove every CLI/provider/configuration combination works.

## Screenshots

The six images in `docs/screenshots/` were inspected for private content and refreshed from final repaired-source runs. `workspace-dark.png` and `workspace-light.png` show the redesigned rail, unified header, status treatment, and split shells in both themes. `project-tools.png` shows the Files inspector beside the terminals. `terminal-tabs-agent.png` shows a local executable fixture reporting completed status, not a model conversation. `settings.png` shows the six themes, custom-theme actions, and language controls. `file-preview.png` shows the fresh packaged 0.2.0 application displaying Winmux's own logo through the in-app preview.

## Upgrade and remaining limits

An already-running daemon keeps its loaded code after an application update. A legacy daemon was observed locally without the new capabilities. It was not restarted: the new UI detects it, explains the required explicit stop/reopen, and disables unsupported tab/agent operations.

Daemon/Windows restart creates fresh shells and clears current agent identity; it never resumes an agent conversation or replays commands. Activity without supported hooks remains unknown. Shell directory tracking updates at prompts, not inside foreground applications. Agent hooks require compatible CLI versions; Windows session hooks require PowerShell 7.3+. MCP, automatic worktrees, and Windows CLI invocation from inside WSL are not verified capabilities.

Release availability is established only by the published GitHub release and its downloadable installer/portable assets. The 0.2.0 checks above do not establish publication, installer execution, or signed-binary trust.

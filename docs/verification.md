# Verification

The 0.2.2 candidate has a separate [verification record](verification-0.2.2.md), including the file editor, highlighting, installed skill clients and completion notifications. The older observations below retain their original scope.

Verified on Windows 11 x64 with Node.js 24.12.0, Electron 45.3.2, PowerShell 7, Git, and WSL Ubuntu-24.04. Tests use disposable data directories and authenticated pipes. The user's existing Winmux daemon and terminal sessions were retained.

## Local checks

- `npm run build`: TypeScript and production renderer build pass.
- `npm run test:backend`: real PowerShell/WSL PTYs, authentication and bounds, input/resize/interrupt, Unicode and alternate screen, ordered snapshots, reconnect with the same PID, notifications, saved layout, fresh-shell recovery, missing-directory recovery, and explicit shutdown pass.
- `npm run test:workspace`: Windows and Ubuntu file listings, Unicode text, image bytes, containment, real Git status and diff pass.
- `npm run test:profile`: normal PowerShell loads the user's profile; custom prompt and `LASTEXITCODE` survive OSC 7 integration.
- `npm run test:cwd-agent`: Windows and Ubuntu Claude/Codex executable fixtures preserve the exact hook arguments, run the real authenticated helper, report running/waiting/completed states, reject stale launch identities, and report failed exits while leaving the shell alive. Also verifies inactive-tab split/resize/close ownership, cwd inheritance, containment, fresh-shell restoration, and no agent replay. The WSL-to-Windows helper path is exercised by execution, not only string inspection.
- `npm run test:skills`: thirteen local checks pass, including fixed bundled skill selection, all destination mappings, atomic conflict preservation, nested runtime junction containment, unavailable-profile rejection, installed client IPC from unrelated directories, and real Windows/Ubuntu WSL installation and interop. These checks do not download third-party skills.
- `npm run test:cookies`: cookie input normalization, domain scope, host-only, expiry, SameSite, partition rejection, and invalid input pass.
- `npm run test:desktop`: real Electron/PowerShell/WSL, Unicode, splits, close/reopen with the same shell PID, six themes, English/Russian labels, custom theme import/export, terminal preferences, and resize pass. Terminal tabs and fixture-agent launch remain within the selected workspace; independent output/PIDs and active selection survive tab switching and renderer reload. Files follow both `cd` and terminal-tab selection. Browser open/snapshot/fill/click/evaluate/screenshot, HttpOnly cookie import, and independent browser-tab state pass. No renderer errors or residual UI error banners were observed.

## Windows 0.2.1 verification

The production renderer build and the backend, workspace, cwd/agent, profile, skills, cookies, desktop, and file-preview checks pass locally. The Electron desktop run verifies live OSC terminal titles, same-workspace tabs and fixture-agent launch, six themes, sidebar controls at the top, terminal-following file roots, and in-app text/image previews without renderer errors. README screenshots are captured from isolated Electron instances using harmless fixtures.

The native integration checks cover WebSocket handshake and request/response separation, active/waiting/idle/completed/failed states, ambiguous and stale mappings, explicit binding, disconnect behavior, terminal title modes, and color preservation through real ConPTY and snapshot reattach. Five project-hook installer/helper checks include running the generated command through `cmd.exe` using literal percent-variable names, spaces, Unicode, and shell metacharacters. The inherited stale `WINMUX_PANE_ID` is excluded from native Codex hook payloads.

The repaired integration suite passes 45 tests with zero skips, followed by controller and title-mode smoke checks. It covers full-root hook ambiguity, bounded thread and loaded-thread pagination, incomplete/cyclic enumeration, thread/session identity changes, and disconnects without panes. A fresh production-controller read-only probe mapped both existing owner sessions to their correct native roots with `running` state; identity patches remained in memory.

The wired Electron preview regression passes against the production renderer. It verifies hide/show lifetime, cross-pane ordering, visible inactive split failures, successful Files and CLI previews superseding older errors, English/Russian errors, and recovery through a valid link. Its pre-repair renderer fails the hide/show counterexample. Terminal output, hover, scrolling, selection, resize, and snapshot reattach do not activate links.

The separate Electron agent integration fixture clicks the actual Settings hook-install button, verifies the written config/helper and Codex trust instruction, and repeats the action without changing either file. It uses production system-Node discovery. It also opens the real application icon in the in-app viewer and waits for decoded image dimensions before capturing screenshots. The test does not trust hooks or start a model turn.

A read-only probe with installed Codex 0.167.0 found two loaded root threads and correctly mapped the existing Winmux and hd-helper Codex descendant processes to their respective panes. A third shell in hd-helper had no Codex process and was left unmapped. Candidate status patches were collected only in memory; no input, prompt, approval response, or state mutation was sent to the owner's sessions. This proves native discovery and mapping separately from the fixture event-transition tests.

Local skill checks run all three real Ubuntu 24.04 WSL cases. Hosted Windows CI has no WSL distribution: it runs the Windows and explicit unavailable-profile checks and does not register the three unavailable runtime cases. Its output identifies WSL runtime as unverified on that runner; a green Windows CI result does not claim WSL ran there. Local WSL evidence remains a separate release-candidate check.

Ten release-workflow regressions pass, including new draft visibility lag, bounded exhaustion, API errors, duplicate or published drafts, mismatched tags, and malformed assets. Publication and downloaded executable verification are separate from these local checks.

The original automatic `C:\root\collision_verdict3` request has not been traced from the owner's session. Issue #13 remains the source of that report; readable error handling alone is not evidence that its original trigger was established.

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

The seven images in `docs/screenshots/` were inspected for private content and captured from isolated 0.2.1 Electron fixture runs. `workspace-dark.png` and `workspace-light.png` show the rail, unified header, status treatment, and split shells in both themes. `project-tools.png` shows the Files inspector beside the terminals. `terminal-tabs-agent.png` shows a local executable fixture reporting completed status, not a model conversation. `settings.png` shows the six themes, custom-theme actions, and language controls. `agent-integrations.png` shows the project-hook installation result and Codex trust instruction. `file-preview.png` shows Winmux's logo decoded in the in-app viewer. Local paths in the last two images are masked.

## Upgrade and remaining limits

The Windows activity change for Issue #19 verifies primary-process detection for Codex, Claude, OMP, Hermes, and Pi, lifecycle/tool correlation, stale process/session rejection, and explicit shared-gateway Hermes binding. The integration suite passes 116 Node tests plus the isolated native Codex controller, shared-agent controller with real PowerShell PTYs, and title/mapping checks. The renderer build, PowerShell profile check, cookie check, and release-workflow regressions pass. The actual Electron renderer verifies five names, action icons/captions, en/ru, six themes, expanded sidebar, compact rail, header, keyboard selection of a Hermes session, and all five adapter choices. New screenshots use sanitized lifecycle fixtures, not five paid model sessions.

Installed OMP 18.20.2 was also started through a selected-agent launch in a disposable Windows workspace with its configured extension and real process detection. Its root `session_start` reached the authenticated backend and produced `idle` with a confirmed session, without a model prompt. This exposed and verified fixes for OMP/Bun's process-relative clock and adapter configuration loading. Only this probe's panes were stopped.

The Hermes adapter also checks independently proven concurrent CLI roots and keeps its reporting identity across compression/reset. Python/Node monotonic clocks were compared on the Windows contributor host. Pi lifecycle/discovery was checked against source 0.73.1; a live Pi installation was unavailable. No model prompt was submitted by these checks. The owner's running terminals and daemon were preserved, WSL runtime checks were not run locally, and published 0.2.1 artifacts were not replaced. Current-head CI and independent review are recorded in the associated PR.

An already-running daemon keeps its loaded code after an application update. A legacy daemon was observed locally without the new capabilities. It was not restarted: the new UI detects it, explains the required explicit stop/reopen, and disables unsupported tab/agent operations.

Daemon/Windows restart creates fresh shells and clears current agent identity; it never resumes an agent conversation or replays commands. Codex activity requires verified native mapping or a supported hook; other activity without supported hooks remains unknown. Shell directory tracking updates at prompts, not inside foreground applications. Agent hooks require compatible CLI versions; Windows session hooks require PowerShell 7.3+. MCP and automatic worktrees are not verified capabilities. The installed skills' Windows Node.js interop bridge is tested from Ubuntu; arbitrary Windows CLI use inside WSL is not covered by that check.

Release availability is established only by the published GitHub release and its downloadable installer/portable assets. The 0.2.0 checks above do not establish publication, installer execution, or signed-binary trust.

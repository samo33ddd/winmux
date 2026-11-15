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

## Minimal desktop redesign

The final full `npm run test:desktop` passes with the redesigned interface. The refreshed screenshots show the implemented flat graphite surfaces, slim project sidebar, compact terminal tabs, subtle separators, restrained mint accents, and light theme. The default-enabled agent status hooks preference persists locally in Settings → Behavior, initializes new workspace launches, and retains supported-agent filtering. This documents implemented UI and actual Electron captures; no generated design or external design-service approval is claimed.

## Local file preview and packaged application

The bounded, read-only local file preview passes six link-parser tests and file-reader checks on Windows and Ubuntu. The final desktop run passes all 14 checks with real PowerShell and Ubuntu shells, including clicking an actual terminal image path, opening text and images through the real CLI, missing-file failure, Escape dismissal, and no extra BrowserWindow. No renderer errors were observed.

The final production build passes, and `electron-builder` completed the Windows installer and portable builds. The extended `.artifacts/packaged-smoke.cjs` passes against the actual `release/win-unpacked/Winmux.exe`, exercising ConPTY, terminal tabs, and the ASAR-packaged helper. The packaged ASAR CLI opens an image inside the app, returns metadata only, and the displayed image has `naturalWidth > 0`. This verifies the unpacked packaged application; it does not establish installer execution or published release availability.

## Review closure

Sol's targeted verification marks R1-PV-01 through R1-PV-04 resolved at source fingerprint `a1e337ed48c2013b4bbcf0df675d1858880a2504a2c6a3c7572c1781f030b671`. The original R1 findings are also resolved. This is bounded verification of the R1 repairs, not a second full review round.

## Real CLI launch observation

Installed Windows Codex and Claude Code were launched through the new daemon with session hooks enabled, in an isolated data directory. Codex displayed its real interactive TUI; Claude Code displayed its trust screen. No model prompt was submitted, no task completion or paid inference is claimed, and the test terminated only the sessions it created. This complements safe executable fixtures; it does not prove every CLI/provider/configuration combination works.

## Screenshots

The five images in `docs/screenshots/` come from isolated Electron runs and were visually inspected for private content. They show fixture shell output and project assets. `workspace-dark.png`, `workspace-light.png`, and `project-tools.png` show the redesigned workspace and existing project tools. `terminal-tabs-agent.png` shows a deliberately local executable fixture completing with exit code zero, rather than a model conversation. `file-preview.png` shows the packaged application's in-app image viewer displaying Winmux's own logo asset. Desktop and compact states were exercised at 1360px and 960px window widths. A 390px stress capture was diagnostic only; supported minimum window width remains 900px.

## Upgrade and remaining limits

An already-running daemon keeps its loaded code after an application update. A legacy daemon was observed locally without the new capabilities. It was not restarted: the new UI detects it, explains the required explicit stop/reopen, and disables unsupported tab/agent operations.

Daemon/Windows restart creates fresh shells and clears current agent identity; it never resumes an agent conversation or replays commands. Activity without supported hooks remains unknown. Shell directory tracking updates at prompts, not inside foreground applications. Agent hooks require compatible CLI versions; Windows session hooks require PowerShell 7.3+. MCP, automatic worktrees, and Windows CLI invocation from inside WSL are not verified capabilities.

Release availability is established only by the published GitHub release and its downloadable installer/portable assets. Local checks do not by themselves establish publication, installer execution, or signed-binary trust.

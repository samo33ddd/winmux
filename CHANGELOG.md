# Changelog

User-visible changes are recorded here. Release availability and downloadable assets are authoritative on the [releases page](https://github.com/samo33ddd/winmux/releases).

## Unreleased

## 0.2.3 — Project tasks and clearer agent activity

### Added

- Group isolated tasks by project, create or attach Git worktrees on Windows and WSL, and retain task metadata when terminals close (Issue #41).
- Find agents that need input, failed, or completed in a dedicated attention inbox, with confirmed state durations and navigation to the owning pane (Issue #41).
- Submit task pull requests and inspect delivery blockers from Winmux. Guarded merge requires independent review and green required checks on the exact task head; missing prerequisites remain visible (Issues #41 and #49).
- Record completed independent native reviews against the exact task commit for single-maintainer delivery. Explicit local review evidence survives restarts; new commits, requested changes, repository review rules and failed CI still block merging (Issue #54).
- Deliver task instructions to Codex through a reviewed, trusted UserPromptSubmit hook without replacing user instructions, hooks, model, provider, or permissions (Issue #41).

### Fixed

- Keep large Unicode pastes ordered and allow Ctrl+Space terminal input; open Ctrl+Click web links in the owning workspace's embedded browser (Issues #32 and #38).
- Move terminal panes across tabs without restarting their processes, and make empty tab-strip space available for native window dragging (Issues #33 and #34).
- Keep Windows Codex hook activity associated with its launch context even when the shared daemon has stale environment (Issue #39).
- Preserve a single Files tree and editor when switching terminals or directories; retain shared drafts and browser state (Issue #48).
- Refine agent identity, lifecycle and action hierarchy in the workspace list and terminal header. Keep a generic task-processing caption during confirmed activity before a specific tool event is available (Issue #52).

### Recovery and compatibility

- Document safe recovery when an active portable extraction loses ICU or V8 snapshot resources: restore only missing files from the matching build and verify real hooks without restarting terminal sessions (Issue #51).
- Existing running daemons retain their original capabilities. Closing the window alone does not upgrade the daemon; finish active sessions before deliberately restarting to enable project tasks.
- Codex task hooks require explicit review and trust. A fresh launch can require renewed trust; unavailable native Linux Codex runtime coverage is not implied by Windows or WSL bridge checks.

## 0.2.2 — Files, agent notifications and skill maintenance

### Added

- Show verified agent identity, lifecycle state and current action for Codex, Claude, OMP, Hermes and Pi; install project-local adapters from Settings and bind shared Hermes sessions explicitly (Issues #17 and #19, merged before this release).
- Open file previews to the left of the project tree with a keyboard and pointer resizer. Wrap and edit complete UTF-8 text up to 512 KB, save with Ctrl+S or the Save button, and reject stale external changes (Issue #22).
- Render Markdown headings, lists, emphasis and fenced code without executing raw HTML or loading remote images. Highlight known source languages while editing and in fenced Markdown blocks (Issues #22 and #26).
- Create pane/workspace notifications for confirmed completed agent turns, failures and process exits; repeated status observations do not duplicate them (Issue #27).

### Fixed

- Keep file drafts and save locks consistent across file and terminal switches; warn before discarding unsaved edits and clean up drafts when their owner closes (Issue #22).
- Clear exit codes from previous agent launches when a new identity is observed, and display them only for completed or failed launches. Unavailable activity remains explicit (Issue #23).
- Keep terminal tabs close to the project name instead of reserving a wide empty header slot (Issue #24).

### Maintenance and limitations

- Update both bundled Winmux skills for the current file, cwd and status behavior, require reviewing them after product updates, and verify installed terminal/browser client operations on isolated fixtures (Issue #25).
- The owner confirmed that Issue #13 no longer recurs after 0.2.1; the current automatic-open/error/recovery regression passes. The historical initiating request remains unproven; its diagnosis is not claimed by this release.

- Queue short terminal request bursts within count and byte limits; cancel unsent input on disconnect or an active request timeout instead of replaying it (Issue #15).
- Leave stopped WSL distributions stopped during environment discovery; check their agents only when explicitly launched (Issue #16).

## 0.2.1 — Agent integration fixes

### Added

- Connect to the existing native Codex daemon and show process-verified agent identity, activity, waits, and completed turns; select a thread explicitly when automatic binding is ambiguous (Issues #6 and #10).
- Install project-local Codex status hooks from Settings with config merging, backups, stable helper files, and an explicit Codex trust-review step (Issue #10).

### Fixed

- Automatic terminal tab titles follow the selected pane's live title while explicitly named tabs retain their names (Issue #6).
- Settings installs only the bundled `winmux-terminal` and `winmux-browser` skills, preserving existing conflicting skill folders (Issue #7).
- Installed skills include a client usable from unrelated projects and packaged builds, including Windows Node.js interop from WSL (Issue #11).
- Moved the sidebar collapse and expand control beside the logo at the top of the workspace rail and expanded list (Issue #8).
- Remove inherited terminal color overrides so Codex can render its selected `/theme` with ANSI and truecolor support (Issue #9).
- Wait for a newly created release draft to become visible before publishing, with bounded retries and the existing tag, artifact, and checksum validation (Issue #12).

## 0.2.0 — Dark workspace redesign

### Changed

- Replaced the separate sidebar, tab strip, and footer chrome with a 60-pixel workspace rail that expands to a resizable 240-pixel project list, giving projects more direct access without spending terminal width (Issue #3).
- Consolidated project switching, terminal tabs, new-tab and agent-launch actions, confirmed shell or agent status, and project-tool controls into one header (Issue #3).
- Refined the Files, Git, and Browser inspector and Settings so existing project tools, six themes, custom palettes, and English/Russian controls remain available with less surrounding chrome (Issue #3).

### Fixed

- Release artifacts now download into the publishing root before exact bundle validation, preventing a successful build from failing the four-file release check (Issue #4).
- Draft releases are now resolved by release ID instead of calling the tag endpoint before publication, allowing the separate write-token job to resume uploads and publish reliably (Issue #4).

### Release status

Release availability and downloadable assets are authoritative on the [releases page](https://github.com/samo33ddd/winmux/releases).

## 0.1.0 — Initial preview

### Added

- Windows terminal workspaces using Electron, xterm.js, and ConPTY, with Windows and WSL shell profiles.
- Terminal tabs inside each workspace, each with its own split layout and running shells; new tabs inherit the active terminal directory.
- Split panes, keyboard navigation, terminal search, copy on selection, clipboard actions, six themes, custom theme import/export, terminal preferences, and English/Russian UI.
- A background terminal daemon, reconnectable screen state, and saved workspace layouts and metadata.
- Notifications linked to terminal panes and a local terminal control CLI.
- Read-only project files, text and image previews, Git branch/status, and diff views that follow the active PowerShell or WSL Bash directory.
- Bounded, read-only local file previews inside Winmux, opened from terminal file links or the local CLI.
- Installed-agent launch inside the current workspace, agent identity and explicit lifecycle/status reporting.
- An embedded tabbed HTTP(S) browser, domain-scoped cookie import, and desktop-only browser automation with snapshots, click/fill actions, JavaScript evaluation, and screenshots.
- Project-scoped skill installation from Settings with a preview of the command.
- Detection of older daemons so unsupported new operations explain the required restart instead of silently doing nothing.
- English documentation, contribution guidance, and repository-shipped terminal and browser agent skills.

### Changed

- Minimal, flat graphite desktop interface with a slim project sidebar, compact scrollable terminal tabs, subtle separators, and restrained mint focus accents. Native Windows chrome, six themes, custom palettes, and English/Russian controls remain available.
- Moved the default-enabled agent status hooks option into Settings → Behavior and persist its value locally. Hooks remain limited to supported agents.

### Fixed

- Keep host-only imported cookies on their original host; domain cookies retain their intended subdomain scope.
- Isolate Electron's Node-only mode to daemon and hook helper processes so Electron applications can start normally inside terminal panes.

### Preview limits

- Restarting the daemon or Windows starts fresh shells; commands and agent conversations are not replayed or resumed.
- Agent state depends on actual lifecycle and hook events; unknown activity is shown explicitly. Discovery alone is not a working-agent guarantee.
- MCP and Windows CLI interop from WSL are not verified capabilities. A shell reports its directory at the prompt, not inside a foreground program.
- Browser automation requires an open desktop. Browser popups, downloads, and permission requests are blocked.
- Files and Git views do not edit files, stage changes, commit, or create worktrees.

### Release assets

- `Winmux-Setup-0.1.0-x64.exe`
- `Winmux-Portable-0.1.0-x64.exe`

This entry describes the initial preview scope. Release availability is established by the releases page and its downloadable assets. See [verification notes](docs/verification.md) for recorded checks and remaining limits.

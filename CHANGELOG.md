# Changelog

User-visible changes are recorded here. Release availability and downloadable assets are authoritative on the [releases page](https://github.com/samo33ddd/winmux/releases).

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

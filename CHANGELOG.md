# Changelog

User-visible changes are recorded here. Release availability and downloadable assets are authoritative on the [releases page](https://github.com/samo33ddd/winmux/releases).

## 0.1.0 — Initial preview

### Added

- Windows terminal workspaces using Electron, xterm.js, and ConPTY, with Windows and WSL shell profiles.
- Terminal tabs inside each workspace, each with its own split layout and running shells; new tabs inherit the active terminal directory.
- Split panes, keyboard navigation, terminal search, copy on selection, clipboard actions, six themes, custom theme import/export, terminal preferences, and English/Russian UI.
- A background terminal daemon, reconnectable screen state, and saved workspace layouts and metadata.
- Notifications linked to terminal panes and a local terminal control CLI.
- Read-only project files, text and image previews, Git branch/status, and diff views that follow the active PowerShell or WSL Bash directory.
- Installed-agent launch inside the current workspace, agent identity and explicit lifecycle/status reporting.
- An embedded tabbed HTTP(S) browser, domain-scoped cookie import, and desktop-only browser automation with snapshots, click/fill actions, JavaScript evaluation, and screenshots.
- Project-scoped skill installation from Settings with a preview of the command.
- Detection of older daemons so unsupported new operations explain the required restart instead of silently doing nothing.
- English documentation, contribution guidance, and repository-shipped terminal and browser agent skills.

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

This entry describes the initial preview scope; it does not certify a completed release or a runtime verification pass. See [verification notes](docs/verification.md) for recorded checks.

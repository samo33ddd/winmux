# Winmux

**For developers who live with AI agents, 24/7 on Windows.**

A Windows terminal workspace for AI coding agents, inspired by [cmux](https://cmux.com). An independent Electron + xterm.js + ConPTY implementation.

**Early development.** This repository is being built and tested on Windows. See [verification notes](docs/verification.md) for the scope of actual tests and known gaps; a saved plan does not imply a working feature.

## Run from source

Requirements: Windows 10/11, Node.js 22.12+ (Node 24 recommended), PowerShell (PowerShell 7 recommended). WSL is optional; install and initialize a distribution before using it in Winmux.

```powershell
npm ci
npm run build
npm start
```

After building, double-click **Winmux.cmd** to open the app. For renderer development use `npm run dev`. `npm run package` produces an unpacked application under `release/`.

The Electron window uses an isolated preload bridge. Shells live in a separate daemon: closing the window detaches the UI; reopening reconnects to those sessions. Use **Alt → Winmux → Завершить все сессии и выйти…** to explicitly stop all processes. Rebooting the computer cannot preserve running processes; saved layout starts fresh shells and never replays the previous commands.

## Daily use

- Create a workspace with its startup directory and explicit Windows or WSL profile.
- Split panes horizontally or vertically and resize the divider.
- Switch projects from the sidebar; search terminal output; zoom the focused pane.
- Use notifications to jump directly to the terminal needing attention.
- Change font size and choose a dark or light theme.

Windows directories and Linux directories are different namespaces. The folder picker selects Windows paths; type Linux paths for WSL. The displayed directory is the **startup** directory until shell integration is implemented.

| Shortcut | Action |
| --- | --- |
| Ctrl+Shift+N | New workspace |
| Ctrl+Shift+D | Split to the right |
| Ctrl+Shift+E | Split below |
| Ctrl+Shift+W | Close the focused pane |
| Ctrl+Shift+F | Search terminal output |
| Ctrl+Shift+Enter | Zoom pane / restore layout |
| Alt+arrow | Move pane focus |
| Ctrl+Shift+C / V | Copy / paste |
| Alt | Show application menu |

## Local automation

Start the app first. The CLI talks to the same local daemon over an authenticated named pipe. See its current commands:

```powershell
npm run cli -- --help
```

The underlying API is documented in [the implementation contract](docs/implementation-contract.md). Input is sent to real shells and may execute commands; treat access to the local API like access to your terminal.

Local state and the pipe capability token stay under `%LOCALAPPDATA%/Winmux/`; set `WINMUX_DATA_DIR` to use an isolated instance. Terminal output and tokens do not belong in Git. External terminal links request confirmation before opening in the browser.

## Development checks

```powershell
npm run build
npm run test:backend
npm run test:desktop
```

The desktop smoke test uses an isolated data directory, opens real Electron windows, exercises shells, and writes screenshots and a report into ignored `.artifacts/`. WSL verification depends on an installed usable distribution. Tests must not stop user sessions.

## Contributing

Contributions are welcome: bug reports, Windows and WSL testing, accessibility improvements, UI refinements, documentation, and agent integrations.

Open an issue to discuss substantial changes, or submit a focused pull request with the problem, the resulting behavior, and the checks you actually ran. Include screenshots for UI changes and reproduction steps for bugs. Keep credentials, local sessions, terminal logs, and private data out of commits and screenshots.

All changes go through pull requests. Complete code review, address blocking feedback, and wait for the required CI checks to pass before merging. Release versions and notes follow the same review process.

## Roadmap

The [product specification](docs/ideas/winmux.md) separates the first working core from later work. Agent-specific hooks/resume, browser panes, Git/worktree features and MCP are not implicitly supported by a generic shell launcher. A running shell is not evidence that an AI agent is thinking or waiting.

No affiliation with cmux. No API keys or model subscriptions are bundled.

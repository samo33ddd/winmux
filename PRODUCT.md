# Winmux
Windows desktop terminal multiplexer for working with AI CLI agents across projects. Inspired by cmux, built independently. User requires attractive, minimal, immediately understandable interface and comfortable keyboard use. Windows PowerShell and WSL are first-class explicit launch environments.

The primary scene is long desktop coding sessions, often in subdued ambient light; dark graphite is default, with a light theme for brighter rooms. The terminal content is the product: chrome supports it and never crowds it out.

First delivery: real interactive shells, workspace navigation, split panes with resize, search, explicit notifications, CLI control, persistent daemon and layout. Close-window means detach. Terminate-session and quit-all must be explicit. Agent status is unknown unless explicitly signalled. User clarified that copy-on-selection, paste, a real embedded browser, image preview, a file browser and Git branch/status/diff are REQUIRED now. Worktree automation and specific AI hook adapters remain later scope.

Source: docs/ideas/winmux.md. Implementation contract: docs/implementation-contract.md. Work is authorized in E:/projects/winmux. No fake terminal output or activity.

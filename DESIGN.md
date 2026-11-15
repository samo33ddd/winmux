# Winmux design system

## Direction
Quiet Linear/Raycast-like Windows workspace. One thin project rail and one 48px header leave the window to the terminal. Segoe UI and the native window controls stay. No gradients, glows, dashboard metrics, marketing copy or mock agent states.

## Tokens
Default dark: background #101214, sidebar #121416, surface #16191c, elevated #1c2024, separators #2a2f33, foreground #e6ebe7, muted #8d9691, accent #3ecf8e, attention #d8b67a, error #df8e89. Accent marks focus, the active workspace glyph and the active agent dot.
Light: background #ebece9, sidebar/terminal #f4f5f2/#f8f9f6, elevated #ffffff, separators #d6dad5, foreground #1f2421, muted #626b66, accent #477b60. Six built-in themes and custom palettes remain available.
UI: Segoe UI, 13px body / 12px metadata. Terminal: Cascadia Code, Consolas, monospace, default 14px adjustable. CJK fallback Microsoft YaHei / Meiryo; preserve Unicode through xterm.
Desktop composition: 60px workspace rail (56–420px, expandable to names and agent status), 48px unified header aligned to the Windows title-bar overlay. The header holds the project switcher, terminal tabs, one active-agent status and project tools. A single pane has no header. Split panes use a 24px title row. There is no status footer. The inspector is a rounded surface with its own Files, Git and Browser tabs. Dialogs may lift with a restrained shadow.

## Interaction and states
Keyboard focus visible, accessible names for every icon button. Toolbar tooltips include shortcuts. Hover is a restrained neutral fill. Disabled actions lower contrast and disabled semantics. Agent status is one compact factual line; the persisted hooks preference remains in Settings → Behavior and only applies to supported agents. Loading uses no invented content; errors are actionable and dismissible. Empty workspace invites real shell creation with environment and cwd. Notifications jump directly to pane. Closing processes requires local confirmation; closing window detaches.
Split handles mouse and keyboard accessible. Terminal retains scrollback/mount while switching workspaces. Search, copy, paste, zoom and focus cycle. No forced animation; short120ms controls only; reduced-motion honored. Native Windows outer frame.
Desktop app minimum window900x600, tested desktop1280x800 and compact960x640. Not a mobile webpage. Long paths ellipsized with title; names and labels never overlap toolbar. Min pane dimensions; nested layouts can overflow via scroll rather than silently hide controls.

## Evidence contract
Prepared design is not observed UI evidence. Screenshot the actual Electron app with real PowerShell/WSL; inspect working controls and console errors. Functional checks: shell I/O and Unicode, split resize, search, notification jump, detach/reconnect same PID. No field performance/Lighthouse claims, generated-design approval or visual acceptance is implied by this document.

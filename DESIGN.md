# Winmux design system

## Direction
Operational, cmux-inspired Windows desktop workspace. User-pinned minimal, attractive and clear. Segoe UI and native window controls fit the Windows scene. Dense terminal surfaces replace decorative cards. No gradients, glows, dashboard metrics, marketing copy or mock agent states.

## Tokens
Default dark: background #0d0f10, sidebar/terminal #141719, elevated #1a1e20, separators #292e30, foreground #dfe5e1, muted #8e9993, accent #91bea6, attention #d8b67a, error #df8e89. Accent only marks focus, selection and active pane; no large accent fill.
Light: background #ebece9, sidebar/terminal #f4f5f2/#f8f9f6, elevated #ffffff, separators #d6dad5, foreground #1f2421, muted #626b66, accent #477b60. Six built-in themes and custom palettes remain available.
UI: Segoe UI, 13px body / 12px metadata. Terminal: Cascadia Code, Consolas, monospace, default 14px adjustable. CJK fallback Microsoft YaHei / Meiryo; preserve Unicode through xterm.
Desktop composition: 200px project rail, 48px workspace header aligned to the Windows title-bar overlay, 38px scrollable terminal tab strip, 32px pane header, compact status line. Surfaces are flat with 1px separators and 4px radii; dialogs alone may lift with a restrained shadow.

## Interaction and states
Keyboard focus visible, accessible names for every icon button. Toolbar tooltips include shortcuts. Hover is a restrained neutral fill. Disabled actions lower contrast and disabled semantics. Agent status is one compact factual line; the persisted hooks preference remains in Settings → Behavior and only applies to supported agents. Loading uses no invented content; errors are actionable and dismissible. Empty workspace invites real shell creation with environment and cwd. Notifications jump directly to pane. Closing processes requires local confirmation; closing window detaches.
Split handles mouse and keyboard accessible. Terminal retains scrollback/mount while switching workspaces. Search, copy, paste, zoom and focus cycle. No forced animation; short120ms controls only; reduced-motion honored. Native Windows outer frame.
Desktop app minimum window900x600, tested desktop1280x800 and compact960x640. Not a mobile webpage. Long paths ellipsized with title; names and labels never overlap toolbar. Min pane dimensions; nested layouts can overflow via scroll rather than silently hide controls.

## Evidence contract
Prepared design is not observed UI evidence. Screenshot the actual Electron app with real PowerShell/WSL; inspect working controls and console errors. Functional checks: shell I/O and Unicode, split resize, search, notification jump, detach/reconnect same PID. No field performance/Lighthouse claims, generated-design approval or visual acceptance is implied by this document.

# Winmux design system

## Direction
Operational, cmux-inspired Windows desktop workspace. User-pinned minimal, attractive and clear. Segoe UI and native window controls fit the Windows scene. Dense terminal surfaces replace decorative cards. No gradients, glows, dashboard metrics, marketing copy or mock agent states.

## Tokens
Default dark: background #151719, sidebar #1c1f22, elevated #24292c, separators #30363a, foreground #e5e9e7, muted #a1aba7, accent #9cceaf, attention #e6bd7b, error #f1a09b. Accent only on focused controls, selection and active pane; no large accent fill.
Light: background #fafbf9, sidebar #f0f2ee, elevated #ffffff, separators #d5dbd4, foreground #202723, muted #5c6861, accent #286044, attention #825616, error #ab3434.
UI: Segoe UI, sans-serif, 13px body / 12px metadata / 16px section heading. Terminal: Cascadia Code, Consolas, monospace, default 14px adjustable. CJK fallback Microsoft YaHei / Meiryo; preserve Unicode through xterm.
Spacing 4/8/12/16/24/32px; borders1; radius 4px controls, 8px dialogs. Sidebar224px; topbar44px; pane title32px; compact footer. Flat workspace, elevated dialogs only. Selected and unread states carry text/icon cues in addition to color.

## Interaction and states
Keyboard focus visible, accessible names for every icon button. Toolbar tooltips include shortcuts. Hover restrained raised neutral. Disabled actions lower contrast and disabled semantics. Loading no invented content; errors actionable, dismissible with plain description. Empty workspace invites real shell creation with environment and cwd. Notifications jump directly to pane. Closing processes requires clear local confirmation; closing window detaches.
Split handles mouse and keyboard accessible. Terminal retains scrollback/mount while switching workspaces. Search, copy, paste, zoom and focus cycle. No forced animation; short120ms controls only; reduced-motion honored. Native Windows outer frame.
Desktop app minimum window900x600, tested desktop1280x800 and compact960x640. Not a mobile webpage. Long paths ellipsized with title; names and labels never overlap toolbar. Min pane dimensions; nested layouts can overflow via scroll rather than silently hide controls.

## Evidence contract
Prepared design is not observed UI evidence. Screenshot actual Electron app with real PowerShell/WSL; inspect working controls and console errors. Functional checks: shell I/O and Unicode, split resize, search, notification jump, detach/reconnect same PID. No field performance/Lighthouse claims for this desktop prototype. Bounded build/inspection/correction, no independent review chain.

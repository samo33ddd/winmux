# Winmux workspace design

Winmux is a quiet Windows workbench for terminal agents. A 60px project rail and a single 48px header leave the rest of the window to the active shell. Terminal tabs, the active agent and project tools share that header. Split panes keep a slim title; a single pane does not repeat its path or status.

The default scene is near-black with a green focus accent, 1px separators and small radii. Amber is reserved for attention; red is reserved for errors. The native Windows frame, Winmux mark, six themes, custom terminal fonts and both interface languages remain intact.

Controls stay discoverable through labels, tooltips and visible keyboard focus. Repeated pane actions reveal on hover or focus. Agent hooks are a persisted Behavior setting and remain limited to supported installed agents. No decorative cards, metrics, gradients, animation or placeholder content are part of the interface.

This is an implemented direction, not a generated design approval. Acceptance requires a screenshot of the running Electron app with real terminal content and a responsive check at compact desktop sizes.

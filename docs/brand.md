# Winmux — quiet watch

The Winmux mark folds **m** and **w** into one angular ribbon. Two upper tips suggest attentive ears; the divided lower edge completes the monogram. The creature remains an implication in the silhouette, with no face, eyes, or separate mascot illustration.

Graphite `#151719` gives the application icon its field, and muted mint `#9cceaf` carries the mark. These are the application's existing background and accent colors. Flat fills and a generous clear edge keep the shape distinct from nearby taskbar icons without adding gloss, shadows, or lettering.

The geometry lives on a 32-unit grid. Broad joins and an open central counter preserve the same silhouette across the 16, 24, 32, 48, 64, 128, and 256 pixel ICO frames. The renderer uses the same shape without the background tile: `BrandMark` accepts an optional `className`, inherits `currentColor`, and is decorative beside the visible Winmux name.

Run `python scripts/generate-icon.py` from the repository root to regenerate `build/icon.png` (1024 square), `build/icon.ico`, `build/brand.svg`, and `src/BrandMark.tsx`; run it with `--check` to verify those artifacts without writing. Only Pillow and Python's standard library are required; there are no font or network dependencies. Import the named or default `BrandMark` export in the renderer, and use `build/icon.ico` for the Windows application and installer.

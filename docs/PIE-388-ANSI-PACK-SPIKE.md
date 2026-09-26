# PIE-388 · ANSI art pack in Detail

Disposable practical spike from `3addd04`. This branch is separate from the graphical outliner spectacle (PIE-389). The archive remains a filesystem Resource; artwork is decoded only for this Detail view. No rendered pixels or coordinates are saved in blocks.

## Run

In a Ghostty terminal, from this branch:

```sh
bun install --frozen-lockfile
bun run spike:ansi-pack
```

The launcher uses the attached `woe0697a (1).zip` by default. Pass another ZIP path as the first argument to inspect a different pack. It starts a private service and scratch workspace, interns the ZIP as a Resource, and opens the opt-in ANSI Detail renderer. Closing Detail with Ctrl+Q stops the service and removes the scratch workspace. No executable files inside the archive are run.

The initial member is `ANSEE/SHY-EPO!.ANS` when present. `,` and `.` switch artwork; arrows pan and scroll; `v` toggles Kitty pixels and terminal cells; Ctrl+Q closes. If Ghostty or Kitty support is not detected, the artwork appears as colored terminal cells with SAUCE title, artist, group, member name, and pack position. `OUTLINER_KITTY_GRAPHICS=1` forces Kitty output for protocol inspection; `=0` forces cells.

Kitty rasterization currently uses the Linux PSF VGA font at `/usr/share/consolefonts/Uni2-VGA16.psf.gz`. It renders the visible cells to a PNG and places that image over the Detail body. The archive's original bytes and Resource identity remain canonical. The Detail pane owns placement, deletion, and redraw on entry changes, navigation, overlays, resize, and close. Pixel dimensions come from the terminal's window size when available, with an 8×16-per-cell fallback.

## Evidence so far

- `bun run check`: pass.
- `bun test`: 1,585 pass, 0 fail.
- One-command launcher: opened the real archive in a private fixture, showed `epoch · shypht / woe`, and removed the fixture on close.
- Private PTY journey: ordinary text block → ZIP Resource → different artwork → text block → Resource through history; keyboard input was injected into the running Detail client.
- Forced Kitty protocol capture: entry change, cells toggle, Kitty toggle, resize, and close yielded 8 image transmissions and 8 corresponding image frees. The count varies with startup redraws; disposal remains balanced. Raw capture: `/home/evan/pi-outliner-evidence/pie-388/pty-protocol-capture.ansi`. Raster preview: `/home/evan/pi-outliner-evidence/pie-388/shy-epo-preview.png`.

This is **not** Ghostty visual proof. The agent shell has no `HERDR_ENV=1` and no Ghostty executable, so no live Herdr pane or 30–60 second recording has been made. The default Pi TUI Detail renderer is also not wired to this spike; the launcher explicitly chooses the existing ANSI renderer. These are the main remaining limits on judging a permanent integration.

## Provisional answers

- Kitty may preserve the intended 8×16 DOS glyph shapes and shading more faithfully than the active terminal font; this needs visual confirmation in Ghostty.
- Image lifecycle required explicit frees on each redraw and when leaving the Resource. The initial Detail load caused several redraws and repeated PNG transmission. The protocol capture has balanced transmits/frees but cannot establish that Ghostty leaves no visible debris.
- Archive reading, CP437/ANSI/SAUCE decoding, and frame construction are specific to this Resource type. PNG transmission and image disposal are Kitty-specific. Resource identity, navigation, and Detail viewport ownership remain the existing application concepts.
- The useful reusable boundary, if Ghostty confirms it, is a Detail-owned placement lifecycle: render within a measured rectangle, then free the placement on redraw/exit. No generic graphical component interface has been added. The default Pi TUI renderer already has an `Image` component, Kitty transmission helpers, and bounded offscreen image retention; a permanent version should evaluate that existing path before carrying forward this spike's raw Kitty writer.
- Another graphical Resource representation should wait for the Ghostty journey and for a deliberate decision about the default Pi TUI renderer. Do not generalize a scene graph, canvas layout, universal raster UI, or new Resource model from this spike.

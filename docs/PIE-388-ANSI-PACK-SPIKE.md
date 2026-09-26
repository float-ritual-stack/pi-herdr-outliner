# PIE-388 · ANSI art pack in Detail

Disposable practical spike from `3addd04`. This branch is separate from the graphical outliner spectacle (PIE-389). The archive remains a filesystem Resource; artwork is decoded only for this Detail view. No rendered pixels or coordinates are saved in blocks.

## Run

In a Ghostty terminal, from this branch:

```sh
bun install --frozen-lockfile
bun run spike:ansi-pack
```

The launcher uses the attached `woe0697a (1).zip` by default. Pass another ZIP path as the first argument to inspect a different pack. It starts a private service and scratch workspace, interns the ZIP as a Resource, and opens the default Pi TUI Detail renderer. Set `OUTLINER_DETAIL_RENDERER=ansi` to compare the older Detail renderer. Closing Detail with Ctrl+Q stops the service and removes the scratch workspace. No executable files inside the archive are run.

The initial member is `ANSEE/SHY-EPO!.ANS` when present. `,` and `.` switch artwork; arrows pan and scroll; `v` toggles Kitty pixels and terminal cells; Ctrl+Q closes. If Ghostty or Kitty support is not detected, the artwork appears as colored terminal cells with SAUCE title, artist, group, member name, and pack position. `OUTLINER_KITTY_GRAPHICS=1` forces Kitty output for protocol inspection; `=0` forces cells.

Kitty rasterization currently uses the Linux PSF VGA font at `/usr/share/consolefonts/Uni2-VGA16.psf.gz`. It renders the visible cells to a PNG and places that image over the Detail body. The archive's original bytes and Resource identity remain canonical. The Detail pane owns placement, deletion, and redraw on entry changes, navigation, overlays, resize, and close. Pixel dimensions come from the terminal's window size when available, with an 8×16-per-cell fallback.

## Evidence so far

- `bun run check`: pass.
- `bun test`: 1,585 pass, 0 fail.
- One-command launcher: opened the real archive in the default Pi TUI Detail and in the older ANSI Detail, showed `epoch · shypht / woe`, and removed each private fixture on close.
- Private Pi TUI application journey: ordinary text block → ZIP Resource → different artwork → text block → Resource through history → resize → close. Keyboard input was injected into the running Detail client; navigation targets were sent through the production CLI. Raw capture: `/home/evan/pi-outliner-evidence/pie-388/pi-tui-navigation-capture.ansi`.
- Simulated Ghostty capability in a PTY: the Pi TUI renderer emitted one initial image transmission, cleared placements on cells toggle and entry changes, redrew after resize, and freed all images on exit. Raw capture: `/home/evan/pi-outliner-evidence/pie-388/pi-tui-protocol-capture.ansi`. Explicit `OUTLINER_KITTY_GRAPHICS=1` also emits Kitty when terminal detection is unavailable.
- Forced Kitty protocol capture: entry change, cells toggle, Kitty toggle, resize, and close yielded 8 image transmissions and 8 corresponding image frees. The count varies with startup redraws; disposal remains balanced. Raw capture: `/home/evan/pi-outliner-evidence/pie-388/pty-protocol-capture.ansi`. Raster preview: `/home/evan/pi-outliner-evidence/pie-388/shy-epo-preview.png`.

This is **not** Ghostty visual proof. The agent shell has no `HERDR_ENV=1` and no Ghostty executable, so no live Herdr pane or 30–60 second recording has been made. The default Pi TUI Detail renderer is wired, but the private launcher does not open a Herdr Tree pane. Those are the main remaining limits on judging a permanent integration.

## Provisional answers

- Kitty may preserve the intended 8×16 DOS glyph shapes and shading more faithfully than the active terminal font; this needs visual confirmation in Ghostty.
- Image lifecycle required clearing placements on representation changes, entry changes, resize, and navigation. The older ANSI renderer repeatedly transmitted the PNG during initial redraws; Pi TUI cached it and emitted one initial transmission. The protocol captures show cleanup commands but cannot establish that Ghostty leaves no visible debris.
- Archive reading, CP437/ANSI/SAUCE decoding, and frame construction are specific to this Resource type. PNG transmission and image disposal are Kitty-specific. Resource identity, navigation, and Detail viewport ownership remain the existing application concepts.
- The useful reusable boundary, if Ghostty confirms it, is a Detail-owned placement lifecycle: render within a measured rectangle, then free the placement on redraw/exit. No generic graphical component interface has been added. The default Pi TUI renderer already has an `Image` component, Kitty transmission helpers, and bounded offscreen image retention; this spike uses its transmission and placement machinery there. The older ANSI renderer still has a raw writer for comparison.
- Another graphical Resource representation should wait for the Ghostty journey and a keep/discard decision on this one. Do not generalize a scene graph, canvas layout, universal raster UI, or new Resource model from this spike.

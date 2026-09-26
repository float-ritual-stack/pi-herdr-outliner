# PIE-388 · ANSI art pack in Detail

Disposable practical spike from `3addd04`. This branch is separate from the graphical outliner spectacle (PIE-389). The archive remains a filesystem Resource; artwork is decoded only for this Detail view. No rendered pixels or coordinates are saved in blocks.

## Run

In a Ghostty terminal, from this branch:

```sh
bun install --frozen-lockfile
bun run spike:ansi-pack
```

The launcher uses the attached `woe0697a (1).zip` by default. Pass another ZIP path as the first argument to inspect a different pack. It starts a private service and scratch workspace, interns the ZIP as a Resource, and opens the default Pi TUI Detail renderer. When launched from a Herdr pane, only Detail inherits that pane's Herdr environment; the private service stays isolated. Set `OUTLINER_DETAIL_RENDERER=ansi` to compare the older Detail renderer. Closing Detail with Ctrl+Q stops the service and removes the scratch workspace. No executable files inside the archive are run.

The initial member is `ANSEE/SHY-EPO!.ANS` when present. `,` and `.` switch artwork; arrows pan and scroll; `v` toggles Kitty pixels and terminal cells; Ctrl+Q closes. If Kitty support is unavailable, the artwork appears as colored terminal cells with SAUCE title, artist, group, member name, and pack position. Inside Herdr, this spike checks its `experimental.kitty_graphics` setting because Herdr reports `TERM=xterm-256color` to panes even with graphics forwarding enabled. It honors `HERDR_CONFIG_PATH` and `XDG_CONFIG_HOME`. `OUTLINER_KITTY_GRAPHICS=1` forces Kitty output for protocol inspection; `=0` forces cells.

Kitty rasterization currently uses the Linux PSF VGA font at `/usr/share/consolefonts/Uni2-VGA16.psf.gz`. It renders the visible cells to a PNG and places that image over the Detail body. The archive's original bytes and Resource identity remain canonical. The Detail pane owns placement, deletion, and redraw on entry changes, navigation, overlays, resize, and close. Pixel dimensions come from the terminal's window size when available, with an 8×16-per-cell fallback.

## Evidence so far

- `bun run check`: pass.
- `bun test`: 1,585 pass, 0 fail.
- One-command launcher: opened the real archive in the default Pi TUI Detail and in the older ANSI Detail, showed `epoch · shypht / woe`, and removed each private fixture on close.
- Private Pi TUI application journey: ordinary text block → ZIP Resource → different artwork → text block → Resource through history → resize → close. Keyboard input was injected into the running Detail client; navigation targets were sent through the production CLI. Raw capture: `/home/evan/pi-outliner-evidence/pie-388/pi-tui-navigation-capture.ansi`.
- Simulated Ghostty capability in a PTY: the Pi TUI renderer emitted one initial image transmission, cleared placements on cells toggle and entry changes, redrew after resize, and freed all images on exit. Raw capture: `/home/evan/pi-outliner-evidence/pie-388/pi-tui-protocol-capture.ansi`. Explicit `OUTLINER_KITTY_GRAPHICS=1` also emits Kitty when terminal detection is unavailable.
- Forced Kitty protocol capture: entry change, cells toggle, Kitty toggle, resize, and close yielded 8 image transmissions and 8 corresponding image frees. The count varies with startup redraws; disposal remains balanced. Raw capture: `/home/evan/pi-outliner-evidence/pie-388/pty-protocol-capture.ansi`. Raster preview: `/home/evan/pi-outliner-evidence/pie-388/shy-epo-preview.png`.

## Herdr capability diagnosis and private trial

The owner's direct SSH run in Ghostty showed the Kitty preview, while Herdr showed `Kitty unavailable`. The minimal regression reproduces that exact label with `HERDR_ENV=1`, `TERM=xterm-256color`, and Herdr graphics enabled. It was red before the fix and green afterward; a disabled Herdr setting remains in cell mode even if a Ghostty hint leaks from the outer terminal. Herdr's pane environment deliberately hides the host terminal identity, so Ghostty detection alone cannot answer whether its compositor accepts Kitty graphics.

In a private named Herdr 0.9.1 session, the default Pi TUI Detail displayed `v terminal cells` and emitted Kitty image and placement packets without a force flag. Injected `.` selected `ANSEE/SHY-PASS.ANS`; `v` changed to terminal cells and sent a Kitty delete; `v` again restored the graphical mode. Splitting the pane caused a delete and new placements at the smaller width; closing the split restored the original width. Ctrl+Q returned to the shell, sent the final delete, and removed the new private fixture. The real Herdr keyboard baseline passed in a separate private session. This verifies protocol forwarding and placement lifecycle through Herdr, but the agent's attached PTY is not a Ghostty visual capture. A 30–60 second Ghostty recording and visual debris inspection are still pending. The private launcher opens Detail on the Resource, not a Herdr Tree pane.

## Provisional answers

- The owner's direct Ghostty screenshots show the graphical preview is available; whether it is substantially more useful than cells still needs side-by-side visual judgment.
- Image lifecycle required clearing placements on representation changes, entry changes, resize, and navigation. The older ANSI renderer repeatedly transmitted the PNG during initial redraws; Pi TUI cached it and emitted one initial transmission. The protocol captures show cleanup commands but cannot establish that Ghostty leaves no visible debris.
- Archive reading, CP437/ANSI/SAUCE decoding, and frame construction are specific to this Resource type. PNG transmission and image disposal are Kitty-specific. Resource identity, navigation, and Detail viewport ownership remain the existing application concepts.
- The useful reusable boundary, if Ghostty confirms it, is a Detail-owned placement lifecycle: render within a measured rectangle, then free the placement on redraw/exit. No generic graphical component interface has been added. The default Pi TUI renderer already has an `Image` component, Kitty transmission helpers, and bounded offscreen image retention; this spike uses its transmission and placement machinery there. The older ANSI renderer still has a raw writer for comparison.
- Another graphical Resource representation should wait for the Ghostty-in-Herdr visual journey and a keep/discard decision on this one. Do not generalize a scene graph, canvas layout, universal raster UI, or new Resource model from this spike. Herdr should eventually advertise effective graphics support to child panes; reading its config file is a spike-specific bridge, not an application-wide capability API.

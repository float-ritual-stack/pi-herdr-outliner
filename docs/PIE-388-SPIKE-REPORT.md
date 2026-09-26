# PIE-388 · ANSI art pack graphical Detail spike

**Status:** disposable practical experiment. This is independent of the graphical outliner spectacle planned as PIE-389.

## Purpose

Find out whether Kitty graphics earns one useful place in the existing Outliner: the Detail representation of a real Resource. The owner supplied WOE ANSI/ASCII art packs and pointed to ANSEE/SHY-EPO!.ANS, signed shypht for the ep0ch BBS. Its DOS glyph shapes, palette, shading, SAUCE metadata, and proportions make a better test than a generic image.

The ZIP remains the canonical filesystem Resource. Detail derives a temporary view from its bytes. Pixels, placement IDs, pan offsets, and archive member selection are not saved as block content or as a second document model. Ordinary terminal text still draws the title, metadata, controls, and surrounding UI.

## Prototype

- Lists .ANS and .ASC members, decodes CP437 and ANSI styling, and shows SAUCE title, artist, group, dimensions, and pack position. SHY-EPO!.ANS opens first when present.
- Renders the visible artwork with an 8×16 VGA font to a PNG for Kitty placement inside Detail. The default Pi TUI renderer uses its image transmission machinery; the older ANSI Detail renderer has a raw Kitty writer for comparison.
- Offers colored terminal cells as a fallback and comparison. Comma and period change members; arrows pan or scroll; v toggles graphics and cells; Ctrl+Q closes. Other keys remain with normal Detail navigation.
- Rebuilds the view when Detail changes size or the Resource revision changes. Prior placements are disposed on member changes, mode switches, navigation away, overlays, resize, and close.
- Runs through a one-command launcher with a private scratch Outliner service and ZIP Resource. The launcher removes its fixture on normal exit and does not execute archive members.

The reader bounds archive member count and extracted member size. The raster font is currently /usr/share/consolefonts/Uni2-VGA16.psf.gz, so this implementation is Linux-specific.

## Findings

1. **Resource identity survived the projection.** The ZIP is interned once as a Resource; no image data or coordinates enter the outline. A private application journey went from an ordinary text block to the ZIP Resource, to another member, back to text, back through history, through resize, and then closed.
2. **Kitty can display the intended DOS-shaped preview in Detail.** The owner supplied direct SSH Ghostty screenshots of the graphical preview. Whether it is substantially better than colored cells still needs a side-by-side Ghostty judgment.
3. **Placement lifecycle is the hard part.** Initial paint, member change, cells toggle, resize, navigation, and close need explicit disposal. The Pi TUI path cached image transmission during redraws; the older ANSI renderer retransmitted more often. Protocol captures show image frees. A private Herdr run also emitted delete and new placement packets when its pane narrowed and widened.
4. **Herdr hid the capability from terminal detection.** A child pane reports TERM=xterm-256color even when its Kitty compositor is enabled. That made the viewer say “Kitty unavailable” in Herdr while direct SSH to Ghostty worked. A focused regression reproduced this label before the fix. The spike now reads Herdr’s experimental.kitty_graphics setting when HERDR_ENV=1, honoring HERDR_CONFIG_PATH and XDG_CONFIG_HOME. A disabled setting stays in cells mode even if an outer Ghostty hint leaks in. A lasting integration should ask Herdr for its effective capability instead of reading a config file.
5. **The reusable boundary is small.** Archive reading, CP437/ANSI/SAUCE decoding, and VGA rasterization belong to this Resource representation. Kitty packet emission, placement reuse, and disposal belong at Detail’s graphical output edge. Resource identity and viewport ownership already have homes. There is no evidence for a generic graphical component framework yet.

## Challenges and limits

- The owner’s direct Ghostty screenshots were taken outside Herdr. The private Herdr trial proved Kitty packets were forwarded and cleaned up through its compositor, but the agent’s attached PTY was not a Ghostty visual capture. A 30–60 second Ghostty recording, visible debris inspection, and owner keyboard feel remain pending.
- The one-command demo opens Detail directly on the Resource. It does not present a Tree beside Detail or an integrated pack browser in the shared Outliner. A separate private journey exercised ordinary text and Resource navigation through the production client path.
- Font availability, differing cell pixel ratios, and other terminals remain unexplored.
- The supplied ZIP is not committed. The launcher’s default attachment path is specific to this machine; reviewers elsewhere must pass a ZIP path.
- Normal exit removes the scratch fixture. Earlier interrupted harness runs left scratch directories, so abnormal termination cleanup is unproven.

## Verification

| Check | Result |
| --- | --- |
| Type check | bun run check passed after the Herdr fix. |
| Focused regression | The Herdr capability case failed on the original “Kitty unavailable” behavior, then passed after the fix. |
| Full tests | bun test: 1,586 passed, 0 failed. |
| Real Herdr keyboard baseline | bun run test:e2e:herdr passed both private startup and Resource journeys. |
| Private Herdr 0.9.1 trial | Kitty offered without a force flag; member switch, cells toggle, resize, and close produced placement/deletion traffic and returned to the shell. |
| Private Pi TUI journey | Text → ZIP Resource → next member → text → history return → resize → close. |

Local evidence not included in the PR lives under /home/evan/pi-outliner-evidence/pie-388/: pi-tui-navigation-capture.ansi, pi-tui-protocol-capture.ansi, pty-protocol-capture.ansi, and shy-epo-preview.png. A forced Kitty capture had eight image transmissions and eight image frees across entry change, mode toggles, resize, and close; startup redraws can change that count. The owner also supplied direct Ghostty screenshots dated 2026-09-25 under /opt/float/bbs/inbox/screenshots/.

## Decision supported

Keep the spike available for visual review without merging it into main. Another graphical Resource representation is justified only if the Ghostty-in-Herdr journey shows a durable benefit over cells and clean visual disposal. If so, extract Detail-owned placement lifecycle and runtime capability reporting. Do not generalize a scene graph, canvas layout, rasterized text UI, universal GraphicalComponent interface, or spatial document model from this prototype.

The technical run instructions and protocol evidence remain in PIE-388-ANSI-PACK-SPIKE.md.

# Fancy Horror (rich component)

The example for **kind 3, a rich component**: the extension returns its **data** and a **view**
composed from the shared primitives (card, badge, stat, bar, checklist, sparkline, row). Every
client draws those primitives, so this folder has no client code. All omens are made up.

```text
fancy-horror:: virgo
  ▌ Virgo: week of 2026-09-28   [uneasy]
  ▌ 2 omens still at large
    Dread  5 / 10    This week  ▃▅▂▇▄▁▆
    Dread  █████░░░░░  5/10
    [x] a door that closes by itself
    [ ] three crows on the phone line
    [ ] a cat that watches the hallway
```

- **Behaviour is an action.** `ward` (key `w` in the door, `ext.fancy-horror.ward` for agents,
  `outliner ext act fancy-horror ward --block <id>` from a shell) writes `Warded off …` as a child
  block, attributed to `ext:fancy-horror`. The next run reads the block's children and ticks that
  omen. The component's state lives in the outline, as blocks.
- **Targets.** `extensions.render` gives it as `markdown`, `blockdown`, `html`, `json` (the data),
  `csv` (rows) or `terminal` text. A reader that draws primitives takes `view` instead.
- **keep** (from the service) writes the current rendering as a block.

Install: `outliner ext add fancy-horror`. See [the four kinds](../../docs/extensions/README.md).

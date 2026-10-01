# Horoscope (inline output)

The tutorial extension for **kind 2, inline output**: the service runs a handler and keeps its
markdown under the line that asks. Every horoscope is made up.

```text
horoscope:: virgo
  └─ Horoscope virgo · ran 09:12              ← drawn under the line, not written into the note
     Virgo, 2026-10-01. The kettle knows something you don't.
     - Advice: Say yes to soup.
```

- `horoscope:: virgo`: today's; `--day=tomorrow` for tomorrow's (a *fetch* option: a different call).
- `--short` is a *display* option: it never reaches the extension, so it shares the result.
- `effects: read`: it runs when you save the line and when you open the note, if it has no result,
  its result is more than an hour old (`staleAfter`), or the extension's version changed.
  `r` on the line runs it now.
- **keep** (every output has it, from the service): writes the result under the block as a real
  block, attributed to `ext:horoscope`. Door: the `ext.horoscope.keep` action; CLI:
  `outliner ext act horoscope keep --block <id>`.

Install: `outliner ext add horoscope`. Remove: `outliner ext remove horoscope`.
See [the four kinds](../../docs/extensions/README.md).

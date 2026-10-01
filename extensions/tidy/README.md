# Tidy (an agent you address while you write)

The example for **agents in the note** (PIE-501). Write a line that starts with `@tidy` and keep
typing. Once the line has been quiet for a moment, the service asks the agent, and the paragraph
above is tidied in place: bullets as `-`, one space after list markers and `#`, no runs of spaces,
no trailing spaces. Links, references, properties and code are never touched.

```text
Morning plan
*  call the  printer people
-   **  order  ** paper
@tidy                              ← tidies the two lines above, as ext:tidy
```

- `@tidy all` tidies everything above the line (never the title).
- The edit is an ordinary attributed edit (`author: agent`, `ext:tidy`, `ext.tidy.agent.tidy` in
  the change feed) applied through `draft.patch` with the `edit` policy. If you are typing in that
  passage in the door, it becomes a proposal under the line instead (apply or dismiss it).
- Under the line, the note shows what it did (`tidied 2 lines above`). `r` on the line asks again.
- A `@tidy` line written by an agent waits for `r`, so agents can't set each other off.

Install: `outliner ext add tidy`. See [the four kinds](../../docs/extensions/README.md#agents-in-the-note).

---
description: Focus an Outliner block by ID or fuzzy text
argument-hint: [block-id | short-prefix | text]
allowed-tools: Bash(bun run goto:*)
---

Focus an Outliner block matching `$ARGUMENTS`.

- Require a non-empty query; otherwise show `/goto [block-id | short-prefix | text]`.
- Run `bun run goto --query` with the complete argument text passed as one safely quoted query value.
- The command handles exact UUIDs, unique short UUID prefixes, and unambiguous fuzzy title/content matches.
- If the result is ambiguous, report the returned candidates with their full UUIDs so the user can retry safely even when eight-character prefixes collide.
- Report the focused convenience prefix and title. Do not guess a candidate or mutate block content.

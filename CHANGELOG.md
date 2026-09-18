# Changelog

This file records notable user-facing changes. The project remains active dogfood, so protocol and storage contracts can still change before a stable release.

## [Unreleased]

### Added

- Durable Resource identities and Source boundaries for filesystem, web, PDF, Jira, Linear, application, and computed providers.
- Immutable web snapshots, extracted PDF representations, dependency-aware retention, provider-specific revisions, and host-aware presentation negotiation.
- Durable annotations for blocks and source-backed Resource text, including direct pointer selection for filesystem, web, and PDF representations.
- Deterministic annotation reconciliation, retained resolution history, inline disclosures, and bounded agent-assisted proposals for unresolved changes.
- Human-authored Resource references through `[file::…]`, `[web::…]`, `[jira::…]`, and `[app::…]` properties.
- Tree **Show authored links** branches for Outlinks and Resources. Passive discovery is read-only; explicit activation follows or interns unresolved targets.
- A guided Herdr plugin installer, portable runtime discovery, external editor handoff, bookmarks, attention marks, and typed outline workflows.

### Changed

- The JSON-lines RPC protocol is version 52.
- Fresh databases use workspace seed version 4. The Documentation hub now includes a Resource reference section and an authored-links example with block, page, local-file, web, SSH-application, and Jira references.
- Detail navigation uses explicit destination routing and preserves locked panes for block targets.
- Resource Details expose negotiated presentation, provenance, capability, revision, and retention state without creating wrapper blocks.

### Fixed

- Filesystem Resources now support read, edit, external editor, refresh, and source-backed comments through one canonical Resource identity.
- Cached web selections map to the retained representation before annotation creation.
- Rendered selection validation now rejects stale pane content and changed browsing contexts.
- External editor recovery preserves large drafts and resolves the user's interactive-shell editor configuration.

### Known limits

- Resource activation does not yet show the block destination chooser when the current Detail is locked. Tracked as PIE-260.
- SSH authored references are application deep links, not source-backed remote files. Tracked as PIE-261.
- Metadata-only Resource fields cannot yet receive structured comments. Tracked as PIE-262.
- Authored Resource properties remain plain text in Detail. Tracked as PIE-263.
- Computed and remote-entity cached Markdown cannot yet create direct text annotations. Tracked as PIE-264.

## [0.1.0-dogfood.1] - 2026-08-22

- First tagged dogfood build of the workspace-scoped Outliner service, Tree, Detail, block graph, properties, references, virtual branches, and Pi/OMP integration.

[Unreleased]: https://github.com/float-ritual-stack/pi-herdr-outliner/compare/v0.1.0-dogfood.1...HEAD
[0.1.0-dogfood.1]: https://github.com/float-ritual-stack/pi-herdr-outliner/releases/tag/v0.1.0-dogfood.1

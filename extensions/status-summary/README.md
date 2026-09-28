# Status summary renderer

A small declarative presentation extension exercising the shared document frame.
It uses the host's `labelled-values` layout: one row when all values fit, otherwise
one labelled value per wrapping row. It runs no JavaScript and makes no requests.

Register its installed manifest in the **reader host's**
`~/.config/pi-herdr-outliner/document-renderers.json` (or the path selected by
`OUTLINER_DOCUMENT_RENDERERS`):

```json
{
  "version": 1,
  "renderers": {
    "status": {
      "manifest": "/absolute/install/status-summary/manifest.json",
      "enabled": true
    }
  }
}
```

The absolute path above is a placeholder for the installation location. This
configuration is separate from Resource fetching extensions; it contains no
credentials or executable command. The manifest uses a contract version, stable
extension ID and integer implementation version. No app rebuild is needed to
install or disable this declarative renderer.

Author a note using a component fence:

````markdown
```component:status
To do :: 4
[Waiting for review](https://example.test/review) :: 4
Done :: 5
```
````

Each nonblank line has `label :: value`. Labels and values support inline
Markdown, including links. Up to 64 entries and 16 KiB of input are accepted.
The host consumes the separator and retains the exact source slices of each
label and value. Displayed punctuation and layout padding are generated. A
producer-supplied derived value retains its result and dependencies rather than
acquiring a fabricated source range.

The configuration and manifest are bounded local JSON files (32 KiB each).
They are read when the document is compiled, not on resize. Existing captured
frames remain immutable. Reopen the document to compile changed installation
settings. Disabled, missing or invalid renderers keep the readable code block
and display a reason; editing and export always retain the original note.

## Installation changes and everyday use

Copy the package's `manifest.json` into a stable directory on the reader host and
register that absolute path above. Neither service code nor a rebuild changes.
The renderer must be installed on each host that draws a reader, even when those
readers share a remote database. Keep this configuration separate from Source
credentials and Resource fetching extensions.

To disable it, set `enabled` to `false`. To remove it, remove the registry entry
or installed manifest. Reopen the note after either change: the reader explains
why the component is unavailable and shows the original labelled source.
Restoring the manifest and enabling its entry restores the rendered panel after
reopening. Configuration is deliberately not watched on every keystroke or
resize. Existing open documents retain their compiled presentation until they
are loaded again.

You can still edit the note while the renderer is disabled. Copying or exporting
the canonical note retains its fence and `label :: value` rows. Changing values
in the note refreshes the displayed summary through the normal document revision
path. Resizing only changes layout; it does not change values or save a new note.

Detail, Tree Preview and Inbox Preview use the same renderer. Links remain
focusable through resize; dragging copies the useful rendered label and value.
Comments retain source slices for those words, while the displayed colon and
padding remain generated. A captured selection can be used for a comment after
resizing, and the thread follows the value into the narrow stacked layout.

## Scope and verification

This is the first PIE-382 slice, using PIE-350's source-evidence foundation.
There is one supported declarative layout; arbitrary plugin-code execution,
installation UI and automatic configuration watching are outside this slice.
The host owns terminal sanitization, wrapping, links, selection, annotations and
focus; extensions do not introduce their own document or task store.

Run `bun run test/e2e/component-lifecycle.ts` for the isolated native journey:
installation, disable/remove/invalid/re-enable, editing fallback source, changed
values, source export through the external editor, long Unicode labels, repeated widths, unlinked Tree
Preview, and Inbox Preview link/copy/comment behavior. Its deterministic Inbox
fixture tests rendering and receipt handling, not model judgment quality.

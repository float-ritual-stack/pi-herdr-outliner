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

This is the initial PIE-350 table/component example, not completion of PIE-382.
There is one supported declarative layout; it is not an arbitrary plugin-code
runtime or a general dashboard language. Installation UI, live configuration
invalidation and broader extension lifecycle acceptance belong to PIE-382.
The host owns terminal sanitization, wrapping, links, selection, annotations and
focus; extensions do not introduce their own document or task store.

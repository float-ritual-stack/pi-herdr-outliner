# Installed Resource processes (contracts 1 and 2)

## Contract 2: an extension is a folder (wave A)

Wave A of the extension design moves Jira onto the folder shape that wave B
generalizes. An extension is a folder in the service host's user extensions
folder, `$XDG_CONFIG_HOME/pi-herdr-outliner/extensions/<id>/`
(`OUTLINER_EXTENSIONS_DIR` overrides it), with:

- `extension.json`: `{contract: 2, id, version, name, run, configSchema?, secrets?, handlers}`.
  `run` is an argument vector run in the folder; `bun` means the service's own Bun.
  Each handler is `{key, kind: "resource", effects: "read"|"spend"|"write", keyPattern?, record?, staleAfter?, pollEvery?}`.
  Fields wave B reads (`renderers`, `actions`, `tiles`) are allowed and ignored.
- `config.json`: `{config, secrets, sources, enabled?}`. Secrets are references
  (`env`, `keychainService`, or `file` with mode 0600), resolved at call time on
  the service host. `sources` are created on first use.
- the code, `README.md` and a `config.example.json`.

`outliner ext add <id>` copies a built-in from the repo's `extensions/` and
writes `config.json` (from an existing `resource-extensions.json` entry when
there is one). The folder is looked up before the legacy registry below, on
every call, so code and config changes need no restart.

The wire is contract 1's, with `contract: 2` in the request and one more
operation:

- `read` may return `record: {title, fields: [{key, value}], body, comments?}`.
  The service keeps it as blocks the extension owns (`src/extension-records.ts`):
  fields become `[<id>.<key>::value]` block properties, comments child blocks.
- `changed` takes `{source, locators, sinceMinutes}` and returns
  `{items: [{entityId, locator}]}`: which registered keys changed recently, in
  one provider search. The service's poll uses it.

Wave B adds: the folder watcher with candidate and active registries, outline
folders (`<outline root>/extensions/`), handler tables derived from manifests
(today `RESOURCE_DIRECTIVE_PROVIDERS` still names Jira), the generic
remote-entity provider family, `ext doctor|migrate|rm`, `command` secrets, and
renderers, actions and tiles served by `extensions.list`.

## Contract 1

An installed extension handles a provider request. The Outliner service owns Source boundaries, Resource UUIDs, immutable source identity, observations, representations, retained history and annotations. Extensions return data; they do not receive a database handle or perform canonical mutations.

The first host binding is read-only Jira entities. The process protocol is provider-independent, but a new **address family or UI handler slot** still needs a host binding. This is not a generic UI plugin system: transcript rendering is a future second caller. Linear and other built-in providers retain their existing implementation.

## Install and update

On the **service host**, create `$XDG_CONFIG_HOME/pi-herdr-outliner/resource-extensions.json` (default `~/.config/pi-herdr-outliner/resource-extensions.json`):

```json
{
  "version": 1,
  "providers": {
    "jira": {
      "manifest": "/absolute/path/to/jira/manifest.json",
      "enabled": true,
      "config": {"authMode": "basic", "email": "you@example.com"},
      "credentials": {"token": {"env": "JIRA_API_TOKEN"}}
    }
  }
}
```

Alternatively a macOS service can resolve `{"keychainService":"jira-api-token"}` (optional `account`) with `security find-generic-password`. This happens on that host; remote clients do not forward their own environment or keychain. Never put token values in configuration, notes, command arguments or logs. `OUTLINER_RESOURCE_EXTENSIONS` can select another absolute configuration path.

The host rereads configuration and the manifest for every operation and starts a fresh process. Install/update needs no rebuild or service restart. Change `enabled` to disable/re-enable; changed configuration invalidates a running result before commit. Updating an extension in place should increment its manifest `version`. There is no module watcher or dependency installer.

Use atomic file replacement when editing config/manifest to avoid a partially written JSON file. Missing/disabled/broken installs fail visibly at the Resource rather than silently falling back to built-in Jira.

## Manifest

```json
{
  "contract": 1,
  "id": "local.jira",
  "version": 1,
  "command": ["/absolute/path/to/bun", "jira.ts"],
  "configSchema": {
    "type": "object",
    "properties": {"authMode":{"enum":["basic","bearer"]},"email":{"type":"string"}},
    "required": ["authMode"],
    "additionalProperties": false
  }
}
```

The command is an argument vector, never shell text. Its working directory is the manifest directory. Resolve the interpreter during installation; do not assume a checkout path such as `~/test`. The extension can be copied outside the application repository and must not import its private source.

The process runs as the service user. **This is trusted code, not a sandbox.** It can use that user's filesystem/network permissions. A minimal environment is supplied; declared secrets travel only through stdin. Subprocess isolation provides fresh code and a killable deadline, not a security boundary. Do not install untrusted extensions.

## Wire request and response

One JSON request on stdin, one JSON response on stdout, then exit. No stdout logging. Stderr is discarded to avoid accidentally retaining secrets.

```json
{"contract":1,"operation":"resolve","input":{"source":{"kind":"jira","origin":"https://example.atlassian.net","project":"PC"},"locator":"PC-762"},"config":{"authMode":"basic","email":"you@example.com"},"credentials":{"token":"runtime-only"}}
```

Operations: `resolve` takes a locator and returns `{entityId, locator}`; `read` takes immutable `entityId` and returns:

```json
{"ok":true,"value":{"entityId":"10001","locator":"PC-762","title":"Transfer switches","markdown":"# Transfer switches\n\nReadable issue text.","sourceContent":"normalized source JSON or text", "metadata":{"status":"Doing"},"externalUrl":"https://example.atlassian.net/browse/PC-762","updatedAt":"2026-09-25T12:00:00Z"}}
```

Errors: `{"ok":false,"code":"forbidden"}`. Codes: `credentials-missing`, `unauthorized`, `forbidden`, `not-found`, `outside-source`, `invalid-config`, `invalid-response`, `network`, `timeout`. Arbitrary provider error text is never persisted; the host supplies safe explanatory messages. Unknown codes produce a generic failure.

The host validates JSON/schema, Source project/origin, immutable entity ID, revision, response sizes and URL authority. The extension supplies stable serialized source content separately from its rendered Markdown, so renderer updates do not pretend to be source changes. The host hashes that content for immutable source identity. It computes representation hashes and stamps adapter ID/version plus a manifest/config digest. That digest is **not** a hash of all installed code/dependencies. Increment the adapter version when updating code. No Jira mutation/command operation is exposed.

Limits: 64 KiB configuration/manifest, 256 KiB request, 1 MiB stdout, 15-second operation deadline (including credential lookup). Abort kills the process group on Unix. At most sixteen credential references per provider. Literal credential values and their Base64 encodings are scrubbed from results as defense in depth; trusted extensions must not return secrets, encode them into documents, or send them to another origin.

## What to verify

`bun test test/resource-extensions.test.ts` exercises a genuinely external process, changed code, disabled/re-enabled configuration, incompatible contracts, failed/oversized/malformed responses, missing credentials, cancellation and disable during a running request.

`bun run test/e2e/resource-extensions.ts` installs a standalone fixture outside the checkout and uses the live Resource reader to refresh, update, disable, re-enable, and show configuration/credential failures. This does not prove live Jira credentials or laptop installation.

Design evidence: [repository reconnaissance](../research/resource-extension-recon.md).

# Changelog

## 1.1.0

Renamed for public release: `dsh-model-key-sync` (was a private `@local` package).
The loader row is now `model-key-sync` and the agent tool is `model_key_sync`.

### Added

- **API key sync.** Routes and the credentials behind them travel together, so a new
  machine needs no manual key entry. Read through `ctx.credentials.resolve`, written
  through `ctx.credentials.set`. A toggle in the cloud tab (`syncCredentials`) keeps
  keys off the wire when you do not want them uploaded.
- **Auto sync.** Upload after a model edit; a pull never triggers an upload.
- **Transfer serialization.** Page-triggered and tool-triggered transfers can no
  longer interleave.
- Three-way conflict detection on two axes (model routes, API keys), so a device
  that changed nothing is not told "both sides changed".

### Fixed

- A stale settings revision left the page on "working…" forever; the status write
  now retries.
- A removed dictionary key (`cloudHint`) rendered as its own name in the UI.
- `status` could emit `undefined` values, which the tool layer rejects.

### Changed

- Renamed to `dsh-model-key-sync` for public release: the loader row is
  `model-key-sync`, the agent tool is `model_key_sync`, the remote directory and
  local state directory follow the same name.
- Snapshot and export formats are now `dsh-model-key-sync/*`. Files and remotes
  written under the old `dsh-model-sync/*` marker are still **accepted** on import
  and pull, so an earlier export does not become unreadable.
- Schema lookup no longer hardcodes a macOS application path; it uses
  `process.resourcesPath` with a `DSH_HARNESS_MODULES` override.
- Tests resolve `jsdom`, `react`, `react-dom` and `s3rver` from `devDependencies`
  instead of absolute paths inside the author's machine.

## 1.0.0

First working version: settings page with model cards, local JSON export/import,
and cloud transfer over S3-compatible storage or WebDAV.

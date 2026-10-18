# Changelog

## 1.2.0

### Changed

- **The settings page is now cloud-sync first.** The tab strip is gone; cloud sync
  is the whole page, so it no longer competes for height with a second tab.
- **This machine's configuration is a compact, read-only summary.** Each route shows
  only its display name, API endpoint and model count. Editing, adding and removing
  routes in this page are removed; model editing stays on the Models page.
- **Cloud sync is denser.** The backend selector sits inline with its save button,
  configuration and secret save in one action, the three upload/pull options share a
  row, and the status detail is collapsed by default. The panel fits without
  scrolling at the normal settings width.
- The local escape hatches are reduced to **Export** and **Restore**. Copy-JSON,
  preview-JSON and add-route controls are removed.
- Restoring a file and pulling from the cloud still write through the same shared
  settings form, so the Models page and this page cannot disagree.

### Fixed

- Only the secret belonging to the selected backend is submitted, so switching
  between S3 and WebDAV cannot write a half-typed secret for the other backend.
- The three cloud options are short labels on one no-wrap row instead of three
  full-sentence checkboxes stacked vertically.
- **Actions cannot run against stale values.** Test/Upload/Pull now submit pending
  field edits and a newly typed secret in the same write as the command; unchecking
  "Sync keys" and pressing Upload can no longer upload keys the Host still thinks
  are enabled.
- **Export/Restore carries the whole route.** Provider defaults (`reasoning`,
  `defaultInput`, context/token defaults, cache retention and thinking budgets) are
  no longer dropped; restoring a file that predates them leaves the current values
  in place instead of deleting them.
- A command the Host never answers now times out, unlocks the actions and reports
  the wait instead of leaving the page on "working…" forever.
- The status run kind, S3 secret label, credential separator and singular model count
  follow the active language; the page also renders correctly when only one of its
  two settings namespaces is served.
- The read-only notice is shown once, and the local summary warns when a route with
  no endpoint or no models will be skipped by Export.

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

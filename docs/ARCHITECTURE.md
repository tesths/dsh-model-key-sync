# Architecture

Two halves, one service, four files that matter.

```
index.js              Host: Config schema, ModelSyncService, the agent tool, the command channel
client.js             Client: one cloud-sync page plus a read-only local summary
cloud/snapshot.js     Snapshot format: manifest, per-route objects, credentials object
cloud/sync.js         Transfer: push/pull, conflict rules, snapshot identity
cloud/transport.js    S3 SigV4 and WebDAV transports, timeouts, size caps
```

## The constraint that shaped everything

A bundle installed from a directory is linked into the *profile's* `node_modules`.
That directory contains only profile-installed bundles, so a plugin cannot resolve
`@deepseek-ai/*` through Node's package resolution, and cannot ship generated Typert
artifacts. Two consequences:

1. **No Remote namespace of its own.** A page-initiated Host call needs a generated
   namespace; this plugin cannot declare one.
2. **No route to the schema library — except one.** The Harness installation itself is
   readable from the Host process, so `loadSchema()` imports `schemastery` by absolute
   path (`process.resourcesPath`, or `DSH_HARNESS_MODULES`). With it the plugin can
   declare a real `Config`, which makes its row a settings namespace the page can read
   and write.

If `loadSchema()` fails, `Config` is `undefined`. The plugin still activates and the
agent tool keeps working; only the settings page disappears. Exporting a broken
`Config` would crash activation instead, because Cordis calls
`Config['~standard'].validate`.

## The page → Host channel

```
page                          Host
────                          ────
configForms.mutate            settings.update (the settings Remote)
  set command = {...}  ──────►
                              settings/document-updated fires
                              consumeCommand()  (deduped by id)
                              runCommand() → ModelSyncService method
                              publishStatus()
  ◄──────────────────────────  set status = {...}, command = ""
re-render from the mirror
```

Why a command field rather than a Remote call: see the constraint above. Why the
settings Remote rather than a custom HTTP route: it is already authenticated,
already carries a revision, and already pushes changes to the page.

An action (Test/Upload/Pull) writes the pending configuration and secret edits in
the *same* mutate as `command`, so the Host never reads an older value than the one
the page is showing. If the Host never answers, the page times out locally, unlocks
the actions and reports the wait; a late answer still renders.

Two failure modes are handled explicitly, and both have tests:

- **Replayed event.** `consumeCommand` remembers the last command id, so a settings
  push that arrives twice runs the action once.
- **Stale revision.** `publishStatus` retries without the `expectedRevision`
  precondition, then again after a beat. The status field is written by this plugin
  alone, so a lost update is cheaper than a page stuck on "working…".

## One operation, two callers

Every capability is one method on `ModelSyncService`. The agent tool and the page
both call those methods; neither has its own copy of the logic. The tool is a thin
schema plus a renderer over `runAction`.

## Snapshot identity and conflicts

`snapshotId` is a hash over every payload object's hash, in name order. Two devices
holding identical routes **and** identical keys compute the same id, which is what
makes "already in sync" detectable without downloading.

Conflicts are three-way: local, remote, and the baseline recorded at the last sync.

```
conflict = (localRoutes ≠ baseline && remoteRoutes ≠ baseline)
        || (localKeys   ≠ baseline && remoteKeys   ≠ baseline)
```

Comparing each side to the baseline, rather than to each other, is what stops "the
other device changed" from being reported as "both sides changed". The old two-way
form did exactly that whenever one device rotated a key and the other stayed idle.

## Data model

A route is the subset of a provider profile this plugin owns
(`displayName`, `api`, `baseURL`, `models`, `apiKeyEnv`, plus a few defaults).
Everything else in the profile — retry policy, timeouts, transport, compat switches —
is preserved on restore because it is never captured.

Credentials live in their own object so a reader can tell whether a snapshot carries
secrets, and so a pull can apply routes and keys separately. `keys.json` is a plain
map of `ENV_NAME` to value: plaintext, by decision.

## Adding a field

1. Add it to `configShape` in `index.js`; make it `.volatile()` unless it should
   remount the plugin.
2. Add the input to the relevant panel in `client.js`, with both `zh` and `en`
   dictionary entries (the tests fail on a missing key).
3. If it belongs to the cloud transport, add it to `CLOUD_FIELDS`.
4. Add a case to `test/host.mjs`; the client suite covers rendering.

## Tests

`test/host.mjs` mounts the plugin on a fake Cordis context, then starts real servers:
`s3rver` on loopback and a small WebDAV implementation in-process. Two simulated
devices exercise upload, pull, idempotency, conflict refusal, forced overwrite,
credential transfer and rotation conflicts.

`test/client.mjs` loads the real client bundle into jsdom through
`window.__ModuleLoader__`, with a `configForms`/`locale`/`slots` fake that mirrors the
shipped contracts (stable snapshots, redacted secrets, flat dotted dictionaries).
Missing dictionary keys render as `@@missing:key@@` so a leak fails the suite instead
of reaching users.

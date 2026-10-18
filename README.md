# dsh-model-key-sync

Sync your **DeepSeek Harness model configuration and third-party API keys** across
machines, over S3-compatible storage or WebDAV.

Sign in to Harness on a new computer, pull once, and your custom providers and their
keys are there — no retyping one key per provider.

<p>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-111827">
  <img alt="dsh plugin" src="https://img.shields.io/badge/topic-dsh--plugin-4D6BFE">
</p>

> ### Keys are stored in the remote as plaintext
>
> This is deliberate — it matches CC Switch, and it means a new machine needs no
> passphrase. The consequence is blunt: **anyone who can read that bucket or
> collection can read every API key in it.** Use a dedicated application password,
> keep the cloud account itself safe, and turn the key toggle off if you only want
> model declarations to travel. See [Security](#security).

## Why this exists

Harness keeps each machine's profile, credentials and model declarations locally.
Moving to a second machine normally means re-entering every provider: display name,
endpoint, protocol, model catalog, and the key.

Other plugins in the ecosystem sync the profile directory and local plugin sources —
[`dsh-cloud-sync`](https://github.com/dickpy/dsh-cloud-sync) documents that it
deliberately does **not** copy plaintext credentials. That leaves exactly this gap:
the keys. This plugin fills it, and carries the model declarations that reference
them.

## Install

Ask the agent in Harness:

> Install the plugin from github:tesths/dsh-model-key-sync

It runs the bundle installer for you. Or point it at a local checkout:

> Install the plugin at /path/to/dsh-model-key-sync

Then reload the page. The section appears under **Settings → Model Key Sync**.

Requires a Harness build that provides the `settings`, `credentials` and `tools`
services, and an `llm-pi-ai` (or compatible) model adapter row.

## Configure

**Settings → Model Key Sync → Cloud**.

### WebDAV

| Field | Value |
| --- | --- |
| Backend | WebDAV |
| Collection URL | `https://dav.jianguoyun.com/dav/` (nutstore), or your Nextcloud path |
| User name | the account's login name (for nutstore: your email) |
| Password | an **application password**, not the login password |
| Remote directory | `dsh-model-key-sync` |
| Sync group | any name; **identical on every machine** |

### S3-compatible

R2, OSS, B2, MinIO and AWS all work. Fill bucket, region (`auto` for R2), endpoint
(blank for AWS), access key id and secret.

Then: **Save** → **Save credentials** → **Test connection** → **Upload to cloud**.

### On the second machine

Install the plugin, open the same tab, fill the **same** values including the sync
group, and press **Pull from cloud**. The status card lists the credentials it
stored, for example:

```
pulled · credentials: ACME_API_KEY, OTHER_API_KEY
```

## Daily use

- **Manual**: upload after editing models; pull before using another machine.
- **Auto**: tick *Upload automatically after a model edit*. A pull never triggers an
  upload.
- **Conflict**: nothing is overwritten silently. When both sides changed, a pull is
  refused and the message names the axis — `model routes`, `API keys`, or both. Tick
  *Force overwrite* to take the remote, or upload to keep this device.

## What travels

| Included | Not included |
| --- | --- |
| Provider routes: display name, protocol, endpoint, model catalog, key reference | Sessions, attachments, plugin sources |
| The API key each route's `apiKeyEnv` resolves to | Credits/quota, usage history |
| Your choice of cloud backend and sync group | Other settings (theme, shortcuts, …) |

Restoring merges by route name and **preserves fields it did not export** — retry
policy, timeouts, transport or compatibility switches stay as they are on this
machine.

## Remote layout

```
<remoteRoot>/v1/<syncGroup>/
├── manifest.json        format, version, device, per-object sha256 and size, snapshotId
├── <provider>.json      one file per route
└── keys.json            { "ENV_NAME": "value" }
```

Payload objects are written first and the manifest last, so a reader never sees a
manifest describing objects the writer has not finished uploading. Every object is
verified by size and SHA-256 on download. Transfers are serialized with a total
timeout, an idle timeout and a response-size cap.

## Security

- Keys leave the machine only through `ctx.credentials.resolve` and are stored
  through `ctx.credentials.set` — the same seam the model adapter reads.
- They are uploaded **unencrypted**. Treat the remote as a secret store: a private
  bucket, an application password you can revoke, no shared folders.
- Turn off *Sync API keys too* to sync model declarations only.
- Anyone who obtains the remote can use your keys. Revoke them at the provider if
  that happens.
- The local sync state (`~/.dsh/model-key-sync/cloud-state.json`) stores hashes, not
  keys.

## Development

```bash
npm install
npm test                 # node test/host.mjs && node test/client.mjs
node test/host.mjs       # 106 checks: settings, files, command channel, keys, S3 + WebDAV
node test/client.mjs     # 63 checks: both tabs rendered and driven in jsdom
```

`test/host.mjs` starts a real S3-compatible server and a real WebDAV server on
loopback and drives two simulated devices through upload, pull, idempotency, conflict
refusal and forced overwrite. `test/client.mjs` loads the real client bundle into
jsdom with a faithful `configForms`/`locale`/`slots` contract.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why the page talks to the Host
the way it does, and [CONTRIBUTING.md](CONTRIBUTING.md) before changing that channel.

## License

MIT

# Contributing

## Setup

```bash
git clone https://github.com/tesths/dsh-model-key-sync
cd dsh-model-key-sync
npm install
npm test
```

Node 20 or newer. `npm test` runs both suites; neither needs network access beyond
loopback, and neither touches a real cloud account.

## Installing your build

Ask the Harness agent to install the checkout:

> Install the plugin at /absolute/path/to/dsh-model-key-sync

A directory install is linked, so a change to `index.js` needs a reinstall to load a
fresh module generation; a change to `client.js` also needs a page reload.

## Ground rules

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. Two rules matter most:

1. **Do not add a second copy of an operation.** The page and the agent tool must call
   the same `ModelSyncService` method. If a change needs new behaviour, add it there.
2. **Do not change the page → Host channel casually.** It exists because a
   directory-installed bundle cannot declare a Remote namespace. A pull request that
   replaces it must explain how the replacement survives that constraint, and must
   keep the replay and stale-revision protections covered by tests.

## Tests come with the change

- Behaviour in the Host: add a case to `test/host.mjs`.
- Rendering or interaction: add a case to `test/client.mjs`.
- New user-visible string: add it to **both** `zh` and `en` dictionaries. The suite
  fails when a rendered key is missing, so a half-translated change will not pass.

S3 and WebDAV coverage uses real servers on loopback (`s3rver` and an in-process
WebDAV handler), not mocks. Keep it that way: the transport is where the subtle bugs
live.

## Security expectations

- Keys must never be logged, never enter a snapshot manifest, and never reach the
  page. The only legal paths are `ctx.credentials.resolve` (read) and
  `ctx.credentials.set` (write).
- The plaintext-at-rest decision is documented and intentional. Do not silently add
  encryption; if you want to offer it, make it an explicit, documented option.
- Do not commit a real endpoint, account name or key. Fixtures use `example.com`.

## Pull requests

Describe the behaviour change, what you tested, and what you could not test. A change
that alters conflict semantics needs a paragraph explaining which cases now refuse
where they used to apply.

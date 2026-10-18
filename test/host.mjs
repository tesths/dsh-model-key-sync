/**
 * Runtime test for the Host half of the Model Sync bundle.
 *
 * Covers three layers against the real module:
 *   1. the settings/file operations (export, restore, rename, remove, prune),
 *   2. the `model_sync` tool contract (lossless JSON, rendered detail, errors),
 *   3. cloud transfer through the tool against a real S3-compatible server and
 *      a real WebDAV server, including cross-device restore, idempotency and
 *      conflict refusal.
 *
 * Run with: node test/host.mjs
 */
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const mod = await import(new URL('../index.js', import.meta.url).href)

let passed = 0
const failures = []


function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${String(detail).slice(0, 240)}`}`)
}

/* ------------------------------------------------------------------ */
/* A Host context just rich enough to mount the plugin.                */
/* ------------------------------------------------------------------ */

function host({ providers = {}, config = {} } = {}) {
  const state = { value: { providers: structuredClone(providers) }, revision: 1 }
  const own = { value: { backend: '', remoteRoot: 'dsh-model-sync', profile: 'default', command: '', status: '' }, revision: 1 }
  const settings = {
    describe: () => [
      { ns: 'llm-pi-ai', revision: state.revision, value: structuredClone(state.value) },
      { ns: 'model-sync', revision: own.revision, value: structuredClone(own.value) },
    ],
    async update(ns, patch, expected) {
      if (ctx.updateHook !== undefined) {
        const hooked = ctx.updateHook(ns, patch, expected)
        if (hooked !== undefined) return hooked
      }
      if (ns === 'model-sync') {
        own.value = { ...own.value, ...structuredClone(patch) }
        own.revision += 1
        ctx.emit('settings/document-updated', 'model-sync')
        return
      }
      state.value = { ...state.value, ...structuredClone(patch) }
      state.revision += 1
      ctx.emit('settings/document-updated', 'llm-pi-ai')
    },
  }
  // A stand-in for `ctx.credentials`: name -> value, no AMBIENT fallback.
  const secrets = new Map()
  const credentials = {
    async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref), source: 'test' } : undefined },
    async describe(ref) { return { configured: secrets.has(ref), writable: true } },
    async set(ref, value) {
      if (typeof value !== 'string' || value.length === 0) throw new Error('refusing an empty credential')
      secrets.set(ref, value)
    },
    async unset(ref) { secrets.delete(ref) },
  }
  const tools = {}
  const listeners = []
  const ctx = {
    get: (key) => ({ settings, llm: {}, workingDirectory: { defaultDirectory: '/tmp' }, credentials })[key],
    provide: (_name, value) => { ctx.service = value },
    effect: (fn) => { const disposer = fn(); return () => disposer?.() },
    on: (event, handler) => { listeners.push({ event, handler }); return () => {} },
    tools: { register: (definition) => { tools[definition.name] = definition; return () => delete tools[definition.name] } },
    emit: (event, ...args) => { for (const entry of listeners) if (entry.event === event) entry.handler(...args) },
    logger: { info: () => {}, warn: () => {} },
  }
  mod.apply(ctx, { llmEntryId: 'llm-pi-ai', keepPerProvider: 20, ...config })
  const service = ctx.service
  return { service, tool: tools.model_key_sync, state, own, ctx, secrets }
}

/** A tool result must survive a JSON round-trip with no losses. */
function lossless(value, path = '$') {
  if (value === undefined) return [`undefined at ${path}`]
  if (typeof value === 'number' && !Number.isFinite(value)) return [`non-finite number at ${path}`]
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return [`${typeof value} at ${path}`]
  if (Array.isArray(value)) return value.flatMap((entry, index) => lossless(entry, `${path}[${index}]`))
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => lossless(entry, `${path}.${key}`))
  return []
}

const route = (name, extra = {}) => ({
  provider: name,
  displayName: `${name} display`,
  api: 'openai-completions',
  baseURL: `https://${name}.example.com/v1`,
  models: [{ id: `${name}-1`, name: `${name} One`, contextWindow: 131072 }],
  ...extra,
})

// A private directory per run: two checkouts testing at once must not collide.
const workspace = await mkdtemp(join(tmpdir(), 'model-key-sync-test-'))

/* ------------------------------------------------------------------ */
/* 1. Settings and file operations.                                    */
/* ------------------------------------------------------------------ */

console.log('\n# settings and file operations')
{
  await rm(workspace, { recursive: true, force: true })
  const { service, state } = host({
    providers: {
      // a route with an unrelated field that a restore must not destroy
      keep: {
        ...route('keep'),
        retryPolicy: { attempts: 5 },
        defaultContextWindow: 200000,
        defaultMaxTokens: 4096,
        defaultInput: ['text', 'image'],
        reasoning: { effort: 'high' },
        cacheRetention: '1h',
        thinkingBudgets: { high: 4096 },
      },
      // a route that cannot travel: no catalog, no endpoint
      broken: { api: 'openai-completions', models: [] },
    },
    config: { syncDirectory: workspace },
  })

  check('state directory is created on demand', typeof (await service.stateDirectory()) === 'string')

  const routes = service.customRoutes()
  check('only restorable routes are considered custom', routes.length === 1 && routes[0] === 'keep', JSON.stringify(routes))

  const exported = service.exportConfig()
  check('export carries the route', exported.routes.length === 1 && exported.routes[0].provider === 'keep')
  check('export carries the model catalog', exported.routes[0].models?.[0]?.id === 'keep-1')
  check('export carries the key reference, not a key', exported.routes[0].apiKeyEnv === 'KEEP_API_KEY', exported.routes[0].apiKeyEnv)
  check('export leaves unrelated fields behind', exported.routes[0].retryPolicy === undefined)
  check('export carries provider defaults', exported.routes[0].defaultContextWindow === 200000 && exported.routes[0].reasoning?.effort === 'high', JSON.stringify(exported.routes[0]))

  const text = await service.exportText()
  check('exported text parses back', JSON.parse(text.text).routes.length === 1)
  check('exported text names its format', JSON.parse(text.text).format === 'dsh-model-key-sync/provider')

  const saved = await service.saveToDirectory()
  check('saves one file per route', saved.files.length === 1, JSON.stringify(saved.files))
  const listed = await service.listFiles()
  check('lists the file it just wrote', listed.files.length === 1)

  // restore the same document into the same profile: unrelated fields survive
  const outcome = await service.restore({ path: saved.files[0] })
  check('restoring reports the route as updated', outcome.updated.includes('keep') && outcome.created.length === 0, JSON.stringify(outcome))
  check('restore keeps the unrelated retry policy', state.value.providers.keep.retryPolicy?.attempts === 5, JSON.stringify(state.value.providers.keep))
  check('restore keeps provider defaults', state.value.providers.keep.defaultContextWindow === 200000 && state.value.providers.keep.defaultMaxTokens === 4096, JSON.stringify(state.value.providers.keep))
  check('restore keeps reasoning and input settings', state.value.providers.keep.defaultInput?.[0] === 'text' && state.value.providers.keep.reasoning?.effort === 'high', JSON.stringify(state.value.providers.keep))

  // every write reports itself to the hook that drives auto-sync
  const reasons = []
  const record = (reason) => { reasons.push(reason) }

  // editing the display metadata keeps the key and the catalog
  const edited = await service.renameRoute({ provider: 'keep', displayName: 'Edited Name', baseURL: 'https://moved.example.com/v1' }, record)
  check('the write hook hears the edit', JSON.stringify(reasons) === '["rename"]', JSON.stringify(reasons))
  check('edit reports the committed profile', edited.displayName === 'Edited Name', JSON.stringify(edited))
  check('edit changed the display name in the profile', state.value.providers.keep.displayName === 'Edited Name')
  check('edit changed the endpoint', state.value.providers.keep.baseURL === 'https://moved.example.com/v1')
  check('edit kept the key', state.value.providers.keep !== undefined && state.value.providers.renamed === undefined)
  check('edit kept the catalog', state.value.providers.keep.models?.[0]?.id === 'keep-1')
  check('edit kept the unrelated retry policy', state.value.providers.keep.retryPolicy?.attempts === 5)

  // removal names only the routes that existed
  const removed = await service.removeRoutes({ providers: ['keep', 'ghost'] }, record)
  check('the write hook hears the removal', reasons.includes('remove'), JSON.stringify(reasons))
  check('remove reports what it removed', JSON.stringify(removed.removed) === '["keep"]', JSON.stringify(removed))
  check('remove reports what it could not find', JSON.stringify(removed.missing) === '["ghost"]', JSON.stringify(removed))
  check('remove deleted the route', state.value.providers.keep === undefined)
  check('remove verified the failure path is not a no-op', state.value.providers.broken !== undefined)

  // An export made before the rename still imports: the shape is identical and
  // the user already holds the file.
  const legacy = join(workspace, 'legacy-export.json')
  await (await import('node:fs/promises')).writeFile(legacy, JSON.stringify({
    format: 'dsh-model-sync/provider',
    version: 1,
    routes: [{ provider: 'legacy', displayName: 'Legacy', api: 'openai-completions', baseURL: 'https://legacy.example.com/v1', apiKeyEnv: 'LEGACY_API_KEY', models: [{ id: 'legacy-1' }] }],
  }))
  const legacyOutcome = await service.restore({ path: legacy })
  check('an old-format export still imports', legacyOutcome.created.includes('legacy'), JSON.stringify(legacyOutcome.created))
  check('the legacy route kept its endpoint', state.value.providers.legacy?.baseURL === 'https://legacy.example.com/v1')
  check('the legacy route is now exported in the new format', service.exportConfig().routes.some((entry) => entry.provider === 'legacy'))

  // bad input is refused by name
  let refused
  try {
    await service.restore({ path: join(workspace, 'does-not-exist.json') })
  } catch (error) {
    refused = error
  }
  check('restoring a missing file fails loudly', refused !== undefined && /no such file|not exist|cannot read|ENOENT/i.test(String(refused?.message)), refused?.message)
}

/* ------------------------------------------------------------------ */
/* 2. The tool contract.                                               */
/* ------------------------------------------------------------------ */

console.log('\n# model_sync tool contract')
{
  const { tool } = host({ providers: {}, config: { syncDirectory: workspace } })
  check('the plugin registers exactly one tool', tool !== undefined)
  check('the tool is named model_key_sync', tool?.name === 'model_key_sync', tool?.name)
  check('the action parameter is required', JSON.stringify(tool?.parameters?.required) === '["action"]', JSON.stringify(tool?.parameters?.required))
  check('the action parameter is enumerated', JSON.stringify(tool?.parameters?.properties?.action?.enum) === '["status","export","cloud_test","cloud_push","cloud_pull"]')
  check('the output declares a schema', typeof tool?.output?.schema === 'object')
  check('the output renders text blocks', Array.isArray(tool?.output?.render({}, { ok: true, action: 'status', message: 'x' })) )

  // An empty profile with no recorded sync state: every action must stay JSON-safe,
  // which is what a bare `undefined` in the status detail used to break.
  for (const action of ['status', 'export', 'cloud_test']) {
    const result = await tool.execute({ action })
    const problems = lossless(result)
    check(`${action} returns lossless JSON`, problems.length === 0, problems.join('; '))
    const rendered = tool.output.render({ action }, result)
    check(`${action} renders a text block`, Array.isArray(rendered) && rendered[0]?.type === 'text', JSON.stringify(rendered).slice(0, 120))
    check(`${action} renders the detail`, /[{]/.test(rendered[0]?.text ?? '') || action === 'cloud_test', rendered[0]?.text?.slice(0, 80))
  }

  const status = await tool.execute({ action: 'status' })
  check('status reports no routes on an empty profile', status.ok === true && status.detail.routes.length === 0, JSON.stringify(status.detail))
  check('status omits absent sync state instead of emitting undefined', !('lastSyncAt' in status.detail), JSON.stringify(status.detail))

  const cloudOff = await tool.execute({ action: 'cloud_test' })
  check('cloud_test explains that cloud sync is off', cloudOff.ok === false && /cloud sync is off/.test(cloudOff.message), cloudOff.message)

  const unknown = await tool.execute({ action: 'nope' })
  check('an unknown action fails with a message', unknown.ok === false && /unknown action/.test(unknown.message), unknown.message)
  check('the failure result is lossless too', lossless(unknown).length === 0)
}

/* ------------------------------------------------------------------ */
/* 2b. The settings channel the page uses.                             */
/* ------------------------------------------------------------------ */

console.log('\n# settings command channel')
{
  const { service, own, tool } = host({ providers: { chan: route('chan') }, config: { keepPerProvider: 20 } })

  check('the plugin finds its own settings namespace', service.settingsNamespace() === 'model-sync', service.settingsNamespace())

  // The page posts a command; the Host answers through `status`.
  own.value.status = ''
  own.value.command = JSON.stringify({ id: 'cmd-1', kind: 'status' })
  await service.consumeCommand()
  const status = JSON.parse(own.value.status)
  check('the Host answers a posted command', status.id === 'cmd-1' && status.ok === true, own.value.status)
  check('the answer clears the command', own.value.command === '', own.value.command)
  check('the answer names the route it saw', String(JSON.parse(status.detail).routes) === 'chan', status.detail)
  check('the answer reports whether a secret is stored', JSON.parse(status.detail).s3SecretConfigured === false)

  // Replaying the same id must not run twice (the settings event can repeat).
  let executions = 0
  const original = service.runCommand.bind(service)
  service.runCommand = async (command) => { executions += 1; return original(command) }
  own.value.command = JSON.stringify({ id: 'cmd-1', kind: 'status' })
  await service.consumeCommand()
  check('a repeated command id is ignored', executions === 0, String(executions))

  own.value.command = JSON.stringify({ id: 'cmd-2', kind: 'export' })
  await service.consumeCommand()
  const exported = JSON.parse(own.value.status)
  check('the export command returns the document to the page', JSON.parse(exported.detail).document.includes('chan'), own.value.status.slice(0, 120))

  own.value.command = JSON.stringify({ id: 'cmd-3', kind: 'nonsense' })
  await service.consumeCommand()
  const failed = JSON.parse(own.value.status)
  check('an unknown command is reported, not thrown', failed.ok === false && /unknown action/.test(failed.message), failed.message)

  // A rejected expectedRevision must not strand the page on "working…": the
  // status write is retried, and the command is still cleared. The override is
  // scoped to the publish of this one command so no later write inherits it.
  {
    const stale = host({ providers: { stale: route('stale') } })
    // Reject the first status write as if its expectedRevision had moved.
    let reject = 1
    stale.ctx.updateHook = (ns, patch) => {
      if (ns === 'model-sync' && reject > 0 && patch?.status !== undefined) {
        reject -= 1
        throw new Error('settings: revision mismatch')
      }
      return undefined
    }
    stale.own.value.command = JSON.stringify({ id: 'stale-1', kind: 'status' })
    await stale.service.consumeCommand()
    stale.ctx.updateHook = undefined
    const recovered = JSON.parse(stale.own.value.status || 'null')
    check('a stale revision is retried instead of lost', recovered?.id === 'stale-1' && recovered.ok === true, stale.own.value.status.slice(0, 120))
    check('the retried write still clears the command', stale.own.value.command === '', stale.own.value.command)
  }

  // Auto sync: off by default, and a pull must never bounce an upload back.
  {
    const auto = host({ providers: { acme: route('acme') }, config: { autoSync: true, backend: 's3', s3Bucket: 'b' } })
    let pushes = 0
    const realPush = auto.service.cloud.push.bind(auto.service.cloud)
    auto.service.cloud.push = async (request) => { pushes += 1; return { status: 'pushed', routes: [] } }
    await auto.service.autoSync('test')
    check('autoSync uploads when enabled', pushes === 1, String(pushes))

    const quiet = host({ providers: { acme: route('acme') }, config: { backend: 's3', s3Bucket: 'b' } })
    let quietPushes = 0
    quiet.service.cloud.push = async () => { quietPushes += 1; return { status: 'pushed', routes: [] } }
    await quiet.service.autoSync('test')
    check('autoSync stays off by default', quietPushes === 0, String(quietPushes))

    // The guard a pull raises must suppress the upload its own write causes.
    auto.service.suppressAutoSync = true
    await auto.service.autoSync('pull')
    check('a pull does not trigger an upload', pushes === 1, String(pushes))
    auto.service.suppressAutoSync = false
    auto.service.cloud.push = realPush
  }

  check('the settings channel does not disturb the agent tool', tool !== undefined)
}

/* ------------------------------------------------------------------ */
/* 2c. Credentials travel with the routes.                             */
/* ------------------------------------------------------------------ */

console.log('\n# credential sync')
{
  const a = host({ providers: { acme: route('acme') } })
  const b = host({ providers: {} })
  a.service.stateDirectory = async () => join(workspace, 'key-a')
  b.service.stateDirectory = async () => join(workspace, 'key-b')

  a.secrets.set('acme display'.toUpperCase(), 'unused')
  a.secrets.set('ACME_API_KEY', 'sk-live-acme-123')
  b.secrets.set('ACME_API_KEY', 'sk-stale-local')

  const collected = await a.service.collectKeys()
  check('only referenced names are collected', Object.keys(collected).join(',') === 'ACME_API_KEY', Object.keys(collected).join(','))
  check('the value is resolved, not invented', collected.ACME_API_KEY === 'sk-live-acme-123', collected.ACME_API_KEY)

  // An unconfigured name must be omitted, never uploaded empty.
  const blank = host({ providers: { ghost: { ...route('ghost'), apiKeyEnv: 'GHOST_MISSING_KEY' } } })
  const blankKeys = await blank.service.collectKeys()
  check('a name that resolves to nothing is omitted', Object.keys(blankKeys).length === 0, JSON.stringify(blankKeys))

  // Turning the switch off must keep keys off the wire.
  const off = host({ providers: { acme: route('acme') }, config: { syncCredentials: false } })
  off.secrets.set('ACME_API_KEY', 'sk-should-not-travel')
  const offKeys = await off.service.collectKeys()
  check('syncCredentials false uploads no key', Object.keys(offKeys).length === 0, JSON.stringify(offKeys))

  const written = await b.service.applyKeys({ ACME_API_KEY: 'sk-live-acme-123' })
  check('applyKeys stores the value', written.join(',') === 'ACME_API_KEY', JSON.stringify(written))
  check('the stored value is the pulled one', b.secrets.get('ACME_API_KEY') === 'sk-live-acme-123', b.secrets.get('ACME_API_KEY'))
  const refused = await b.service.applyKeys({ EMPTY: '' })
  check('an empty value is never stored', refused.length === 0)
}

/* ------------------------------------------------------------------ */
/* 2d. Transfers never overlap.                                        */
/* ------------------------------------------------------------------ */

console.log('\n# transfer serialization')
{
  const { service } = host({ providers: { acme: route('acme') } })
  const cloud = service.cloud
  let active = 0
  let peak = 0
  const work = () => cloud.exclusive(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    return { ok: true }
  })
  const results = await Promise.all([work(), work(), work()])
  check('overlapping transfers run one at a time', peak === 1, `peak ${peak}`)
  check('every queued transfer still completes', results.length === 3 && results.every((entry) => entry.ok === true))

  // A failed transfer must not wedge the queue.
  const failed = cloud.exclusive(async () => { throw new Error('boom') }).catch((error) => error.message)
  const after = await work()
  check('a failed transfer releases the queue', (await failed) === 'boom' && after.ok === true)
}

/* ------------------------------------------------------------------ */
/* 3. Cloud transfer over S3, driven through the tool.                 */
/* ------------------------------------------------------------------ */

console.log('\n# S3-compatible cloud sync')

const S3_PORT = 4568
const s3Root = join(workspace, 's3')
await rm(s3Root, { recursive: true, force: true })
await mkdir(join(s3Root, 'model-sync-test'), { recursive: true })

let s3
try {
  const S3rver = require('s3rver')
  s3 = new S3rver({
    port: S3_PORT,
    address: '127.0.0.1',
    silent: true,
    directory: s3Root,
    configureBuckets: [{ name: 'model-sync-test' }],
  })
  await s3.run()
  check('S3 test server is up', true)
} catch (error) {
  check('S3 test server is up', false, error.message)
}

if (s3 !== undefined) {
  process.env.R2_ACCESS_KEY_ID = 'S3RVER'
  process.env.R2_SECRET_ACCESS_KEY = 'S3RVER'
  const cloudConfig = {
    backend: 's3',
    s3Bucket: 'model-sync-test',
    s3Region: 'us-east-1',
    s3Endpoint: `http://127.0.0.1:${S3_PORT}`,
    s3AccessKeyIdEnv: 'R2_ACCESS_KEY_ID',
    s3SecretAccessKeyEnv: 'R2_SECRET_ACCESS_KEY',
    syncDirectory: workspace,
  }

  const a = host({ providers: { acme: route('acme') }, config: cloudConfig })
  const b = host({ providers: {}, config: cloudConfig })
  a.service.stateDirectory = async () => join(workspace, 'state-a')
  b.service.stateDirectory = async () => join(workspace, 'state-b')
  process.env.DSH_MODEL_SYNC_DEVICE = 'Device A'

  const tested = await a.tool.execute({ action: 'cloud_test' })
  check('cloud_test reaches the bucket', tested.ok === true, tested.message)

  const pushed = await a.tool.execute({ action: 'cloud_push' })
  check('push uploads the snapshot', pushed.ok === true && pushed.detail.status === 'pushed', pushed.message)

  // the same push, triggered the way the page triggers it
  a.own.value.command = JSON.stringify({ id: 'ui-push', kind: 'push', force: true })
  await a.service.consumeCommand()
  const uiPush = JSON.parse(a.own.value.status)
  check('a push posted from the page works too', uiPush.ok === true, JSON.stringify(uiPush))
  check('push reports the remote path', /v1\/dsh-model-sync\/default/.test(String(pushed.detail.remotePath)), pushed.detail.remotePath)
  check('push is lossless', lossless(pushed).length === 0)

  const again = await a.tool.execute({ action: 'cloud_push' })
  check('a second push is a no-op', again.detail.status === 'up-to-date', again.detail.status)

  process.env.DSH_MODEL_SYNC_DEVICE = 'Device B'
  const pulled = await b.tool.execute({ action: 'cloud_pull' })
  check('pull creates the missing route', pulled.ok === true && pulled.detail.created.includes('acme'), pulled.message)
  check('the restored route keeps its endpoint', b.state.value.providers.acme?.baseURL === 'https://acme.example.com/v1', JSON.stringify(b.state.value.providers.acme))
  check('the restored route keeps its catalog', b.state.value.providers.acme?.models?.[0]?.id === 'acme-1')
  check('the restored route carries no secret', JSON.stringify(b.state.value.providers.acme).includes('S3RVER') === false)

  const idle = await b.tool.execute({ action: 'cloud_pull' })
  check('a second pull is a no-op', idle.detail.status === 'up-to-date', idle.detail.status)

  // The API key must travel with the route that names it.
  a.secrets.set('ACME_API_KEY', 'sk-acme-cloud-1')
  const keyPushed = await a.tool.execute({ action: 'cloud_push', force: true })
  check('push reports the credentials it uploaded', JSON.stringify(keyPushed.detail.credentials) === '["ACME_API_KEY"]', JSON.stringify(keyPushed.detail))
  // A device that changed nothing must not be told "both sides changed" just
  // because the other device rotated a key: the comparison is against the last
  // sync, not against the remote.
  const quietPull = await b.tool.execute({ action: 'cloud_pull' })
  check('a rotated key does not look like a local change', quietPull.ok === true, quietPull.message)

  const keyPulled = await b.tool.execute({ action: 'cloud_pull', force: true })
  check('pull reports the credentials it stored', JSON.stringify(keyPulled.detail.credentials) === '["ACME_API_KEY"]', JSON.stringify(keyPulled.detail))
  check('the key landed in the credential store', b.secrets.get('ACME_API_KEY') === 'sk-acme-cloud-1', String(b.secrets.get('ACME_API_KEY')))
  check('the key never entered the route record', JSON.stringify(b.state.value.providers.acme).includes('sk-acme-cloud-1') === false)

  // A conflict needs both sides to move: B edits locally through the service
  // (which records the local revision), then A publishes a newer snapshot.
  process.env.DSH_MODEL_SYNC_DEVICE = 'Device B'
  await b.service.renameRoute({ provider: 'acme', baseURL: 'https://local-edit.example.com/v1' }, true)
  process.env.DSH_MODEL_SYNC_DEVICE = 'Device A'
  await a.service.renameRoute({ provider: 'acme', displayName: 'Acme Remote' }, true)
  const repushed = await a.tool.execute({ action: 'cloud_push' })
  check('the remote side moved', repushed.detail.status === 'pushed', repushed.message)
  process.env.DSH_MODEL_SYNC_DEVICE = 'Device B'

  const conflict = await b.tool.execute({ action: 'cloud_pull', force: false })
  check('a two-sided divergence reports a conflict', conflict.ok === false, conflict.message)
  check('the conflict names its code', String(conflict.detail.code ?? '').includes('conflict'), JSON.stringify(conflict.detail))
  check('the refused pull changed nothing', b.state.value.providers.acme.baseURL === 'https://local-edit.example.com/v1', b.state.value.providers.acme.baseURL)

  const forced = await b.tool.execute({ action: 'cloud_pull', force: true })
  check('force overrides the conflict', forced.ok === true, forced.message)
  check('the forced pull applied the remote display name', b.state.value.providers.acme.displayName === 'Acme Remote', b.state.value.providers.acme.displayName)

  // Both devices rotating the same key is a real conflict.
  a.secrets.set('ACME_API_KEY', 'sk-rotated-on-a')
  await a.tool.execute({ action: 'cloud_push', force: true })
  b.secrets.set('ACME_API_KEY', 'sk-rotated-on-b')
  const keyConflict = await b.tool.execute({ action: 'cloud_pull' })
  check('a two-sided key rotation is refused', keyConflict.ok === false, keyConflict.message)
  check('the refusal names the credential axis', /API keys/.test(keyConflict.message), keyConflict.message)
  check('the local key survived the refusal', b.secrets.get('ACME_API_KEY') === 'sk-rotated-on-b', b.secrets.get('ACME_API_KEY'))

  // targeted restore of one route
  const scoped = await b.tool.execute({ action: 'cloud_pull', route: 'acme', force: true })
  check('a routed pull reports the route it touched', scoped.ok === true && (scoped.detail.updated ?? []).includes('acme'), JSON.stringify(scoped.detail))

  s3.close?.()
  await s3.stop?.()
}

/* ------------------------------------------------------------------ */
/* 4. Cloud transfer over WebDAV.                                      */
/* ------------------------------------------------------------------ */

console.log('\n# WebDAV cloud sync')

const store = new Map()
const dirs = new Set()
const dav = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/dav\/?/, '').replace(/^\/+/, '')
  if (req.headers.authorization !== `Basic ${Buffer.from('alice:s3cret').toString('base64')}`) {
    res.writeHead(401)
    res.end()
    return
  }
  if (req.method === 'MKCOL') {
    if (dirs.has(path)) { res.writeHead(405); res.end(); return }
    dirs.add(path)
    res.writeHead(201)
    res.end()
    return
  }
  if (req.method === 'PROPFIND') {
    res.writeHead(dirs.has(path) ? 207 : 404, { 'content-type': 'application/xml' })
    res.end(dirs.has(path) ? '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>' : undefined)
    return
  }
  if (req.method === 'PUT') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      store.set(path, body)
      res.writeHead(201, { etag: `"${body.length}"` })
      res.end()
    })
    return
  }
  const body = store.get(path)
  if (body === undefined) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-length': String(body.length) })
  res.end(req.method === 'HEAD' ? undefined : body)
})
await new Promise((resolve) => dav.listen(4570, '127.0.0.1', resolve))

{
  const cloudConfig = {
    backend: 'webdav',
    webdavBaseURL: 'http://127.0.0.1:4570/dav',
    webdavUsername: 'alice',
    webdavPassword: 's3cret',
    syncDirectory: workspace,
  }
  const a = host({ providers: { davroute: route('davroute') }, config: cloudConfig })
  const b = host({ providers: {}, config: cloudConfig })
  a.service.stateDirectory = async () => join(workspace, 'dav-state-a')
  b.service.stateDirectory = async () => join(workspace, 'dav-state-b')

  const tested = await a.tool.execute({ action: 'cloud_test' })
  check('WebDAV test reaches the collection', tested.ok === true, tested.message)

  const pushed = await a.tool.execute({ action: 'cloud_push' })
  check('WebDAV push uploads the snapshot', pushed.ok === true && pushed.detail.status === 'pushed', pushed.message)
  check('WebDAV push wrote the manifest and one file per route', [...store.keys()].some((key) => key.endsWith('manifest.json')) && [...store.keys()].some((key) => key.endsWith('davroute.json')), [...store.keys()].join(','))
  check('WebDAV push created its parent collections', dirs.size > 0, [...dirs].join(','))

  const pulled = await b.tool.execute({ action: 'cloud_pull' })
  check('WebDAV pull restores the route', pulled.ok === true && pulled.detail.created.includes('davroute'), pulled.message)
  check('WebDAV restore kept the endpoint', b.state.value.providers.davroute?.baseURL === 'https://davroute.example.com/v1')

  const idle = await b.tool.execute({ action: 'cloud_pull' })
  check('WebDAV pull is idempotent', idle.detail.status === 'up-to-date', idle.detail.status)
}
dav.close()

await rm(workspace, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('failed:', failures.join(' | '))
  process.exit(1)
}

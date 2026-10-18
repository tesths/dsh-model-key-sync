/**
 * Cloud sync service: push and pull model declarations through an S3-compatible
 * bucket or a WebDAV collection.
 *
 * The sync is deliberately manual and two-way: `push` writes the remote from
 * this installation, `pull` merges the remote into this profile. Neither runs
 * on its own, and neither silently overwrites the other side. What each side
 * last saw is recorded in a local state file, so a pull can tell "the remote is
 * exactly what I pushed last time" from "someone else moved it", and a push can
 * refuse to clobber a remote that moved since the last sync.
 *
 * See `cloud/snapshot.js` for the manifest format and `cloud/transport.js` for
 * the two backends.
 *
 * @module @local/dsh-model-sync/cloud
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import {
  KEYS_NAME, MANIFEST_NAME, SYNC_FORMAT, SYNC_VERSION, buildSnapshot, credentialsBody, isCredentialObject,
  keysOf, remotePath, remoteSegments, routesOf, snapshotIdOf, validateManifest, verifyObject,
} from './snapshot.js'
import { sha256Hex, transportFor } from './transport.js'

/** A push is required when the remote moved under us and this side also changed. */
const CONFLICT = 'cloud/conflict'

/**
 * Read one credential slot, preferring the literal secret and falling back to
 * the environment variable the slot names.
 * @param {{ literal?: string, slot: string }} source - the field values.
 * @returns {string} the credential, or the empty string when neither is set.
 */
export function credentialOf({ literal, slot }) {
  const direct = typeof literal === 'string' ? literal.trim() : ''
  if (direct.length > 0 && !/^[A-Z_][A-Z0-9_]*$/.test(direct)) return direct
  const name = direct.length > 0 ? direct : (typeof slot === 'string' ? slot.trim() : '')
  if (name.length === 0) return ''
  return (process.env[name] ?? '').trim()
}

/**
 * Describe this installation to the remote, the way CC Switch names a device.
 * @returns {string} a short, stable device name.
 */
export function deviceName() {
  return String(process.env.DSH_MODEL_SYNC_DEVICE ?? '').trim() || hostname().replace(/\.local$/, '') || 'Unknown Device'
}

/**
 * Identity of a credential bundle: the values, in name order.
 *
 * Hashing rather than storing the values keeps the sync state file free of
 * secrets while still letting a pull tell "the keys moved" from "this device
 * never had them".
 * @param {Record<string, string>} keys - credential name to value.
 * @returns {string | undefined} the hash, or undefined when the bundle is empty.
 */
function credentialsHash(keys) {
  const names = Object.keys(keys ?? {}).filter((name) => typeof keys[name] === 'string' && keys[name].length > 0)
  if (names.length === 0) return undefined
  return sha256Hex(credentialsBody(keys))
}

/**
 * Snapshot identity of the route objects only.
 * @param {Record<string, unknown>} manifest - a validated manifest.
 * @returns {string} the id a routes-only comparison uses.
 */
function routesIdOf(manifest) {
  const routes = {}
  for (const [name, meta] of Object.entries(manifest.artifacts ?? {})) {
    if (isCredentialObject(name, meta)) continue
    routes[name] = meta
  }
  return snapshotIdOf(routes)
}

/** Cloud sync for one profile. */
export class CloudSync {
  /**
   * @param {object} options - collaborators.
   * @param {() => Promise<object>} options.settings - reads the live row config.
   * @param {() => Promise<Record<string, object>>} options.collect - exports routes.
   * @param {(request: object) => Promise<object>} options.apply - merges routes back.
   * @param {() => Promise<string>} options.stateDirectory - where sync state lives.
   */
  constructor(options) {
    this.options = options
    // Serializes transfers. The page drives this object through a settings
    // command while an agent tool call can arrive at the same moment; two
    // concurrent pushes would interleave their objects and both write the sync
    // state, leaving the remote describing a snapshot neither device uploaded.
    this.queue = Promise.resolve()
  }

  /**
   * Run one transfer with no other transfer in flight.
   * @param {() => Promise<Record<string, unknown>>} operation - the transfer.
   * @returns {Promise<Record<string, unknown>>} its result.
   */
  async exclusive(operation) {
    const run = this.queue.then(operation, operation)
    // Keep the chain alive regardless of the outcome of this operation.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * The resolved cloud configuration, with credentials filled in.
   * @returns {Promise<{ cloud: Record<string, unknown>, segments: string[] }>} configuration and remote path.
   */
  async resolved() {
    const config = await this.options.settings()
    const cloud = {
      backend: String(config.backend ?? ''),
      remoteRoot: String(config.remoteRoot ?? 'dsh-model-sync'),
      profile: String(config.profile ?? 'default'),
      autoSync: config.autoSync === true,
      s3Bucket: String(config.s3Bucket ?? ''),
      s3Region: String(config.s3Region ?? 'auto'),
      s3Endpoint: String(config.s3Endpoint ?? ''),
      s3AccessKeyId: credentialOf({ literal: config.s3AccessKeyIdEnv, slot: '' }),
      s3SecretAccessKey: credentialOf({ literal: config.s3SecretAccessKey, slot: config.s3SecretAccessKeyEnv }),
      webdavBaseURL: String(config.webdavBaseURL ?? ''),
      webdavUsername: String(config.webdavUsername ?? ''),
      webdavPassword: credentialOf({ literal: config.webdavPassword, slot: config.webdavPasswordEnv }),
    }
    return { cloud, segments: remoteSegments(cloud.remoteRoot, cloud.profile) }
  }

  /**
   * Whether a backend is configured at all.
   * @param {Record<string, unknown>} cloud - resolved configuration.
   * @returns {boolean} true when sync can run.
   */
  static configured(cloud) {
    if (cloud.backend === 's3') return cloud.s3Bucket.length > 0
    if (cloud.backend === 'webdav') return cloud.webdavBaseURL.length > 0
    return false
  }

  /** Path of this installation's sync state file. */
  async statePath() {
    return join(await this.options.stateDirectory(), 'cloud-state.json')
  }

  /**
   * Read the last sync record. The file is advisory: a damaged one only costs a
   * conflict prompt, never data.
   * @returns {Promise<Record<string, unknown>>} the stored state.
   */
  async state() {
    try {
      const parsed = JSON.parse(await readFile(await this.statePath(), 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Persist the sync record after a successful transfer. */
  async remember(patch) {
    const path = await this.statePath()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${JSON.stringify(patch, null, 2)}\n`, 'utf8')
  }

  /** Build the transport from the live configuration. */
  async transport() {
    const { cloud, segments } = await this.resolved()
    if (!CloudSync.configured(cloud)) {
      throw new Error(cloud.backend === '' ? 'cloud sync is off: choose an S3-compatible or WebDAV backend first' : `the ${cloud.backend} connection is incomplete`)
    }
    return { transport: transportFor(cloud), segments, cloud }
  }

  /**
   * What the remote currently holds, without downloading the payload.
   * @returns {Promise<<Record<string, unknown>> & { exists: boolean }>} the remote summary.
   */
  async info() {
    const { transport, segments, cloud } = await this.transport()
    const path = remotePath(segments, MANIFEST_NAME)
    const stored = await transport.get(path)
    const local = await this.options.collect()
    const localSnapshot = buildSnapshot({ routes: Object.values(local), deviceName: deviceName(), allowEmpty: true })
    const base = {
      backend: cloud.backend,
      remotePath: segments.join('/'),
      location: transport.describe(),
      localSnapshotId: localSnapshot.manifest.snapshotId,
      localRoutes: Object.keys(local),
    }
    if (stored === undefined) return { ...base, exists: false }
    let manifest
    let problem
    try {
      manifest = validateManifest(JSON.parse(stored.body.toString('utf8')))
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    const state = await this.state()
    const snapshotId = manifest?.snapshotId ?? sha256Hex(stored.body)
    return {
      ...base,
      exists: true,
      etag: stored.etag,
      snapshotId,
      deviceName: manifest?.deviceName,
      createdAt: manifest?.createdAt,
      objects: manifest === undefined ? [] : Object.keys(manifest.artifacts),
      routes: manifest === undefined ? [] : Object.values(manifest.artifacts).map((entry) => entry.provider).filter((value) => typeof value === 'string'),
      compatible: false,
      ...(problem === undefined ? { compatible: true } : { problem }),
      inSync: snapshotId === localSnapshot.manifest.snapshotId,
      remoteMoved: typeof state.snapshotId === 'string' && state.snapshotId !== snapshotId,
      lastSyncAt: state.lastSyncAt,
    }
  }

  /**
   * Upload this installation's declarations.
   * @param {{ force?: boolean }} [request] - `force` writes even when the remote moved.
   * @returns {Promise<Record<string, unknown>>} the outcome.
   */
  async push(request = {}) {
    return this.exclusive(() => this.pushNow(request))
  }

  /** One push, with the queue already held. */
  async pushNow(request = {}) {
    const { transport, segments, cloud } = await this.transport()
    const local = await this.options.collect()
    const keys = typeof this.options.collectKeys === 'function' ? await this.options.collectKeys() : {}
    const snapshot = buildSnapshot({ routes: Object.values(local), keys, deviceName: deviceName() })
    const state = await this.state()
    const manifestPath = remotePath(segments, MANIFEST_NAME)
    const existing = await transport.get(manifestPath)
    let remoteSnapshotId
    if (existing !== undefined) {
      try {
        remoteSnapshotId = validateManifest(JSON.parse(existing.body.toString('utf8'))).snapshotId
      } catch {
        remoteSnapshotId = sha256Hex(existing.body)
      }
    }
    const identical = remoteSnapshotId !== undefined && remoteSnapshotId === snapshot.manifest.snapshotId
    if (identical && request.force !== true) {
      const nowUpToDate = new Date().toISOString()
      await this.remember({
        backend: cloud.backend,
        remotePath: segments.join('/'),
        snapshotId: snapshot.manifest.snapshotId,
        routesSnapshotId: routesIdOf(snapshot.manifest),
        credentialsHash: credentialsHash(keys),
        etag: existing?.etag,
        routes: Object.keys(local),
        lastSyncAt: state.lastSyncAt,
        lastCheckedAt: nowUpToDate,
        lastDirection: 'push',
      })
      return {
        status: 'up-to-date',
        snapshotId: snapshot.manifest.snapshotId,
        routes: Object.keys(local),
        credentials: Object.keys(keys).sort(),
        objects: snapshot.objects.map((object) => object.name),
        remotePath: segments.join('/'),
        lastSyncAt: state.lastSyncAt,
      }
    }
    const remoteMoved = remoteSnapshotId !== undefined && typeof state.snapshotId === 'string' && state.snapshotId !== remoteSnapshotId
    if (remoteMoved && request.force !== true) {
      const error = new Error(`the remote moved since the last sync (its snapshot is ${String(remoteSnapshotId).slice(0, 8)}…, this device last saw ${String(state.snapshotId).slice(0, 8)}…); pull first, or push with force to overwrite it`)
      error.code = CONFLICT
      throw error
    }
    // Payload first, manifest last: a reader never sees a manifest that names
    // an object the writer has not finished uploading.
    for (const object of snapshot.objects) {
      await transport.put(remotePath(segments, object.name), object.body)
    }
    const manifestBody = Buffer.from(`${JSON.stringify(snapshot.manifest, null, 2)}\n`, 'utf8')
    const written = await transport.put(manifestPath, manifestBody)
    let etag = written.etag
    if (etag === undefined && typeof transport.head === 'function') {
      etag = (await transport.head(manifestPath))?.etag
    }
    const now = new Date().toISOString()
    await this.remember({
      backend: cloud.backend,
      remotePath: segments.join('/'),
      snapshotId: snapshot.manifest.snapshotId,
      routesSnapshotId: routesIdOf(snapshot.manifest),
      credentialsHash: credentialsHash(keys),
      manifestHash: sha256Hex(manifestBody),
      etag,
      routes: Object.keys(local),
      lastSyncAt: now,
      lastDirection: 'push',
    })
    return {
      status: 'pushed',
      snapshotId: snapshot.manifest.snapshotId,
      routes: Object.keys(local),
      credentials: Object.keys(keys).sort(),
      objects: snapshot.objects.map((object) => object.name),
      remotePath: segments.join('/'),
      etag,
      lastSyncAt: now,
    }
  }

  /**
   * Merge the remote snapshot into this profile.
   * @param {{ force?: boolean, replaceAll?: boolean, route?: string }} [request] - `force` applies even when the remote is older than the last sync.
   * @returns {Promise<Record<string, unknown>>} the outcome.
   */
  async pull(request = {}) {
    return this.exclusive(() => this.pullNow(request))
  }

  /** One pull, with the queue already held. */
  async pullNow(request = {}) {
    const { transport, segments, cloud } = await this.transport()
    const manifestPath = remotePath(segments, MANIFEST_NAME)
    const stored = await transport.get(manifestPath)
    if (stored === undefined) throw new Error(`the remote at ${segments.join('/')} holds no snapshot yet; push one from this device first`)
    let manifest
    try {
      manifest = validateManifest(JSON.parse(stored.body.toString('utf8')))
    } catch (error) {
      throw new Error(`the remote snapshot cannot be used: ${error instanceof Error ? error.message : String(error)}`)
    }
    const state = await this.state()
    const local = await this.options.collect()
    const localKeys = typeof this.options.collectKeys === 'function' ? await this.options.collectKeys() : {}
    const localSnapshot = buildSnapshot({ routes: Object.values(local), keys: localKeys, deviceName: deviceName(), allowEmpty: true })

    // A three-way comparison against the last sync, on two axes: routes and
    // credentials. A pulled key overwrites a local one, so a divergence in
    // either direction needs the user's consent. Comparing each side to the
    // baseline rather than to each other is what keeps "the other device
    // changed" from being reported as "both sides changed".
    const manifestRoutesId = routesIdOf(manifest)
    const localRoutesId = routesIdOf(localSnapshot.manifest)
    const manifestKeysHash = typeof manifest.artifacts?.[KEYS_NAME]?.sha256 === 'string' ? manifest.artifacts[KEYS_NAME].sha256 : undefined
    const localKeysHash = credentialsHash(localKeys)
    const baselineKnown = typeof state.snapshotId === 'string'
    const routesLocalChanged = baselineKnown && typeof state.routesSnapshotId === 'string' && localRoutesId !== state.routesSnapshotId
    const routesRemoteChanged = baselineKnown && typeof state.routesSnapshotId === 'string' && manifestRoutesId !== state.routesSnapshotId
    const keysLocalChanged = baselineKnown && typeof state.credentialsHash === 'string' && localKeysHash !== state.credentialsHash
    const keysRemoteChanged = baselineKnown && typeof state.credentialsHash === 'string' && manifestKeysHash !== state.credentialsHash
    if ((routesLocalChanged && routesRemoteChanged || keysLocalChanged && keysRemoteChanged) && request.force !== true) {
      const axes = []
      if (routesLocalChanged && routesRemoteChanged) axes.push('model routes')
      if (keysLocalChanged && keysRemoteChanged) axes.push('API keys')
      const error = new Error(`both sides changed since the last sync (${axes.join(' and ')}); pull with force to take the remote, or push to keep this device`)
      error.code = CONFLICT
      throw error
    }
    if (manifest.snapshotId === localSnapshot.manifest.snapshotId && request.force !== true) {
      return {
        status: 'up-to-date',
        snapshotId: manifest.snapshotId,
        deviceName: manifest.deviceName,
        createdAt: manifest.createdAt,
        created: [],
        updated: [],
        credentials: [],
        remotePath: segments.join('/'),
        lastSyncAt: state.lastSyncAt,
      }
    }
    const records = []
    let remoteKeys = {}
    for (const [name, meta] of Object.entries(manifest.artifacts)) {
      const object = await transport.get(remotePath(segments, name))
      if (object === undefined) throw new Error(`the remote manifest lists ${name}, but the object is missing`)
      verifyObject(name, object.body, meta)
      if (isCredentialObject(name, meta)) remoteKeys = keysOf(object.body)
      else records.push(...routesOf(name, object.body))
    }
    const wanted = typeof request.route === 'string' && request.route.length > 0
      ? records.filter((record) => record.provider === request.route)
      : records
    if (wanted.length === 0) throw new Error('the remote snapshot carries no route this request selected')
    const outcome = await this.options.apply({ routes: wanted, replaceAll: request.replaceAll === true })
    // Credentials are applied after the routes that name them, and only for the
    // routes this pull actually took.
    let appliedKeys = []
    if (Object.keys(remoteKeys).length > 0 && typeof this.options.applyKeys === 'function') {
      const referenced = new Set()
      for (const record of wanted) if (typeof record.apiKeyEnv === 'string') referenced.add(record.apiKeyEnv)
      const selected = request.route === undefined
        ? remoteKeys
        : Object.fromEntries(Object.entries(remoteKeys).filter(([name]) => referenced.has(name)))
      if (Object.keys(selected).length > 0) appliedKeys = await this.options.applyKeys(selected)
    }
    const now = new Date().toISOString()
    await this.remember({
      backend: cloud.backend,
      remotePath: segments.join('/'),
      snapshotId: manifest.snapshotId,
      routesSnapshotId: manifestRoutesId,
      credentialsHash: credentialsHash({ ...localKeys, ...remoteKeys }),
      manifestHash: sha256Hex(Buffer.from(JSON.stringify(manifest), 'utf8')),
      etag: stored.etag,
      routes: wanted.map((record) => String(record.provider)),
      lastSyncAt: now,
      lastDirection: 'pull',
    })
    return {
      status: 'pulled',
      snapshotId: manifest.snapshotId,
      deviceName: manifest.deviceName,
      createdAt: manifest.createdAt,
      created: outcome.created ?? [],
      updated: outcome.updated ?? [],
      credentials: appliedKeys,
      remotePath: segments.join('/'),
      lastSyncAt: now,
    }
  }

  /**
   * Check the connection without transferring a snapshot.
   * @returns {Promise<{ ok: boolean, location?: string, remotePath?: string, detail?: string }>} the probe result.
   */
  async test() {
    const { transport, segments, cloud } = await this.transport()
    const info = { location: transport.describe(), remotePath: segments.join('/'), backend: cloud.backend }
    if (cloud.backend === 'webdav' && typeof transport.mkdir === 'function') {
      await transport.mkdir(segments.join('/'))
      return { ok: true, ...info, detail: 'directory reachable and writable' }
    }
    if (cloud.backend === 's3' && typeof transport.list === 'function') {
      const objects = await transport.list(`${segments.join('/')}/`)
      return { ok: true, ...info, detail: `${objects.length} object(s) under the remote path` }
    }
    return { ok: true, ...info }
  }

  /**
   * List what a remote holds, so the page can show it before a pull.
   * @returns {Promise<{ remotePath: string, objects: Array<Record<string, unknown>> }>} the listing.
   */
  async objects() {
    const { transport, segments } = await this.transport()
    const prefix = `${segments.join('/')}/`
    const rows = await transport.list(prefix)
    return { remotePath: segments.join('/'), objects: rows }
  }
}

export { CONFLICT, SYNC_FORMAT, SYNC_VERSION }

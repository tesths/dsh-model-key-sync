/**
 * Snapshot format and remote layout for Model Sync cloud storage.
 *
 * The design follows the same shape CC Switch uses for its WebDAV/S3 sync,
 * adapted to model declarations instead of a database file:
 *
 * - a remote holds **one manifest** plus the payload objects it lists;
 * - the manifest is written **last**, so a reader never sees a manifest that
 *   describes objects the writer has not uploaded;
 * - every object carries `sha256` and `size`, verified on download;
 * - the layout carries a protocol version and a model-document version, so an
 *   older installation refuses a snapshot it cannot apply instead of guessing;
 * - `profile` is a namespaced subdirectory, so one bucket can hold several
 *   independent configurations.
 *
 * Layout: `{remoteRoot}/v{protocolVersion}/{profile}/manifest.json` and one
 * object per route beside it, `<route>.json`.
 *
 * @module dsh-model-key-sync/cloud/snapshot
 */

import { sha256Hex } from './transport.js'

/** Marker that names this document to the remote and to a human reading it. */
export const SYNC_FORMAT = 'dsh-model-key-sync/cloud'
/** Formats a remote may still carry; both are structurally identical. */
export const READABLE_SYNC_FORMATS = [SYNC_FORMAT, 'dsh-model-sync/cloud']
/** Bumped when the manifest shape changes incompatibly. */
export const SYNC_VERSION = 1
/** Bumped when the provider-record shape needs a newer installation to apply. */
export const DOC_VERSION = 1
/** Object name of the manifest. */
export const MANIFEST_NAME = 'manifest.json'
/**
 * Object name of the credential bundle.
 *
 * Keys travel as their own artifact for two reasons: a reader can tell whether a
 * snapshot carries credentials without parsing every route, and a pull can apply
 * routes and credentials separately. The payload is plaintext, matching CC
 * Switch's behaviour — whoever can read the remote can read the keys.
 */
export const KEYS_NAME = 'keys.json'

/**
 * Remote directory segments for one profile.
 * @param {string} remoteRoot - configured root inside the bucket or collection.
 * @param {string} profile - namespace for one configuration.
 * @returns {string[]} path segments, never containing `..`.
 */
export function remoteSegments(remoteRoot, profile) {
  const clean = []
  for (const segment of String(remoteRoot ?? '').split('/')) {
    const value = segment.trim()
    if (value.length === 0 || value === '.' || value === '..') continue
    clean.push(value.replace(/[^A-Za-z0-9._-]+/g, '-'))
  }
  const space = String(profile ?? '').trim()
  clean.push(space.length === 0 ? 'default' : space.replace(/[^A-Za-z0-9._-]+/g, '-'))
  clean.splice(0, 0, `v${SYNC_VERSION}`)
  return clean
}

/** Join segments into a transport path. */
export function remotePath(segments, name) {
  return [...segments, name].join('/')
}

/**
 * Canonical bytes of the credential bundle.
 *
 * Exported because the sync layer hashes it to compare a local bundle against a
 * remote one: both sides must derive the same bytes from the same keys, or a
 * comparison would report a change that did not happen.
 * @param {Record<string, string>} keys - credential name to value.
 * @returns {Buffer} the canonical body.
 */
export function credentialsBody(keys) {
  const names = Object.keys(keys ?? {}).filter((name) => typeof keys[name] === 'string' && keys[name].length > 0).sort()
  const bundle = {}
  for (const name of names) bundle[name] = keys[name]
  return Buffer.from(`${JSON.stringify({ format: 'dsh-model-sync/keys', version: 1, keys: bundle }, null, 2)}\n`, 'utf8')
}

/**
 * Deterministic identity of a snapshot: the payload hashes in name order.
 * Two devices that hold identical model declarations compute the same id, so a
 * sync can tell "already in sync" from "the remote moved" without downloading.
 * @param {Record<string, { sha256: string }>} objects - object metadata keyed by name.
 * @returns {string} the snapshot id.
 */
export function snapshotIdOf(objects) {
  const parts = Object.keys(objects).sort().map((name) => `${name}:${objects[name].sha256}`)
  return sha256Hex(parts.join('|'))
}

/**
 * Build the objects and manifest one upload writes.
 * @param {object} options - inputs.
 * @param {Array<Record<string, unknown>>} options.routes - provider records.
 * @param {string} options.deviceName - this installation's name.
 * @param {number | undefined} options.localRevision - settings revision the record was read at.
 * @param {Date} [options.now] - the instant, for tests.
 * @returns {{ manifest: Record<string, unknown>, objects: Array<{ name: string, body: Buffer }> }} the upload.
 */
export function buildSnapshot({ routes, keys, deviceName, localRevision, allowEmpty = false, now = new Date() }) {
  if (!Array.isArray(routes)) throw new Error('routes must be an array')
  if (routes.length === 0 && !allowEmpty) throw new Error('there is no model route to upload yet')
  const objects = []
  const artifacts = {}
  for (const route of routes) {
    const provider = String(route?.provider ?? '').trim()
    if (provider.length === 0) throw new Error('every uploaded route needs a provider id')
    const name = `${provider.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`
    const body = Buffer.from(`${JSON.stringify({ format: 'dsh-model-key-sync/provider', version: 1, routes: [route] }, null, 2)}\n`, 'utf8')
    objects.push({ name, body, route: provider })
    artifacts[name] = { sha256: sha256Hex(body), size: body.length, provider }
  }
  const credentialNames = Object.keys(keys ?? {}).filter((name) => typeof keys[name] === 'string' && keys[name].length > 0).sort()
  if (credentialNames.length > 0) {
    const body = credentialsBody(keys)
    objects.push({ name: KEYS_NAME, body })
    artifacts[KEYS_NAME] = { sha256: sha256Hex(body), size: body.length, kind: 'keys' }
  }
  const manifest = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    docVersion: DOC_VERSION,
    deviceName,
    createdAt: now.toISOString(),
    ...(localRevision === undefined ? {} : { localRevision }),
    snapshotId: snapshotIdOf(artifacts),
    artifactCount: objects.length,
    credentialCount: credentialNames.length,
    artifacts,
  }
  return { manifest, objects, credentials: credentialNames }
}

/**
 * Check a downloaded manifest against what this installation can apply.
 * @param {unknown} manifest - parsed manifest.
 * @returns {Record<string, unknown>} the manifest, when usable.
 */
export function validateManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('the remote manifest is not a JSON object')
  }
  if (!READABLE_SYNC_FORMATS.includes(manifest.format)) {
    throw new Error(`the remote holds "${String(manifest.format)}", not a Model Sync snapshot`)
  }
  if (manifest.version !== SYNC_VERSION) {
    throw new Error(`the remote snapshot protocol is v${String(manifest.version)}; this installation speaks v${SYNC_VERSION}`)
  }
  if (manifest.docVersion !== DOC_VERSION) {
    throw new Error(`the remote snapshot needs document version ${String(manifest.docVersion)}; this installation supports ${DOC_VERSION}`)
  }
  if (typeof manifest.artifacts !== 'object' || manifest.artifacts === null) {
    throw new Error('the remote manifest lists no objects')
  }
  return manifest
}

/**
 * Verify downloaded bytes against the manifest entry.
 * @param {string} name - object name.
 * @param {Buffer} body - downloaded bytes.
 * @param {{ sha256?: string, size?: number }} expected - manifest entry.
 * @returns {Buffer} the body, when it matches.
 */
export function verifyObject(name, body, expected) {
  if (typeof expected?.size === 'number' && body.length !== expected.size) {
    throw new Error(`${name} is ${body.length} bytes, but the manifest says ${expected.size}`)
  }
  const hash = sha256Hex(body)
  if (typeof expected?.sha256 === 'string' && hash !== expected.sha256) {
    throw new Error(`${name} failed its checksum (expected ${expected.sha256.slice(0, 8)}…, got ${hash.slice(0, 8)}…)`)
  }
  return body
}

/**
 * Turn one downloaded object into the provider records it carries.
 * @param {string} name - object name, for error messages.
 * @param {Buffer} body - object bytes.
 * @returns {Array<Record<string, unknown>>} route records.
 */
export function isCredentialObject(name, meta) {
  return name === KEYS_NAME || meta?.kind === 'keys'
}

/**
 * Turn the credential object into the map it carries.
 * @param {Buffer} body - object bytes.
 * @returns {Record<string, string>} credential name to value.
 */
export function keysOf(body) {
  let document
  try {
    document = JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new Error(`${KEYS_NAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const keys = document?.keys
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) throw new Error(`${KEYS_NAME} carries no credential map`)
  const out = {}
  for (const [name, value] of Object.entries(keys)) if (typeof value === 'string' && value.length > 0) out[name] = value
  return out
}

export function routesOf(name, body) {
  let document
  try {
    document = JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const routes = Array.isArray(document?.routes) ? document.routes : (document?.provider === undefined ? [] : [document])
  if (routes.length === 0) throw new Error(`${name} carries no provider route`)
  return routes
}

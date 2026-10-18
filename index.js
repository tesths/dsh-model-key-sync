/**
 * Host half of the Model Sync bundle.
 *
 * Keeps the user's *custom* model declarations — display name, API endpoint,
 * protocol, model catalog and the optional per-model extras — exportable as
 * JSON files and restorable in the live profile. This is how the same models
 * travel between two DSH installations.
 *
 * Every write goes through `ctx.settings.update(ns, { providers })`, the seam
 * the shipped Models page uses, so a restored profile is validated by the
 * `llm-pi-ai` adapter before it is accepted. Credentials are only ever named
 * (`apiKeyEnv` / `headers` values are not read back into the snapshot unless
 * the user opts in), and no secret value is written by this plugin at all.
 *
 * @module dsh-model-key-sync
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CloudSync, credentialOf } from './cloud/sync.js'

/**
 * Load the schema library the Host already runs on.
 *
 * A profile-installed bundle cannot resolve `@deepseek-ai/*` through Node's
 * package resolution — the only `node_modules` in scope is the profile's. The
 * Harness installation itself is readable from the Host process, though, so an
 * absolute path into it works. This matters: without a real `Config` schema the
 * plugin has no settings namespace, and a page can never reach the Host.
 * @returns {Promise<unknown>} the schemastery default export, or `undefined`
 * when the installation cannot be located (the plugin then runs without a
 * settings page instead of failing to activate).
 */
async function loadSchema() {
  const roots = []
  // Electron exposes the installation root here on every platform, so the
  // lookup works on Windows and Linux without a hardcoded application path.
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources.length > 0) {
    roots.push(join(resources, 'app.asar/dsh/node_modules/@deepseek-ai'))
    roots.push(join(resources, 'dsh/node_modules/@deepseek-ai'))
  }
  // Escape hatch for an unusual layout, set to the directory that holds the
  // Harness React/Cordis packages.
  const override = process.env.DSH_HARNESS_MODULES
  if (typeof override === 'string' && override.length > 0) roots.push(join(override, '@deepseek-ai'))
  for (const root of roots) {
    for (const entry of ['schemastery/lib/index.mjs', 'schemastery/lib/index.cjs']) {
      try {
        const loaded = await import(pathToFileURL(join(root, entry)).href)
        const candidate = loaded.default ?? loaded
        if (typeof candidate?.object === 'function') return candidate
      } catch {
        // try the next location
      }
    }
  }
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    return loaded.default ?? loaded
  } catch {
    return undefined
  }
}

const z = await loadSchema()

/** Plugin name; also the Client module id and the Client locale namespace. */
export const name = 'dsh-model-key-sync'

/** Protocols `llm-pi-ai` accepts for a provider route. */
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** Reasoning levels the adapter accepts as `reasoningEfforts` keys. */
const EFFORT_KEYS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Provider fields this page owns: they are copied to and from a snapshot.
 * ROUTE_FIELDS are rebuilt from the record; PROVIDER_FIELDS travel when the
 * record carries them. Every other field of a live profile (retry policy, image
 * limits, timeouts, compat switches, transport…) is preserved untouched.
 */
const ROUTE_FIELDS = ['displayName', 'api', 'baseURL', 'models', 'apiKeyEnv']
const PROVIDER_FIELDS = ['defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'reasoning', 'cacheRetention', 'thinkingBudgets']

/** Per-model fields the page copies; anything else on a model row is dropped. */
const MODEL_FIELDS = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']

/** Marker in every snapshot file, so a foreign JSON file cannot be restored by accident. */
const FILE_FORMAT = 'dsh-model-key-sync/provider'

/**
 * Formats this plugin still reads.
 *
 * An export made before the rename stays importable: refusing it would strand a
 * file the user already has, and the shape is identical.
 */
const READABLE_FORMATS = [FILE_FORMAT, 'dsh-model-sync/provider']
const FILE_VERSION = 1

/** Deployment headers that carry credentials and are therefore never exported by default. */
const SENSITIVE_HEADER = /^(authorization|api-key|x-api-key|proxy-authorization|openai-organization|.*-token.*|.*secret.*|.*key.*)$/i

/** Cloud fields handed to the transport layer. */
const CLOUD_FIELDS = ['backend', 'remoteRoot', 'profile', 'autoSync', 's3Bucket', 's3Region', 's3Endpoint', 's3AccessKeyIdEnv', 's3SecretAccessKeyEnv', 'webdavBaseURL', 'webdavUsername', 'webdavPasswordEnv']

/** Fields that hold a credential; they never reach a snapshot or the page. */
const SECRET_FIELDS = ['s3SecretAccessKey', 'webdavPassword', 's3AccessKeyId']

/**
 * Row options plus everything the settings page owns.
 *
 * Every field is `volatile`, so the page can edit it without remounting the
 * plugin, and it lands in the profile's `cordis.patch.yml` exactly like a
 * shipped plugin's settings. Secrets are `role('secret')`: the settings service
 * strips them from every response the page receives, so a stored key is never
 * echoed back to the browser.
 */
function buildConfig(z) {
  const configShape = {
    llmEntryId: z.string().default('llm-pi-ai').volatile().description('Loader entry id of the model adapter whose providers this plugin edits.'),
    syncDirectory: z.string().default('~/dsh-model-key-sync').volatile().description('Where local snapshot files are written.'),
    keepPerProvider: z.natural().default(20).volatile().description('How many local snapshot files to keep per provider route.'),
    includeHeaders: z.boolean().default(false).volatile().description('Copy provider `headers` into snapshots. Sensitive names stay filtered out.'),

  autoSync: z.boolean().default(false).volatile().description('Upload automatically after a model edit. A pull never triggers an upload.'),

  syncCredentials: z.boolean().default(true).volatile().description('Upload the API keys behind each route and store them on pull. The keys are stored in the remote as plaintext, so anyone with access to that remote can read them.'),

    backend: z.union([z.const(''), z.const('s3'), z.const('webdav')]).default('').volatile().description('Cloud backend. Empty keeps cloud sync off.'),
    remoteRoot: z.string().default('dsh-model-key-sync').volatile().description('Remote directory that holds the snapshots.'),
    profile: z.string().default('default').volatile().description('Remote subdirectory, one per machine group.'),

    s3Bucket: z.string().default('').volatile().description('S3-compatible bucket name.'),
    s3Region: z.string().default('auto').volatile().description('Bucket region; R2 uses auto, AWS uses the real region.'),
    s3Endpoint: z.string().default('').volatile().description('Custom endpoint such as https://<account>.r2.cloudflarestorage.com. Empty means AWS.'),
    s3AccessKeyId: z.string().default('').volatile().description('Access key id.'),
    s3SecretAccessKey: z.string().role('secret').default('').volatile().description('Secret access key.'),
    s3AccessKeyIdEnv: z.string().default('S3_ACCESS_KEY_ID').volatile().description('Environment variable to read the access key id from when the field above is empty.'),
    s3SecretAccessKeyEnv: z.string().default('S3_SECRET_ACCESS_KEY').volatile().description('Environment variable to read the secret access key from.'),

    webdavBaseURL: z.string().default('').volatile().description('WebDAV collection URL.'),
    webdavUsername: z.string().default('').volatile().description('WebDAV user name.'),
    webdavPassword: z.string().role('secret').default('').volatile().description('WebDAV password.'),
    webdavPasswordEnv: z.string().default('WEBDAV_PASSWORD').volatile().description('Environment variable to read the WebDAV password from.'),

    command: z.string().default('').volatile().description('Pending action posted by the settings page as a JSON string; the Host performs it and answers through `status`.'),
    status: z.string().default('').volatile().description('Outcome of the last action as a JSON string, written by the Host.'),
  }

  return z.object(configShape)
}

/**
 * Validated row configuration, or `undefined` on a Host that could not load the
 * schema library.
 *
 * Exporting no `Config` costs the settings page but keeps the agent tool
 * working; exporting a broken one would crash activation outright (Cordis calls
 * `Config['~standard'].validate`).
 */
export const Config = z === undefined ? undefined : buildConfig(z)

/**
 * Encode a value as the JSON string a settings field can carry.
 * @param {unknown} value - the value to encode.
 * @returns {string} its JSON encoding, `undefined` folded to `null`.
 */
function jsonOf(value) {
  return value === undefined ? 'null' : JSON.stringify(value, (_key, entry) => (entry === undefined ? null : entry))
}

/**
 * Expand `~`, then resolve the result, so relative input always yields absolute paths.
 * @param {string} base - base directory for relative input.
 * @param {string} path - directory from config or a request.
 * @returns {string} an absolute directory path.
 */
function expandDirectory(base, path) {
  const value = String(path ?? '').trim()
  const home = homedir()
  const absolute = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
  return resolvePath(base, absolute.length === 0 ? join(home, 'dsh-model-key-sync') : absolute)
}

/**
 * Replace every character a file name may not carry on macOS or Windows.
 * @param {string} value - candidate segment.
 * @returns {string} a filesystem-safe segment.
 */
function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '_').slice(0, 80) || 'provider'
}

/**
 * A sortable local-time stamp for file names.
 * @param {Date} date - the moment to stamp.
 * @returns {string} `20261017-221530`.
 */
function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Whether a value is a plain JSON object.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep clone JSON-like data.
 * @template T
 * @param {T} value - source value.
 * @returns {T} a clone that shares nothing with the source.
 */
function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

/**
 * Require a non-empty string, trimmed.
 * @param {unknown} value - candidate.
 * @param {string} label - name used in the error.
 * @returns {string} the trimmed value.
 */
function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

/**
 * Require an http(s) URL.
 * @param {unknown} value - candidate.
 * @param {string} label - name used in the error.
 * @returns {string} the trimmed URL.
 */
function requiredURL(value, label) {
  const url = requiredString(value, label)
  if (!/^https?:\/\//i.test(url)) throw new Error(`${label} must start with http:// or https://`)
  return url
}

/**
 * The credential reference the Models page derives for a route that names none.
 * Export and restore both use this, so a snapshot round-trips unchanged: a
 * restored route exports exactly the record it was restored from.
 * @param {string} route - provider route id.
 * @returns {string} the reference name, e.g. `ACME_API_KEY`.
 */
function derivedKeyRef(route) {
  return `${String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Normalize one reasoning-efforts table. Keys must be known levels and values
 * a string (the spelling sent to the provider) or null (sent as absent).
 * @param {unknown} value - candidate table or `false`.
 * @param {string} route - provider route named in the error.
 * @returns {Record<string, string | null> | false | undefined} a usable table.
 */
function effortsOf(value, route) {
  if (value === undefined || value === null) return undefined
  if (value === false) return false
  if (!isRecord(value)) throw new Error(`provider "${route}": reasoningEfforts must be an object or false`)
  if (Object.keys(value).length === 0) return undefined
  const table = {}
  for (const [level, spelling] of Object.entries(value)) {
    if (!EFFORT_KEYS.includes(level)) {
      throw new Error(`provider "${route}": reasoningEfforts key "${level}" is not one of ${EFFORT_KEYS.join(', ')}`)
    }
    if (spelling === null) table[level] = null
    else if (typeof spelling === 'string' && spelling.length > 0) table[level] = spelling
    else throw new Error(`provider "${route}": reasoningEfforts."${level}" must be a non-empty string or null`)
  }
  return table
}

/**
 * Normalize modalities to the ones the adapter knows.
 * @param {unknown} value - candidate list.
 * @returns {string[] | undefined} deduplicated modalities, or undefined.
 */
function modalitiesOf(value) {
  if (!Array.isArray(value)) return undefined
  const kept = [...new Set(value.filter((modality) => modality === 'text' || modality === 'image'))]
  return kept.length === 0 ? undefined : kept
}

/**
 * Normalize the model catalog of one route.
 * Unknown per-model fields are dropped so a hand-edited file cannot smuggle a
 * field the adapter would refuse, while a missing id is a hard error.
 * @param {unknown} models - candidate model rows.
 * @param {string} route - provider route named in the error.
 * @returns {Array<Record<string, unknown>>} normalized rows.
 */
function modelsOf(models, route) {
  if (!Array.isArray(models) || models.length === 0) throw new Error(`provider "${route}": a custom route needs at least one model`)
  const rows = []
  const seen = new Set()
  for (const entry of models) {
    if (!isRecord(entry)) throw new Error(`provider "${route}": every model must be an object`)
    const id = requiredString(entry.id, `provider "${route}" model id`)
    if (seen.has(id)) throw new Error(`provider "${route}": model id "${id}" appears twice`)
    seen.add(id)
    const row = { id }
    if (typeof entry.name === 'string' && entry.name.length > 0) row.name = entry.name
    if (Number.isInteger(entry.contextWindow) && entry.contextWindow > 0) row.contextWindow = entry.contextWindow
    if (Number.isInteger(entry.maxTokens) && entry.maxTokens > 0) row.maxTokens = entry.maxTokens
    const input = modalitiesOf(entry.input)
    if (input !== undefined) row.input = input
    const efforts = effortsOf(entry.reasoningEfforts, route)
    if (efforts !== undefined) row.reasoningEfforts = efforts
    if (isRecord(entry.compat)) row.compat = clone(entry.compat)
    rows.push(row)
  }
  return rows
}

/**
 * Build the provider profile this page owns from a snapshot record and the
 * route's current profile. Owned fields are replaced; the rest survives.
 * @param {unknown} current - live profile of the route, if it is configured.
 * @param {Record<string, unknown>} incoming - the snapshot record.
 * @returns {Record<string, unknown>} the merged profile.
 */
function profileOf(current, incoming) {
  const route = requiredString(incoming.provider, 'provider')
  const base = isRecord(current) ? clone(current) : {}
  for (const field of ROUTE_FIELDS) delete base[field]
  const profile = { ...base }
  profile.displayName = typeof incoming.displayName === 'string' && incoming.displayName.trim().length > 0
    ? incoming.displayName.trim()
    : route
  profile.api = incoming.api === undefined || incoming.api === null || incoming.api === '' ? 'openai-completions' : String(incoming.api)
  if (!PROTOCOLS.includes(profile.api)) {
    throw new Error(`provider "${route}": api "${profile.api}" is not one of ${PROTOCOLS.join(', ')}`)
  }
  profile.baseURL = requiredURL(incoming.baseURL, `provider "${route}" baseURL`)
  profile.models = modelsOf(incoming.models, route)
  // Provider-level values travel with the route. A record that predates them
  // leaves the current values in place instead of deleting them.
  for (const field of PROVIDER_FIELDS) {
    if (incoming[field] !== undefined) profile[field] = clone(incoming[field])
  }
  // The credential is carried by reference only. An explicit name wins; an
  // existing reference on the route is kept as-is; otherwise derive the name
  // the Models page derives for a new provider.
  if (typeof incoming.apiKeyEnv === 'string' && incoming.apiKeyEnv.trim().length > 0) {
    profile.apiKeyEnv = incoming.apiKeyEnv.trim()
  } else if (typeof profile.apiKeyEnv !== 'string' || profile.apiKeyEnv.length === 0) {
    profile.apiKeyEnv = derivedKeyRef(route)
  }
  if (incoming.includeHeaders !== true) return profile
  if (isRecord(incoming.headers)) {
    const headers = {}
    for (const [header, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string' && value.length > 0) headers[header] = value
    }
    if (Object.keys(headers).length > 0) profile.headers = headers
  }
  return profile
}

/**
 * Describe one live route as a snapshot record.
 * @param {string} route - provider route id.
 * @param {Record<string, unknown>} profile - live profile of that route.
 * @param {boolean} includeHeaders - copy deployment headers too.
 * @returns {Record<string, unknown>} the snapshot record.
 */
function recordOf(route, profile, includeHeaders) {
  const record = {
    provider: route,
    displayName: typeof profile.displayName === 'string' ? profile.displayName : route,
    api: typeof profile.api === 'string' ? profile.api : 'openai-completions',
    baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : '',
    models: Array.isArray(profile.models) ? clone(profile.models).map((model) => {
      const kept = {}
      for (const field of MODEL_FIELDS) if (model?.[field] !== undefined) kept[field] = clone(model[field])
      return kept
    }) : [],
  }
  record.apiKeyEnv = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
    ? profile.apiKeyEnv
    : derivedKeyRef(route)
  for (const field of PROVIDER_FIELDS) {
    if (profile[field] !== undefined) record[field] = clone(profile[field])
  }
  if (includeHeaders && isRecord(profile.headers)) {
    const headers = {}
    for (const [header, value] of Object.entries(profile.headers)) {
      if (!SENSITIVE_HEADER.test(header) && typeof value === 'string') headers[header] = value
    }
    if (Object.keys(headers).length > 0) record.headers = headers
  }
  return record
}

/**
 * Name the first value a JSON document cannot carry losslessly.
 * @param {unknown} value - candidate data.
 * @param {string} [path] - JSON path accumulated so far.
 * @returns {string | undefined} the offending path, if any.
 */
function nonJsonPath(value, path = '') {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return path || '<root>'
  if (typeof value === 'number' && !Number.isFinite(value)) return path || '<root>'
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = nonJsonPath(value[index], `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const found = nonJsonPath(entry, `${path}.${key}`)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Resolve the settings namespace this plugin writes to.
 * @param {{ describe: Function }} settings - the settings service.
 * @param {{ llmEntryId?: string }} config - plugin Config.
 * @returns {string} the namespace (profile entry id).
 */
function namespaceOf(settings, config) {
  // `config` is the schemastery row, whose fields are live refs (`{ get() }`)
  // rather than plain strings; unwrapping here is what lets every caller pass
  // `this.config` and still get the entry id the profile actually uses.
  const raw = config?.llmEntryId
  const entryId = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  const ns = String(entryId ?? 'llm-pi-ai')
  const served = settings.describe()
  if (!served.some((entry) => String(entry.ns) === ns)) {
    throw new Error(`settings namespace "${ns}" is not served here; set this plugin's config.llmEntryId to the profile entry id of the llm-pi-ai row`)
  }
  return ns
}

/**
 * Read the live provider map of a namespace (never holding secrets).
 * @param {{ describe: Function }} settings - the settings service.
 * @param {string} ns - settings namespace.
 * @returns {{ providers: Record<string, Record<string, unknown>>, revision: number }}
 */
function liveProviders(settings, ns) {
  const entry = settings.describe({ redactSecrets: true }).find((row) => String(row.ns) === ns)
  if (entry === undefined) throw new Error(`settings namespace "${ns}" disappeared while it was being read`)
  const value = isRecord(entry.value) ? entry.value : {}
  return { providers: isRecord(value.providers) ? clone(value.providers) : {}, revision: entry.revision }
}

/**
 * Persist a complete provider map through the settings seam and read it back.
 * @param {{ describe: Function, update: Function }} settings - the settings service.
 * @param {string} ns - settings namespace.
 * @param {Record<string, unknown>} providers - the next provider map.
 * @param {number | undefined} revision - revision the edit was derived from.
 * @returns {Promise<{ providers: Record<string, unknown>, revision: number }>} committed state.
 */
async function commitProviders(settings, ns, providers, revision) {
  const offending = nonJsonPath(providers)
  if (offending !== undefined) throw new Error(`configuration is not plain JSON at ${offending}`)
  if (typeof settings.update !== 'function') throw new Error('this settings service has no update()')
  await settings.update(ns, { providers }, revision ?? undefined)
  return liveProviders(settings, ns)
}

/**
 * Service the Client half reaches through `ctx.dynamicCordisRunner`, i.e. the
 * plugin's Package-private Host RPC (`host.call(method, args)`).
 */
class ModelSyncService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
   * @param {Record<string, unknown>} config - resolved row Config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.cachedNamespace = undefined
    this.lastCommandId = undefined
    this.cloud = new CloudSync({
      settings: async () => ({ ...this.rawConfig(), ...this.cloudFields() }),
      collect: async () => {
        const exported = this.exportConfig()
        const byRoute = {}
        for (const route of exported.routes) byRoute[String(route.provider)] = route
        return byRoute
      },
      apply: async (request) => this.importRoutes(request),
      collectKeys: async () => this.collectKeys(),
      applyKeys: async (keys) => this.applyKeys(keys),
      stateDirectory: async () => this.stateDirectory(),
    })
  }

  /**
   * The row Config, unwrapped from schemastery's live references.
   * @returns {Record<string, unknown>} plain configuration values.
   */
  rawConfig() {
    const out = {}
    for (const [key, value] of Object.entries(this.config ?? {})) {
      out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
    }
    return out
  }

  /**
   * The settings namespace this plugin owns.
   *
   * The Loader registers the row as `include:<patch id>`, while the settings
   * service addresses it by the patch id — the same split `llm-pi-ai` shows. It
   * is discovered rather than assumed so a renamed row still works.
   * @returns {string | undefined} the namespace, when the Host serves it.
   */
  settingsNamespace() {
    if (this.cachedNamespace !== undefined) return this.cachedNamespace
    try {
      const found = this.settings().describe()
        .map((entry) => String(entry.ns))
        .find((ns) => ns === 'model-key-sync' || ns.endsWith(':model-key-sync') || ns === 'model-sync' || ns.endsWith(':model-sync'))
      if (found !== undefined) this.cachedNamespace = found
      return found
    } catch {
      return undefined
    }
  }

  /**
   * The configuration actually in force: the row's patch config with the
   * settings document layered on top, secrets included.
   *
   * Volatile settings never remount the plugin, so reading only the constructor
   * argument would freeze every cloud field at the value it had at startup.
   * @returns {Record<string, unknown>} the live configuration.
   */
  liveConfig() {
    const base = this.rawConfig()
    const ns = this.settingsNamespace()
    if (ns === undefined) return base
    try {
      const settings = this.settings()
      let rows
      try {
        rows = settings.describe({ redactSecrets: false })
      } catch {
        rows = settings.describe()
      }
      const row = rows.find((entry) => String(entry.ns) === ns)
      if (!isRecord(row?.value)) return base
      // Only keys the page actually set override the row: the settings document
      // is seeded from the schema defaults, and an empty string there must not
      // erase a value the profile's patch row configured.
      const live = { ...base }
      for (const [key, value] of Object.entries(row.value)) {
        if (value === undefined || value === null) continue
        if (typeof value === 'string' && value === '' && base[key] !== undefined) continue
        live[key] = value
      }
      return live
    } catch {
      return base
    }
  }

  /**
   * Cloud configuration, from the patch row and the environment.
   * @returns {Record<string, unknown>} cloud fields, secrets included.
   */
  cloudFields() {
    const raw = this.liveConfig()
    const out = {}
    for (const field of [...CLOUD_FIELDS, ...SECRET_FIELDS]) {
      if (raw[field] !== undefined) out[field] = raw[field]
    }
    return out
  }

  /**
   * Where per-installation sync state lives.
   * @returns {Promise<string>} a directory inside the DSH home.
   */
  async stateDirectory() {
    const home = String(process.env.DSH_PROFILE_DIR ?? '').trim()
    const base = home.length > 0 ? resolvePath(home, '..') : join(homedir(), '.dsh')
    return join(base, 'model-key-sync')
  }

  /**
   * The settings service, or an actionable error.
   * @returns {any} the mounted settings service.
   */
  settings() {
    const settings = this.ctx.get('settings')
    if (settings === undefined) throw new Error('the settings service is not mounted in this profile')
    return settings
  }

  /**
   * The llm service, when one is mounted (used for its provider directory).
   * @returns {any | undefined} the llm service.
   */
  llm() {
    return this.ctx.get('llm')
  }

  /**
   * Options the Client renders, without secrets.
   * @returns {{ llmEntryId: string, syncDirectory: string, keepPerProvider: number, includeHeaders: boolean }} options.
   */
  options() {
    const raw = this.rawConfig()
    const cloud = this.cloudFields()
    return {
      llmEntryId: String(raw.llmEntryId ?? 'llm-pi-ai'),
      syncDirectory: String(raw.syncDirectory ?? '~/dsh-model-key-sync'),
      keepPerProvider: Number(raw.keepPerProvider ?? 20),
      includeHeaders: raw.includeHeaders === true,
      cloud: {
        backend: String(cloud.backend ?? ''),
        remoteRoot: String(cloud.remoteRoot ?? 'dsh-model-key-sync'),
        profile: String(cloud.profile ?? 'default'),
        s3Bucket: String(cloud.s3Bucket ?? ''),
        s3Region: String(cloud.s3Region ?? 'auto'),
        s3Endpoint: String(cloud.s3Endpoint ?? ''),
        webdavBaseURL: String(cloud.webdavBaseURL ?? ''),
        webdavUsername: String(cloud.webdavUsername ?? ''),
        // Presence only: the values themselves never leave the Host.
        s3SecretConfigured: credentialOf({ literal: cloud.s3SecretAccessKey, slot: cloud.s3SecretAccessKeyEnv }).length > 0,
        webdavPasswordConfigured: credentialOf({ literal: cloud.webdavPassword, slot: cloud.webdavPasswordEnv }).length > 0,
      },
    }
  }

  /**
   * Perform one action named by the page and publish the outcome.
   *
   * This is the whole Client→Host channel. A profile-installed bundle cannot
   * declare a Remote namespace — that needs generated Typert artifacts — so the
   * page writes a JSON command into this plugin's own settings namespace and
   * the Host answers by writing `status` back. The page's settings mirror
   * refreshes from the pushed `settings/document-updated` event, so no polling
   * is involved.
   * @param {Record<string, unknown>} command - the posted command.
   * @returns {Promise<Record<string, unknown>>} the published status.
   */
  async runCommand(command) {
    const kind = String(command.kind ?? '')
    const id = String(command.id ?? '')
    const started = Date.now()
    let status
    try {
      if (kind === 'push') {
        const outcome = await this.cloudPush({ force: command.force === true })
        status = { id, kind, ok: true, at: new Date().toISOString(), message: outcome.status, detail: jsonOf({ routes: outcome.routes, snapshotId: outcome.snapshotId, remotePath: outcome.remotePath }) }
      } else if (kind === 'pull') {
        const outcome = await this.cloudPull({
          force: command.force === true,
          replaceAll: command.replaceAll === true,
          ...(typeof command.route === 'string' && command.route.length > 0 ? { route: command.route } : {}),
        })
        status = { id, kind, ok: true, at: new Date().toISOString(), message: outcome.status, detail: jsonOf({ created: outcome.created ?? [], updated: outcome.updated ?? [], credentials: outcome.credentials ?? [], snapshotId: outcome.snapshotId, deviceName: outcome.deviceName, remotePath: outcome.remotePath }) }
      } else if (kind === 'test') {
        const outcome = await this.cloudTest()
        status = { id, kind, ok: outcome.ok === true, at: new Date().toISOString(), message: String(outcome.detail ?? 'ok'), detail: jsonOf({ location: outcome.location, remotePath: outcome.remotePath }) }
      } else if (kind === 'status') {
        const exported = this.exportConfig()
        const state = await this.cloudState()
        const cloud = this.cloudFields()
        const keys = await this.collectKeys()
        status = { id, kind, ok: true, at: new Date().toISOString(), message: 'ok', detail: jsonOf({ credentials: Object.keys(keys).sort(), syncCredentials: this.liveConfig().syncCredentials !== false, routes: exported.routes.map((entry) => String(entry.provider)), models: exported.routes.reduce((total, route) => total + (Array.isArray(route.models) ? route.models.length : 0), 0), backend: String(cloud.backend ?? ''), remoteRoot: String(cloud.remoteRoot ?? ''), profile: String(cloud.profile ?? ''), lastSyncAt: state.lastSyncAt, snapshotId: state.snapshotId, s3SecretConfigured: this.options().cloud.s3SecretConfigured, webdavPasswordConfigured: this.options().cloud.webdavPasswordConfigured }) }
      } else if (kind === 'export') {
        const text = await this.exportText()
        status = { id, kind, ok: true, at: new Date().toISOString(), message: `${text.routes} route(s)`, detail: jsonOf({ document: text.text }) }
      } else {
        throw new Error(`unknown action "${kind}"`)
      }
    } catch (error) {
      status = { id, kind, ok: false, at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error), detail: jsonOf({ code: isRecord(error) && typeof error.code === 'string' ? error.code : undefined }) }
    }
    await this.publishStatus(status)
    return status
  }

  /**
   * Write the outcome into the settings namespace and clear the command.
   * @param {Record<string, unknown>} status - the outcome.
   * @returns {Promise<void>} settlement.
   */
  async publishStatus(status) {
    const ns = this.settingsNamespace()
    if (ns === undefined) return
    const settings = this.settings()
    const encoded = JSON.stringify(status)
    // A stale `expectedRevision` would reject the write, and the page would then
    // sit on "working…" forever even though the action itself succeeded. Retry
    // without the precondition, then once more after a beat: the status field is
    // written by this plugin alone, so a lost update is not a concern here while
    // a permanently stuck spinner is.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const row = settings.describe().find((entry) => String(entry.ns) === ns)
        await settings.update(ns, { command: '', status: encoded }, attempt === 0 ? row?.revision : undefined)
        return
      } catch (error) {
        if (attempt === 2) {
          this.ctx.logger?.warn?.('model-sync: could not publish status: %s', error instanceof Error ? error.message : String(error))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }

  /**
   * Act on a command the page posted, exactly once.
   * @returns {Promise<void>} settlement.
   */
  async consumeCommand() {
    const raw = this.liveConfig().command
    if (typeof raw !== 'string' || raw.length === 0) return
    let command
    try {
      command = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(command) || typeof command.id !== 'string' || command.id.length === 0) return
    if (command.id === this.lastCommandId) return
    this.lastCommandId = command.id
    await this.runCommand(command)
  }

  /**
   * Read the sync state this installation recorded after its last transfer.
   * @returns {Promise<Record<string, unknown>>} the stored state.
   */
  async cloudState() {
    return this.cloud.state()
  }

  /**
   * What the remote holds right now, without downloading the payload.
   * @returns {Promise<Record<string, unknown>>} the remote summary.
   */
  async cloudInfo() {
    return this.cloud.info()
  }

  /**
   * The API keys behind the configured routes, for upload.
   *
   * Read through `ctx.credentials.resolve`, the same seam the model adapter uses,
   * so the value is whatever that name currently resolves to — a value entered in
   * the settings page, a key stored by the plugin, or an ambient environment
   * variable. A name that resolves to nothing is omitted rather than uploaded
   * empty, because an empty credential is absent by the service's own rule.
   * @returns {Promise<Record<string, string>>} credential name to value.
   */
  async collectKeys() {
    if (this.liveConfig().syncCredentials === false) return {}
    const credentials = this.ctx.get?.('credentials')
    if (credentials === undefined || typeof credentials.resolve !== 'function') return {}
    const providers = liveProviders(this.settings(), namespaceOf(this.settings(), this.config)).providers
    const out = {}
    for (const [route, profile] of Object.entries(providers)) {
      if (!isRecord(profile)) continue
      // The snapshot records a derived name when the profile declares none, so
      // the upload has to look the value up under that same derived name.
      const name = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.trim().length > 0
        ? profile.apiKeyEnv.trim()
        : derivedKeyRef(route)
      if (out[name] !== undefined) continue
      try {
        const resolved = await credentials.resolve(name)
        if (typeof resolved?.value === 'string' && resolved.value.length > 0) out[name] = resolved.value
      } catch {
        // a name this installation cannot resolve is simply not uploaded
      }
    }
    return out
  }

  /**
   * Store pulled API keys.
   *
   * `set` is the provider-managed writable store, which takes precedence over an
   * ambient environment variable. That is what makes a pulled key take effect
   * without a restart: consumers resolve per operation.
   * @param {Record<string, string>} keys - credential name to value.
   * @returns {Promise<string[]>} the names actually written.
   */
  async applyKeys(keys) {
    const credentials = this.ctx.get?.('credentials')
    if (credentials === undefined || typeof credentials.set !== 'function') return []
    const written = []
    for (const [name, value] of Object.entries(keys ?? {})) {
      if (typeof value !== 'string' || value.length === 0) continue
      try {
        await credentials.set(name, value)
        written.push(name)
      } catch (error) {
        this.ctx.logger?.warn?.('model-sync: could not store credential %s: %s', name, error instanceof Error ? error.message : String(error))
      }
    }
    return written.sort()
  }

  /**
   * Upload this device's model declarations.
   * @param {{ force?: boolean }} [request] - `force` overwrites a remote that moved.
   * @returns {Promise<Record<string, unknown>>} the outcome.
   */
  async cloudPush(request = {}) {
    const outcome = await this.cloud.push({ force: request.force === true })
    this.ctx.emit?.('model-sync/cloud-synced', { direction: 'push', ...outcome })
    return outcome
  }

  /**
   * Merge the remote snapshot into this profile.
   * @param {{ force?: boolean, replaceAll?: boolean, route?: string }} [request] - pull options.
   * @returns {Promise<Record<string, unknown>>} the outcome.
   */
  async cloudPull(request = {}) {
    const previous = this.suppressAutoSync
    this.suppressAutoSync = true
    let outcome
    try {
      outcome = await this.cloud.pull({
        force: request.force === true,
        replaceAll: request.replaceAll === true,
        ...(typeof request.route === 'string' ? { route: request.route } : {}),
      })
    } finally {
      this.suppressAutoSync = previous
    }
    this.ctx.emit?.('model-sync/cloud-synced', { direction: 'pull', ...outcome })
    return outcome
  }

  /**
   * Probe the configured remote without transferring a snapshot.
   * @returns {Promise<Record<string, unknown>>} the probe result.
   */
  async cloudTest() {
    return this.cloud.test()
  }

  /**
   * Upload after a configuration change, when the page turned auto sync on.
   * Failures are reported to the log and never reach the caller, because the
   * model write itself already succeeded.
   * @param {string} reason - what changed, for the log line.
   * @returns {Promise<void>} settlement.
   */
  async autoSync(reason) {
    const cloud = this.cloudFields()
    if (cloud.autoSync !== true) return
    // A pull writes through the same seam that raises this hook; without the
    // guard, restoring from the cloud would immediately upload what was just
    // downloaded.
    if (this.suppressAutoSync === true) return
    try {
      const outcome = await this.cloud.push({})
      this.ctx.logger?.info?.('model-sync: auto sync after %s pushed %d route(s)', reason, outcome.routes.length)
    } catch (error) {
      this.ctx.logger?.warn?.('model-sync: auto sync after %s failed: %s', reason, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Routes this page owns: hand-declared routes, plus any route whose model
   * catalog, name or endpoint was configured by hand.
   * @returns {string[]} provider route ids, in configuration order.
   */
  customRoutes() {
    const ns = namespaceOf(this.settings(), this.config)
    const live = liveProviders(this.settings(), ns).providers
    const directory = new Map()
    const llm = this.llm()
    if (llm !== undefined && typeof llm.listConfigurableProviders === 'function') {
      for (const entry of llm.listConfigurableProviders()) directory.set(entry.provider, entry)
    }
    return Object.entries(live)
      .filter(([route, profile]) => {
        if (!isRecord(profile)) return false
        const entry = directory.get(route)
        if (entry !== undefined && entry.declared !== true && profile.models === undefined) return false
        // A route that cannot describe itself cannot be restored on another
        // installation, so it is not something this page offers to sync.
        const models = Array.isArray(profile.models) ? profile.models : []
        return models.length > 0 && typeof profile.baseURL === 'string' && /^https?:\/\//i.test(profile.baseURL)
      })
      .map(([route]) => route)
  }

  /**
   * Everything this page can export, as plain data.
   * @param {{ route?: string }} [request] - optional single-route narrowing.
   * @returns {{ routes: Array<Record<string, unknown>>, revision: number, options: ReturnType<ModelSyncService['options']> }}
   */
  exportConfig(request = {}) {
    const includeHeaders = this.config.includeHeaders === true
    const ns = namespaceOf(this.settings(), this.config)
    const live = liveProviders(this.settings(), ns)
    const wanted = request.route === undefined ? this.customRoutes() : [requiredString(request.route, 'route')]
    const routes = []
    for (const route of wanted) {
      const profile = live.providers[route]
      if (profile === undefined) throw new Error(`provider "${route}" is not configured in this profile`)
      routes.push(recordOf(route, profile, includeHeaders))
    }
    return { routes, revision: live.revision, options: this.options() }
  }

  /**
   * Restore route records into the live profile.
   * @param {{ routes?: unknown, replaceAll?: boolean }} request - records to restore.
   * @param {(reason: string) => Promise<void>} [commit] - runs after a successful write.
   * @returns {Promise<{ providers: Record<string, unknown>, revision: number, created: string[], updated: string[] }>}
   */
  async importRoutes(request = {}, commit) {
    const routes = Array.isArray(request.routes) ? request.routes : []
    if (routes.length === 0) throw new Error('nothing to restore: the payload contains no provider routes')
    const settings = this.settings()
    const ns = namespaceOf(settings, this.config)
    const live = liveProviders(settings, ns)
    const includeHeaders = this.config.includeHeaders === true
    const next = request.replaceAll === true ? {} : clone(live.providers)
    const created = []
    const updated = []
    for (const incoming of routes) {
      if (!isRecord(incoming)) throw new Error('every provider route must be an object')
      const route = requiredString(incoming.provider, 'provider')
      // A format marker from a JSON file rides along; it is not a profile field.
      const record = { ...incoming, includeHeaders }
      next[route] = profileOf(next[route], record)
      if (live.providers[route] === undefined) created.push(route)
      else updated.push(route)
    }
    const committed = await commitProviders(settings, ns, next, live.revision)
    if (typeof commit === 'function') await commit('import')
    return { ...committed, created, updated }
  }

  /**
   * Rename a route's display name or endpoint without touching its catalog.
   * @param {{ provider?: unknown, displayName?: unknown, baseURL?: unknown }} request - the edit.
   * @param {(reason: string) => Promise<void>} [commit] - runs after a successful write.
   * @returns {Promise<Record<string, unknown>>} the committed profile.
   */
  async renameRoute(request = {}, commit) {
    const route = requiredString(request.provider, 'provider')
    const settings = this.settings()
    const ns = namespaceOf(settings, this.config)
    const live = liveProviders(settings, ns)
    const current = live.providers[route]
    if (current === undefined) throw new Error(`provider "${route}" is not configured in this profile`)
    const profile = clone(current)
    if (request.displayName !== undefined) profile.displayName = requiredString(request.displayName, 'displayName')
    if (request.baseURL !== undefined) profile.baseURL = requiredURL(request.baseURL, 'baseURL')
    const next = clone(live.providers)
    next[route] = profile
    await commitProviders(settings, ns, next, live.revision)
    if (typeof commit === 'function') await commit('rename')
    return profile
  }

  /**
   * Delete routes from the live profile. Deleting is always explicit: nothing
   * in this plugin removes a provider as a side effect of some other action.
   * @param {{ providers?: unknown }} request - route ids to delete.
   * @param {(reason: string) => Promise<void>} [commit] - runs after a successful write.
   * @returns {Promise<{ providers: Record<string, unknown>, revision: number, removed: string[], missing: string[] }>}
   */
  async removeRoutes(request = {}, commit) {
    const wanted = Array.isArray(request.providers) ? request.providers.map((route) => requiredString(route, 'provider')) : []
    if (wanted.length === 0) throw new Error('nothing to remove: no provider route was named')
    const settings = this.settings()
    const ns = namespaceOf(settings, this.config)
    const live = liveProviders(settings, ns)
    const next = clone(live.providers)
    const removed = []
    const missing = []
    for (const route of wanted) {
      if (next[route] === undefined) missing.push(route)
      else {
        delete next[route]
        removed.push(route)
      }
    }
    if (removed.length === 0) return { ...live, removed, missing }
    const committed = await commitProviders(settings, ns, next, live.revision)
    if (typeof commit === 'function') await commit('remove')
    return { ...committed, removed, missing }
  }

  /**
   * The sync directory as an absolute path.
   * @returns {string} the directory.
   */
  directory() {
    const base = String(this.ctx.get('workingDirectory')?.defaultDirectory ?? homedir())
    return expandDirectory(base, this.config.syncDirectory)
  }

  /**
   * Write one JSON file per route into the sync directory and prune old files.
   * @param {{ route?: string }} [request] - optional single-route narrowing.
   * @returns {Promise<{ directory: string, files: string[], routes: string[] }>} what was written.
   */
  async saveToDirectory(request = {}) {
    const exported = this.exportConfig(request)
    if (exported.routes.length === 0) throw new Error('there is no custom model route to save yet')
    const directory = this.directory()
    await mkdir(directory, { recursive: true })
    const now = new Date()
    const files = []
    for (const route of exported.routes) {
      const provider = String(route.provider)
      const path = join(directory, `${stamp(now)}-${safeSegment(provider)}.json`)
      const document = {
        format: FILE_FORMAT,
        version: FILE_VERSION,
        savedAt: now.toISOString(),
        entryId: namespaceOf(this.settings(), this.config),
        routes: [route],
      }
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      files.push(path)
      await this.prune(provider, directory)
    }
    return { directory, files, routes: exported.routes.map((route) => String(route.provider)) }
  }

  /**
   * Delete the oldest snapshots of one route beyond `keepPerProvider`.
   * @param {string} route - provider route id.
   * @param {string} directory - snapshot directory.
   * @returns {Promise<void>} settlement.
   */
  async prune(route, directory) {
    const keep = Number(this.config.keepPerProvider ?? 20)
    const limit = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 1
    const suffix = `-${safeSegment(route)}.json`
    let names
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(suffix)).sort()
    } catch {
      return
    }
    for (const name of names.slice(0, Math.max(0, names.length - limit))) {
      await unlink(join(directory, name)).catch(() => {})
    }
  }

  /**
   * List snapshot files, newest first, with what each one carries.
   * @param {{ directory?: string }} [request] - optional explicit directory.
   * @returns {Promise<{ directory: string, files: Array<Record<string, unknown>> }>} the listing.
   */
  async listFiles(request = {}) {
    const directory = request.directory === undefined
      ? this.directory()
      : expandDirectory(homedir(), requiredString(request.directory, 'directory'))
    let names
    try {
      names = await readdir(directory)
    } catch {
      return { directory, files: [] }
    }
    const files = []
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const path = join(directory, name)
      const file = { name, path }
      try {
        const document = JSON.parse(await readFile(path, 'utf8'))
        if (READABLE_FORMATS.includes(document?.format)) {
          const route = Array.isArray(document.routes) ? document.routes[0] : undefined
          file.format = document.format
          file.route = route?.provider
          file.displayName = route?.displayName
          file.baseURL = route?.baseURL
          file.api = route?.api
          file.savedAt = document.savedAt
          file.models = Array.isArray(route?.models) ? route.models.length : 0
        }
      } catch {
        // A damaged file still lists; restoring it reports why it cannot be used.
      }
      files.push(file)
    }
    files.sort((left, right) => String(right.savedAt ?? right.name).localeCompare(String(left.savedAt ?? left.name)))
    return { directory, files }
  }

  /**
   * Restore one snapshot file, or an inline document from the page.
   * @param {{ path?: unknown, document?: unknown, replaceAll?: boolean }} request - source and mode.
   * @returns {Promise<Record<string, unknown>>} the restore outcome.
   */
  async restore(request = {}) {
    let document = request.document
    let source
    if (document === undefined || document === null) {
      const path = expandDirectory(homedir(), requiredString(request.path, 'path'))
      try {
        document = JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
      source = path
    }
    if (!isRecord(document)) throw new Error('the snapshot is not a JSON object')
    if (document.format !== undefined && !READABLE_FORMATS.includes(document.format)) {
      throw new Error(`the snapshot format is "${String(document.format)}", not "${FILE_FORMAT}"`)
    }
    const routes = Array.isArray(document.routes)
      ? document.routes
      : (document.provider === undefined ? [] : [document])
    if (routes.length === 0) throw new Error('the snapshot contains no provider routes')
    const outcome = await this.importRoutes({ routes, replaceAll: request.replaceAll === true })
    return { ...outcome, source }
  }

  /**
   * Where the Agent's default model selection lives, when the row that owns it
   * is served here. Deleting or renaming the route it points at would leave a
   * selection that no longer resolves, so the page needs to know about it.
   * @returns {Promise<{ namespace?: string, provider?: string, model?: string, reasoningEffort?: string }>} the selection.
   */
  async defaultModel() {
    const settings = this.settings()
    const served = settings.describe({ redactSecrets: true })
    const row = served.find((entry) => String(entry.ns) === 'agent-default-model')
    if (row === undefined) return {}
    const value = isRecord(row.value) ? row.value : {}
    return {
      namespace: 'agent-default-model',
      ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
    }
  }

  /**
   * Show a file the plugin wrote in the desktop file manager. This is a
   * convenience only: every caller treats a refusal as "no reveal available"
   * and the path stays readable in the page.
   * @param {{ path?: unknown }} request - file or directory to reveal.
   * @returns {Promise<{ revealed: boolean, reason?: string }>} the outcome.
   */
  async reveal(request = {}) {
    const path = expandDirectory(homedir(), requiredString(request.path, 'path'))
    const candidates = ['shell', 'electron', 'hostShell']
    for (const name of candidates) {
      const service = this.ctx.get(name)
      if (service === undefined || typeof service.showItemInFolder !== 'function') continue
      try {
        service.showItemInFolder(path)
        return { revealed: true }
      } catch (error) {
        return { revealed: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    return { revealed: false, reason: 'no file manager bridge is mounted in this profile' }
  }

  /**
   * A paste-ready JSON document for every route, without writing a file.
   * @param {{ route?: string }} [request] - optional single-route narrowing.
   * @returns {Promise<{ text: string, routes: string[] }>} the document text.
   */
  async exportText(request = {}) {
    const exported = this.exportConfig(request)
    const document = {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      savedAt: new Date().toISOString(),
      entryId: namespaceOf(this.settings(), this.config),
      routes: exported.routes,
    }
    return { text: `${JSON.stringify(document, null, 2)}\n`, routes: exported.routes.map((route) => String(route.provider)) }
  }
}

/**
 * Provide the service and, for an unconfigured page, expose nothing else.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Record<string, unknown>} config - row Config.
 */
/** Host services this plugin needs before `apply` runs. */
export const inject = ['tools', 'settings']

export function apply(ctx, config) {
  const service = new ModelSyncService(ctx, config ?? {})
  service.writeHook = (reason) => service.autoSync(reason)
  ctx.provide('modelSync', service)
  ctx.effect(() => ctx.tools.register(modelSyncTool(service)), 'model-sync: agent tool')

  // The settings page writes a command and waits for the status it provokes.
  ctx.effect(() => {
    const stop = ctx.on('settings/document-updated', (ns) => {
      const own = service.settingsNamespace()
      if (own === undefined || String(ns) !== own) return
      // `settings/document-updated` is emitted from inside the settings editor's
      // HMR transaction. Writing `status` back synchronously would nest a second
      // transaction ("HMR transactions cannot be nested"), and an async hop does
      // not escape it either because the transaction is tracked with
      // AsyncLocalStorage. Leave that context explicitly before consuming.
      const run = () => service.consumeCommand().catch((error) => {
        ctx.logger?.warn?.('model-sync: command failed: %s', error instanceof Error ? error.message : String(error))
      })
      const hmr = ctx.get('hmr')
      if (hmr?.executing !== undefined) hmr.executing.exit(run)
      else setTimeout(run, 0)
    })
    return () => {
      if (typeof stop === 'function') stop()
    }
  }, 'model-sync: settings command channel')
}

/**
 * Deep-copy a value, dropping every `undefined` member.
 *
 * Tool results must be lossless JSON; a property whose value is `undefined`
 * survives in the object but not across the boundary, so the runtime rejects
 * the whole result. Several details here are legitimately absent (a first-run
 * install has no recorded sync state at all), so absence is projected as
 * omission rather than as an undefined-valued key.
 * @param {unknown} value - the value to project.
 * @returns {unknown} the JSON-safe projection.
 */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(jsonSafe).filter((entry) => entry !== undefined)
  if (value instanceof Date) return value.toISOString()
  if (isRecord(value)) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      const projected = jsonSafe(entry)
      if (projected !== undefined) out[key] = projected
    }
    return out
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined
  return value
}

/**
 * Render a tool result as text: one summary line, then the structured detail.
 *
 * The detail is what makes the tool useful to an agent — `export` exists to
 * hand over the document — so it travels in the rendered text rather than in a
 * value the model never sees.
 * @param {Record<string, unknown>} value - the tool result.
 * @returns {string} the rendered text.
 */
function renderText(value) {
  const result = isRecord(value) ? value : {}
  const summary = result.ok === true
    ? `model_key_sync ${String(result.action ?? '')}: ${String(result.message ?? 'ok')}`
    : `model_key_sync ${String(result.action ?? '')} failed: ${String(result.message ?? 'unknown error')}`
  const detail = result.detail
  if (!isRecord(detail) || Object.keys(detail).length === 0) return summary
  const text = JSON.stringify(detail, null, 2)
  return `${summary}\n\n${text.length > 24_000 ? `${text.slice(0, 24_000)}\n… (truncated)` : text}`
}

/**
 * The agent-facing `model_key_sync` tool.
 *
 * This is how cloud sync is triggered. A bundle installed from a directory
 * cannot declare a Remote namespace (that needs generated Typert artifacts) and
 * cannot declare a schemastery `Config` (it cannot import schemastery), so a
 * page cannot call into this Host service. Tools are the supported extension
 * point, and they also keep the S3/WebDAV transfers in Node, where no CORS
 * policy applies and no credential is ever handed to the browser.
 * @param {ModelSyncService} service - the Host service.
 * @returns {Record<string, unknown>} a plain tool definition accepted by `ctx.tools.register`.
 */
function modelSyncTool(service) {
  const parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'export', 'cloud_test', 'cloud_push', 'cloud_pull'],
        description: 'status reads the profile and the last sync record; export returns the JSON snapshot; cloud_test probes the configured remote; cloud_push uploads; cloud_pull merges the remote into this profile.',
      },
      route: {
        type: 'string',
        description: 'cloud_pull only: restore just this provider route id.',
      },
      force: {
        type: 'boolean',
        description: 'cloud_push/cloud_pull only: proceed even though the other side moved since the last sync. Without it a conflict is reported instead of overwriting.',
      },
      replace_all: {
        type: 'boolean',
        description: 'cloud_pull only: replace the whole provider map instead of merging route by route.',
      },
    },
  }
  const output = {
    schema: {
      type: 'object',
      additionalProperties: true,
      required: ['ok', 'action'],
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        message: { type: 'string' },
        detail: { type: 'object' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: renderText(value) }]
    },
  }
  return {
    name: 'model_key_sync',
    description: 'Export and restore this profile\'s custom model declarations, and sync them through an S3-compatible bucket or a WebDAV collection. Actions: status, export, cloud_test, cloud_push, cloud_pull.',
    parameters,
    output,
    async execute(args) {
      const action = String(args?.action ?? '')
      try {
        const detail = await runAction(service, action, args ?? {})
        return jsonSafe({ ok: true, action, message: messageFor(action, detail), detail })
      } catch (error) {
        return jsonSafe({
          ok: false,
          action,
          message: error instanceof Error ? error.message : String(error),
          detail: isRecord(error) && typeof error.code === 'string' ? { code: error.code } : {},
        })
      }
    },
  }
}

/**
 * Run one `model_key_sync` action.
 * @param {ModelSyncService} service - the Host service.
 * @param {string} action - the requested action.
 * @param {Record<string, unknown>} args - tool arguments.
 * @returns {Promise<Record<string, unknown>>} the action detail.
 */
async function runAction(service, action, args) {
  if (action === 'status') {
    const exported = service.exportConfig()
    const state = await service.cloudState()
    const { cloud } = service.options()
    const keys = await service.collectKeys()
    return {
      routes: exported.routes.map((route) => String(route.provider)),
      models: exported.routes.reduce((total, route) => total + (Array.isArray(route.models) ? route.models.length : 0), 0),
      cloud: { backend: cloud.backend, remoteRoot: cloud.remoteRoot, profile: cloud.profile, configured: cloud.backend !== '' },
      credentials: { names: Object.keys(keys).sort(), syncEnabled: service.liveConfig().syncCredentials !== false },
      lastSyncAt: state.lastSyncAt,
      lastDirection: state.lastDirection,
      snapshotId: state.snapshotId,
    }
  }
  if (action === 'export') {
    const exported = await service.exportText()
    return { routes: exported.routes, document: exported.text }
  }
  if (action === 'cloud_test') return service.cloudTest()
  if (action === 'cloud_push') return service.cloudPush({ force: args.force === true })
  if (action === 'cloud_pull') {
    return service.cloudPull({
      force: args.force === true,
      replaceAll: args.replace_all === true,
      ...(typeof args.route === 'string' && args.route.length > 0 ? { route: args.route } : {}),
    })
  }
  throw new Error(`unknown action "${action}"; use status, export, cloud_test, cloud_push or cloud_pull`)
}

/**
 * One-line summary of an action result.
 * @param {string} action - the action that ran.
 * @param {Record<string, unknown>} detail - its detail.
 * @returns {string} the summary.
 */
function messageFor(action, detail) {
  if (action === 'status') {
    const backend = detail.cloud?.backend === ''
      ? 'cloud sync is off'
      : `${String(detail.cloud?.backend ?? '')} ${String(detail.cloud?.remoteRoot ?? '')}/${String(detail.cloud?.profile ?? '')}`
    const keys = Array.isArray(detail.credentials?.names) ? detail.credentials.names : []
    const keyNote = detail.credentials?.syncEnabled === false
      ? 'API keys excluded'
      : `${keys.length} API key(s): ${keys.join(', ') || 'none stored'}`
    return `${detail.routes?.length ?? 0} route(s), ${detail.models ?? 0} model(s), ${keyNote}; ${backend}`
  }
  if (action === 'export') return `${Array.isArray(detail.routes) ? detail.routes.length : 0} route(s) exported`
  if (action === 'cloud_test') return String(detail.detail ?? 'reachable')
  const routes = Array.isArray(detail.routes) ? detail.routes.length : 0
  if (detail.status === 'up-to-date') return 'already up to date'
  if (detail.status === 'pushed') return `pushed ${routes} route(s) to ${String(detail.remotePath ?? '')}`
  if (detail.status === 'pulled') {
    const created = Array.isArray(detail.created) ? detail.created.length : 0
    const updated = Array.isArray(detail.updated) ? detail.updated.length : 0
    return `pulled to ${String(detail.remotePath ?? '')}: ${created} added, ${updated} updated`
  }
  return String(detail.status ?? 'ok')
}


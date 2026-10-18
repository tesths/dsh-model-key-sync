/**
 * Cloud transports for the Model Sync bundle.
 *
 * Two backends cover every service the user asked for, and both speak plain
 * HTTP with no third-party SDK:
 *
 * - `s3` speaks the S3 REST API with SigV4 request signing, which is what AWS
 *   S3, Cloudflare R2, MinIO, Backblaze B2 and Aliyun OSS all accept.
 * - `webdav` speaks WebDAV with Basic auth, which is what Nextcloud, Synology,
 *   Nutstore and a bare nginx `dav_module` all accept.
 *
 * Both expose the same four operations (`put`, `get`, `head`, `mkdir`), so the
 * snapshot layer above them never branches on the backend.
 *
 * @module @local/dsh-model-sync/cloud/transport
 */

import { createHash, createHmac } from 'node:crypto'

/** Request ceiling for one manifest or snapshot object. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** A transfer that received no bytes for this long is treated as stalled. */
const IDLE_TIMEOUT_MS = 120_000

/** Hard ceiling for one request, including the body. */
const TOTAL_TIMEOUT_MS = 300_000

/** SHA-256 of the empty string, the S3 payload hash of a body-less request. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Hex SHA-256 of a string or byte buffer. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Whether an S3 endpoint is the AWS official one, which uses the
 * virtual-hosted-style address instead of path style.
 * @param {string} endpoint - configured endpoint, empty for AWS.
 * @returns {boolean} true for AWS.
 */
function isAwsEndpoint(endpoint) {
  const value = String(endpoint ?? '').trim()
  return value.length === 0 || value.toLowerCase().includes('amazonaws.com')
}

/**
 * Split an endpoint into its scheme and host, accepting a bare host.
 * @param {string} endpoint - configured endpoint.
 * @returns {{ scheme: string, host: string }} the parts.
 */
function splitEndpoint(endpoint) {
  const value = String(endpoint ?? '').trim().replace(/\/+$/, '')
  if (value.startsWith('http://')) return { scheme: 'http', host: value.slice(7) }
  if (value.startsWith('https://')) return { scheme: 'https', host: value.slice(8) }
  return { scheme: 'https', host: value }
}

/** RFC 3986 encoding, keeping `/` when the caller encodes a whole key path. */
function uriEncode(value, keepSlash) {
  let out = ''
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte)
    if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '-' || char === '_' || char === '.' || char === '~' || (keepSlash && char === '/')) {
      out += char
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/** `YYYYMMDDTHHMMSSZ` and `YYYYMMDD` for one instant, in UTC. */
function amzDates(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { long: iso, short: iso.slice(0, 8) }
}

/**
 * Perform one HTTP request with an overall deadline and an idle detector.
 * @param {string} url - absolute URL.
 * @param {object} init - `fetch` init plus `body` bytes.
 * @returns {Promise<{ status: number, headers: Headers, body: Buffer }>} the response.
 */
async function request(url, init) {
  const controller = new AbortController()
  const total = setTimeout(() => controller.abort(new Error('the request timed out')), TOTAL_TIMEOUT_MS)
  let idle = setTimeout(() => controller.abort(new Error('the transfer stalled')), IDLE_TIMEOUT_MS)
  const bump = () => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new Error('the transfer stalled')), IDLE_TIMEOUT_MS)
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    bump()
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new Error(`the response is ${(declared / 1024 / 1024).toFixed(1)} MiB, over the ${MAX_BODY_BYTES / 1024 / 1024} MiB limit`)
    }
    if (response.body === null) return { status: response.status, headers: response.headers, body: Buffer.alloc(0) }
    const chunks = []
    let size = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bump()
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(`the response grew past the ${MAX_BODY_BYTES / 1024 / 1024} MiB limit`)
      }
      chunks.push(Buffer.from(value))
    }
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) }
  } finally {
    clearTimeout(total)
    clearTimeout(idle)
  }
}

/**
 * Name a failed response with the service's own explanation when it has one.
 * @param {string} operation - what was attempted, for the message.
 * @param {{ status: number, body: Buffer }} response - the failed response.
 * @returns {Promise<Error>} the error to throw.
 */
async function failureOf(operation, response) {
  const text = response.body.subarray(0, 2048).toString('utf8').replace(/\s+/g, ' ').trim()
  const hints = {
    400: 'the service rejected the request (check endpoint, region and bucket)',
    401: 'the credentials were refused',
    403: 'the credentials were refused, or this key may not access this object',
    404: 'the object or bucket does not exist',
    409: 'the remote directory could not be created',
    412: 'the object changed while it was being read',
  }
  const hint = hints[response.status] ?? 'the service refused the request'
  return new Error(`${operation} failed with HTTP ${response.status}: ${hint}${text.length > 0 ? ` (${text.slice(0, 400)})` : ''}`)
}

/* ------------------------------------------------------------------------ */
/* S3                                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Sign one S3 request with Signature Version 4.
 * @param {object} options - request description.
 * @param {string} options.method - HTTP method.
 * @param {string} options.host - host header value, without scheme.
 * @param {string} options.path - canonical path, already percent-encoded.
 * @param {string} options.query - canonical query string, already encoded.
 * @param {Record<string,string>} options.headers - headers to send.
 * @param {string} options.payloadHash - hex SHA-256 of the body.
 * @param {{ accessKeyId: string, secretAccessKey: string, region: string, sessionToken?: string }} options.credentials - the key pair.
 * @returns {Record<string,string>} the headers, including `authorization`.
 */
export function signS3Request(options) {
  const at = options.date ?? new Date()
  const { long, short } = amzDates(at)
  const headers = { ...options.headers, host: options.host, 'x-amz-date': long, 'x-amz-content-sha256': options.payloadHash }
  if (typeof options.credentials.sessionToken === 'string' && options.credentials.sessionToken.length > 0) {
    headers['x-amz-security-token'] = options.credentials.sessionToken
  }
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort()
  const lookup = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]))
  const canonicalHeaders = names.map((name) => `${name}:${lookup.get(name)}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    options.method,
    options.path,
    options.query,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join('\n')
  const scope = `${short}/${options.credentials.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', long, scope, sha256Hex(canonicalRequest)].join('\n')
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${options.credentials.secretAccessKey}`, short), options.credentials.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** S3 transport: one bucket, one key prefix, path- or virtual-hosted addressing. */
export class S3Transport {
  /**
   * @param {{ endpoint?: string, region?: string, bucket: string, accessKeyId: string, secretAccessKey: string, sessionToken?: string }} settings - connection.
   */
  constructor(settings) {
    this.settings = settings
    if (typeof settings.bucket !== 'string' || settings.bucket.length === 0) throw new Error('the S3 bucket is not configured')
    if (typeof settings.accessKeyId !== 'string' || settings.accessKeyId.length === 0) throw new Error('the S3 access key id is not configured')
    if (typeof settings.secretAccessKey !== 'string' || settings.secretAccessKey.length === 0) throw new Error('the S3 secret access key is not configured')
    this.region = typeof settings.region === 'string' && settings.region.length > 0 ? settings.region : 'us-east-1'
    this.aws = isAwsEndpoint(settings.endpoint)
    const { scheme, host } = splitEndpoint(settings.endpoint)
    this.host = this.aws ? `${settings.bucket}.s3.${this.region}.amazonaws.com` : host
    this.scheme = this.aws ? 'https' : scheme
  }

  /** @returns {string} human-readable location of the bucket, for the page. */
  describe() {
    return `${this.bucket} at ${this.scheme}://${this.host}`
  }

  get bucket() {
    return this.settings.bucket
  }

  /** Object key to fully-formed path and URL. */
  locate(key) {
    const clean = String(key).replace(/^\/+/, '')
    const segments = clean.split('/').map((segment) => uriEncode(segment, false))
    const path = this.aws ? `/${segments.join('/')}` : `/${uriEncode(this.settings.bucket, false)}/${segments.join('/')}`
    return { path, url: `${this.scheme}://${this.host}${path}`, key: clean }
  }

  /** Send one signed request and return the raw response. */
  async send(method, key, body, extraHeaders = {}) {
    const target = this.locate(key)
    const payload = body ?? Buffer.alloc(0)
    const headers = signS3Request({
      method,
      host: this.host,
      path: target.path,
      query: '',
      headers: { ...extraHeaders, ...(payload.length > 0 ? { 'content-length': String(payload.length) } : {}) },
      payloadHash: payload.length === 0 ? EMPTY_SHA256 : sha256Hex(payload),
      credentials: {
        accessKeyId: this.settings.accessKeyId,
        secretAccessKey: this.settings.secretAccessKey,
        region: this.region,
        sessionToken: this.settings.sessionToken,
      },
    })
    return request(target.url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : payload })
  }

  /**
   * Upload one object.
   * @param {string} key - object key.
   * @param {Buffer|string} body - object bytes.
   * @param {string} [contentType] - content type.
   * @returns {Promise<{ etag?: string }>} response metadata.
   */
  async put(key, body, contentType = 'application/json') {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    const response = await this.send('PUT', key, payload, { 'content-type': contentType })
    if (response.status >= 300) throw await failureOf(`uploading ${key}`, response)
    return { etag: response.headers.get('etag') ?? undefined }
  }

  /**
   * Read one object.
   * @param {string} key - object key.
   * @returns {Promise<{ body: Buffer, etag?: string } | undefined>} bytes, or undefined when absent.
   */
  async get(key) {
    const response = await this.send('GET', key)
    if (response.status === 404) return undefined
    if (response.status >= 300) throw await failureOf(`reading ${key}`, response)
    return { body: response.body, etag: response.headers.get('etag') ?? undefined }
  }

  /**
   * Read one object's metadata without its bytes.
   * @param {string} key - object key.
   * @returns {Promise<{ etag?: string, size?: number, modified?: string } | undefined>} metadata, or undefined when absent.
   */
  async head(key) {
    const response = await this.send('HEAD', key)
    if (response.status === 404) return undefined
    if (response.status >= 300) throw await failureOf(`inspecting ${key}`, response)
    const size = Number(response.headers.get('content-length') ?? '')
    return {
      etag: response.headers.get('etag') ?? undefined,
      ...(Number.isFinite(size) ? { size } : {}),
      ...(response.headers.get('last-modified') === null ? {} : { modified: response.headers.get('last-modified') }),
    }
  }

  /**
   * List keys under a prefix, so the page can show what a remote holds.
   * @param {string} prefix - key prefix.
   * @returns {Promise<Array<{ key: string, size?: number, modified?: string }>>} objects.
   */
  async list(prefix) {
    const query = `list-type=2&prefix=${encodeURIComponent(prefix).replace(/%2F/g, '%2F')}&max-keys=100`
    const path = this.aws ? '/' : `/${uriEncode(this.settings.bucket, false)}/`
    const headers = signS3Request({
      method: 'GET', host: this.host, path, query,
      headers: {},
      payloadHash: EMPTY_SHA256,
      credentials: {
        accessKeyId: this.settings.accessKeyId,
        secretAccessKey: this.settings.secretAccessKey,
        region: this.region,
        sessionToken: this.settings.sessionToken,
      },
    })
    const response = await request(`${this.scheme}://${this.host}${path}?${query}`, { method: 'GET', headers })
    if (response.status >= 300) throw await failureOf(`listing ${prefix}`, response)
    const text = response.body.toString('utf8')
    const rows = []
    for (const match of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(match[1])?.[1]
      if (key === undefined) continue
      const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(match[1])?.[1] ?? '')
      const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(match[1])?.[1]
      rows.push({
        key: key.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        ...(Number.isFinite(size) ? { size } : {}),
        ...(modified === undefined ? {} : { modified }),
      })
    }
    return rows
  }
}

/* ------------------------------------------------------------------------ */
/* WebDAV                                                                    */
/* ------------------------------------------------------------------------ */

/** WebDAV transport: one base URL, one remote root, Basic auth. */
export class WebDavTransport {
  /**
   * @param {{ baseURL: string, username?: string, password?: string }} settings - connection.
   */
  constructor(settings) {
    const base = String(settings.baseURL ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(base)) throw new Error('the WebDAV URL must start with http:// or https://')
    this.base = base
    const user = String(settings.username ?? '')
    const password = String(settings.password ?? '')
    this.authorization = user.length === 0 && password.length === 0
      ? undefined
      : `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
  }

  /** @returns {string} the base URL, for the page. */
  describe() {
    return this.base
  }

  /** Absolute URL of one remote path, encoded segment by segment. */
  locate(path) {
    const clean = String(path).replace(/^\/+/, '')
    const encoded = clean.split('/').filter((segment) => segment.length > 0).map((segment) => encodeURIComponent(segment)).join('/')
    return { url: `${this.base}/${encoded}`, path: clean }
  }

  /** Perform one request with auth attached. */
  async send(method, path, body, headers = {}) {
    const target = this.locate(path)
    return request(target.url, {
      method,
      headers: {
        ...headers,
        ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : (body ?? Buffer.alloc(0)),
    })
  }

  /**
   * Upload one object, creating missing parent collections first.
   * @param {string} path - remote path.
   * @param {Buffer|string} body - object bytes.
   * @param {string} [contentType] - content type.
   * @returns {Promise<{ etag?: string }>} response metadata.
   */
  async put(path, body, contentType = 'application/json') {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    const segments = String(path).replace(/^\/+/, '').split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/')
      const created = await this.send('MKCOL', directory)
      if (created.status >= 300 && created.status !== 405 && created.status !== 301) {
        throw await failureOf(`creating ${directory}`, created)
      }
    }
    const response = await this.send('PUT', path, payload, { 'content-type': contentType })
    if (response.status >= 300) throw await failureOf(`uploading ${path}`, response)
    return { etag: response.headers.get('etag') ?? undefined }
  }

  /**
   * Read one object.
   * @param {string} path - remote path.
   * @returns {Promise<{ body: Buffer, etag?: string } | undefined>} bytes, or undefined when absent.
   */
  async get(path) {
    const response = await this.send('GET', path)
    if (response.status === 404) return undefined
    if (response.status >= 300) throw await failureOf(`reading ${path}`, response)
    return { body: response.body, etag: response.headers.get('etag') ?? undefined }
  }

  /**
   * Read one object's metadata without its bytes.
   * @param {string} path - remote path.
   * @returns {Promise<{ etag?: string, size?: number, modified?: string } | undefined>} metadata, or undefined when absent.
   */
  async head(path) {
    const response = await this.send('HEAD', path)
    if (response.status === 404) return undefined
    if (response.status >= 300) throw await failureOf(`inspecting ${path}`, response)
    const size = Number(response.headers.get('content-length') ?? '')
    return {
      etag: response.headers.get('etag') ?? undefined,
      ...(Number.isFinite(size) ? { size } : {}),
      ...(response.headers.get('last-modified') === null ? {} : { modified: response.headers.get('last-modified') }),
    }
  }

  /**
   * Create a collection and its parents.
   * @param {string} path - collection path.
   * @returns {Promise<void>} settlement.
   */
  async mkdir(path) {
    const segments = String(path).replace(/^\/+/, '').split('/').filter((segment) => segment.length > 0)
    for (let index = 1; index <= segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/')
      const created = await this.send('MKCOL', directory)
      if (created.status >= 300 && created.status !== 405 && created.status !== 301) {
        throw await failureOf(`creating ${directory}`, created)
      }
    }
  }
}

/**
 * Build the transport a cloud configuration names.
 * @param {{ backend?: string } & Record<string, unknown>} cloud - resolved cloud settings.
 * @returns {S3Transport | WebDavTransport} the transport.
 */
export function transportFor(cloud) {
  if (cloud.backend === 'webdav') return new WebDavTransport({
    baseURL: cloud.webdavBaseURL,
    username: cloud.webdavUsername,
    password: cloud.webdavPassword,
  })
  if (cloud.backend === 's3') return new S3Transport({
    endpoint: cloud.s3Endpoint,
    region: cloud.s3Region,
    bucket: cloud.s3Bucket,
    accessKeyId: cloud.s3AccessKeyId,
    secretAccessKey: cloud.s3SecretAccessKey,
    sessionToken: cloud.s3SessionToken,
  })
  throw new Error(`the cloud backend "${String(cloud.backend)}" is not supported; choose "s3" or "webdav"`)
}

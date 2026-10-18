/**
 * Runtime test for the Client half of the Model Sync bundle.
 *
 * The bundle ships as a browser module, so nothing here is imported the way the
 * Host half is: this test plays the page. It installs jsdom, loads the bundle
 * through `window.__ModuleLoader__`, applies it to a fake Client context built
 * from the real contracts (locale dictionaries, config forms, slots), then
 * renders the section and drives it the way a user would.
 *
 * The page under test is cloud-sync first: one page, no tab strip, a compact
 * read-only summary of this machine, and three short cloud options on one row.
 *
 * Run with: node test/client.mjs
 */
const { JSDOM } = await import('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Event = window.Event
globalThis.Node = window.Node

// react-dom snapshots the DOM globals when it initializes, so it must be
// imported *after* jsdom is installed — a static import would bind the event
// system to a window that does not exist yet.
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')

const reactWarnings = []
const realError = console.error
console.error = (...args) => {
  reactWarnings.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
  realError(...args)
}

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Mount the section into a fresh container and commit synchronously. */
function mount(Component, props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => root.render(React.createElement(Component, props)))
  return { container, root }
}
/** Drive a React event handler and commit its state changes. */
const act = (fn) => flushSync(fn)
const text = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
const button = (container, label) => [...container.querySelectorAll('button')].find((entry) => text(entry) === label)
const buttons = (container) => [...container.querySelectorAll('button')].map((entry) => text(entry))
const checkboxFor = (container, label) => [...container.querySelectorAll('label.dmsCheck')]
  .find((entry) => text(entry) === label)?.querySelector('input[type="checkbox"]')
const setInput = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const setSelect = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new window.Event('change', { bubbles: true }))
}

/* ------------------------------------------------------------------ */
/* A minimal replica of the Client contracts the bundle consumes.      */
/* ------------------------------------------------------------------ */

/** Dictionary lookup exactly like `locale.translate`: flat keys, then `{param}` substitution. */
function makeLocale({ language = 'zh' } = {}) {
  const dicts = new Map()
  return {
    dicts,
    register(ns, dictionaries) {
      dicts.set(ns, dictionaries)
    },
    bind(ns) {
      return (key, params) => {
        const dictionaries = dicts.get(ns) ?? {}
        // The real service falls back to the key itself, which is how a stale
        // key reaches the page as visible text. Mark it instead, so a test can
        // see it: a dictionary key must never be the text a user reads.
        const template = dictionaries[language]?.[key] ?? dictionaries.zh?.[key] ?? dictionaries.en?.[key] ?? `@@missing:${key}@@`
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
}

/** A settings form backed by a live provider map, mirroring ConfigFormController. */
function makeForm(initialProviders, { writable = true } = {}) {
  const state = { providers: structuredClone(initialProviders) }
  const listeners = new Set()
  const writes = []
  // `useSyncExternalStore` compares by identity, so the snapshot must be stable
  // between changes — exactly what the real store guarantees.
  let cached = { status: 'ready', value: { providers: state.providers }, revision: 1, writable }
  const snapshot = () => cached
  return {
    writes,
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops) {
      writes.push(structuredClone(ops))
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'providers') state.providers = structuredClone(op.value)
      }
      cached = { status: 'ready', value: { providers: state.providers }, revision: writes.length + 1, writable }
      for (const listener of listeners) listener()
      return true
    },
  }
}

/** The plugin's own namespace: cloud fields, plus `command`/`status`. */
function makeCloudForm(initial = {}, { writable = true } = {}) {
  const state = {
    backend: '', remoteRoot: 'dsh-model-key-sync', profile: 'default',
    s3Bucket: '', s3Region: 'auto', s3Endpoint: '', s3AccessKeyId: '',
    webdavBaseURL: '', webdavUsername: '',
    command: '', status: '', ...initial,
  }
  const listeners = new Set()
  const writes = []
  let cached = { status: 'ready', value: { ...state }, revision: 1, writable }
  const publish = () => {
    cached = { status: 'ready', value: { ...state }, revision: cached.revision + 1, writable }
    for (const listener of listeners) listener()
  }
  return {
    writes,
    state,
    getSnapshot: () => cached,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops) {
      writes.push(structuredClone(ops))
      for (const op of ops) {
        if (op.op !== 'set' || op.path.length !== 1) continue
        state[op.path[0]] = op.value
        if (op.path[0] === 's3SecretAccessKey' && typeof op.value === 'string' && op.value.length > 0) state.s3SecretConfigured = true
        if (op.path[0] === 'webdavPassword' && typeof op.value === 'string' && op.value.length > 0) state.webdavPasswordConfigured = true
      }
      publish()
      return true
    },
    /** Simulate the Host answering a command. */
    answer(status) {
      state.status = JSON.stringify(status)
      state.command = ''
      publish()
    },
  }
}

function makeClientContext(providers, cloudOptions, options = {}) {
  const locale = makeLocale({ language: options.language })
  const form = makeForm(providers, options)
  const cloudForm = makeCloudForm(cloudOptions, options)
  const registration = { value: undefined }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => disposer?.()
    },
    locale,
    configForms: {
      get: (ns) => (ns === 'model-key-sync' ? cloudForm : form),
      whileServed(_namespaces, register) {
        const served = new Set(options.served ?? ['llm-pi-ai', 'model-key-sync'])
        const off = register(served)
        return () => off?.()
      },
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(options_, Component) {
        registration.value = { options: options_, Component }
        return () => { registration.value = undefined }
      },
    },
  }
  return { ctx, form, cloudForm, registration, locale }
}

/* ------------------------------------------------------------------ */
/* Load the bundle the way the page does.                              */
/* ------------------------------------------------------------------ */

let loaded
window.__ModuleLoader__ = { load: (spec) => { loaded = spec } }
await import(new URL('../client.js', import.meta.url).href)

check('bundle announces its module id', loaded?.id === 'dsh-model-key-sync', loaded?.id)
const clientApi = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
})
check('bundle exposes inject + apply', Array.isArray(clientApi.inject) && typeof clientApi.apply === 'function')
check('bundle injects the services it uses', ['slots', 'locale', 'configForms'].every((name) => clientApi.inject.includes(name)), clientApi.inject.join(','))

/* ------------------------------------------------------------------ */
/* Empty profile: one page, no tabs, compact local summary.            */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration, locale } = makeClientContext({})
  clientApi.apply(ctx)
  const { options, Component } = registration.value ?? {}
  check('registers into settings.section', registration.value !== undefined)
  check('section id is model-key-sync', options?.id === 'model-key-sync', options?.id)
  check('section order is 12', options?.order === 12, String(options?.order))
  check('nav label localizes to Chinese', options?.label?.() === '模型密钥同步', options?.label?.())
  check('registers a component', typeof Component === 'function')

  const t = locale.bind('dsh-model-key-sync')
  check('dictionary resolves a dotted key', t('local.title') === '本机配置', t('local.title'))
  check('dictionary substitutes parameters', t('modelCount', { count: '3' }) === '3 个模型', t('modelCount', { count: '3' }))

  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  const rendered = text(container)
  check('renders the localized title', rendered.includes('模型密钥同步'), rendered.slice(0, 80))
  check('has no tab strip at all', container.querySelector('.dmsTabs') === null && !rendered.includes('云同步页签'))
  check('renders the cloud panel first', rendered.indexOf('云端存储') < rendered.indexOf('本机配置'), rendered.slice(0, 160))
  check('shows the empty local state', rendered.includes('还没有自定义模型'))
  check('marks the local summary read-only', rendered.includes('只读'))
  check('offers only export and restore locally', button(container, '导出') !== undefined && button(container, '恢复') !== undefined)
  check('drops copy, preview, add, edit and remove', ['复制 JSON', '查看 JSON', '添加自定义模型', '编辑', '移除', '保存到配置'].every((label) => button(container, label) === undefined), buttons(container).join(','))
  check('renders the three cloud action buttons', ['测试连接', '上传到云端', '从云端拉取'].every((label) => button(container, label) !== undefined), buttons(container).join(','))
  check('drops the refresh button', button(container, '刷新状态') === undefined)
  check('offers exactly three cloud options', container.querySelectorAll('label.dmsCheck').length === 3, String(container.querySelectorAll('label.dmsCheck').length))
  check('puts the three options in one no-wrap row', (() => {
    const checks = container.querySelector('.dmsChecks')
    if (checks === null) return false
    const style = window.getComputedStyle(checks)
    return style.display === 'flex' && style.flexWrap === 'nowrap'
  })(), container.querySelector('.dmsChecks')?.className)
  check('cloud has a single backend choice', container.querySelectorAll('select').length === 1)
  check('cloud is off by default', button(container, '上传到云端')?.disabled === true && button(container, '从云端拉取')?.disabled === true)
  check('warns that keys are stored as plaintext', rendered.includes('明文'), rendered.slice(0, 400))
  check('no raw dictionary key leaked', !/cloud\.|local\.|error\.|@@missing:/.test(rendered), rendered.slice(0, 240))
  check('no editor state is rendered', container.querySelectorAll('input[type="text"]').length === 0, String(container.querySelectorAll('input[type="text"]').length))
  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Populated profile: endpoint + model count only, no edit controls.   */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration } = makeClientContext({
    'acme-route': {
      displayName: '我的模型',
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 131072, maxTokens: 8192 }],
      retryPolicy: { attempts: 3 },
    },
    incomplete: { api: 'openai-completions', models: [] },
  })
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  const rendered = text(container)
  check('shows the provider display name', rendered.includes('我的模型'), rendered.slice(0, 160))
  check('shows the endpoint', rendered.includes('https://api.example.com/v1'))
  check('shows how many models each route carries', rendered.includes('1 个模型') && rendered.includes('0 个模型'))
  check('marks a missing endpoint', rendered.includes('未填写端点'))
  check('does not show the protocol any more', !rendered.includes('openai-completions'))
  check('renders one compact row per route', container.querySelectorAll('.dmsLocalRow').length === 2, String(container.querySelectorAll('.dmsLocalRow').length))
  check('offers no edit or remove controls', ['编辑', '移除', '添加自定义模型', '保存到配置'].every((label) => button(container, label) === undefined), buttons(container).join(','))
  check('keeps the export and restore escape hatches', button(container, '导出') !== undefined && button(container, '恢复') !== undefined)
  check('warns that unusable routes are skipped', rendered.includes('不会导出'), rendered.slice(-200))
  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Export still ships a document; restore still writes one.            */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration, form } = makeClientContext({
    'acme-route': {
      displayName: '我的模型',
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      models: [{ id: 'deepseek-v4.1-flash' }],
      defaultContextWindow: 200000,
      defaultMaxTokens: 4096,
      defaultInput: ['text', 'image'],
      reasoning: { effort: 'high' },
      cacheRetention: '1h',
      thinkingBudgets: { high: 4096 },
    },
    incomplete: { api: 'openai-completions', models: [] },
  })
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  const blobs = []
  const realCreate = URL.createObjectURL
  const realRevoke = URL.revokeObjectURL
  const realClick = window.HTMLAnchorElement.prototype.click
  URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:test' }
  URL.revokeObjectURL = () => {}
  window.HTMLAnchorElement.prototype.click = function click() { this.dataset.clicked = '1' }
  act(() => button(container, '导出').click())
  await tick()
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
  window.HTMLAnchorElement.prototype.click = realClick

  check('export reports that it started', text(container).includes('已开始下载'), text(container).slice(-160))
  const exported = blobs.length === 1 ? JSON.parse(await blobs[0].text()) : undefined
  check('export carries the restorable route', exported?.routes?.length === 1 && exported.routes[0].provider === 'acme-route', JSON.stringify(exported?.routes))
  check('export skips a route that cannot be restored', !exported?.routes?.some((route) => route.provider === 'incomplete'))
  check('export carries provider-level defaults', exported?.routes?.[0]?.defaultContextWindow === 200000 && exported?.routes?.[0]?.defaultMaxTokens === 4096, JSON.stringify(exported?.routes?.[0]))
  check('export carries reasoning and input settings', Array.isArray(exported?.routes?.[0]?.defaultInput) && exported?.routes?.[0]?.reasoning?.effort === 'high', JSON.stringify(exported?.routes?.[0]))

  const document = {
    format: 'dsh-model-sync/provider',
    version: 1,
    routes: [
      {
        provider: 'imported',
        displayName: '导入的模型',
        api: 'anthropic-messages',
        baseURL: 'https://import.example.com',
        apiKeyEnv: 'IMPORTED_API_KEY',
        models: [{ id: 'claude-like', contextWindow: 200000 }],
        defaultContextWindow: 100000,
        defaultMaxTokens: 2048,
        defaultInput: ['text'],
        reasoning: { effort: 'medium' },
        cacheRetention: '30m',
        thinkingBudgets: { medium: 2048 },
      },
    ],
  }
  const fileInput = container.querySelector('input[type="file"]')
  check('has a hidden file input for restore', fileInput !== null)
  Object.defineProperty(fileInput, 'files', {
    value: [{ text: async () => JSON.stringify(document) }],
    configurable: true,
  })
  act(() => fileInput.dispatchEvent(new window.Event('change', { bubbles: true })))
  await tick()
  await tick()

  const write = form.writes.at(-1)?.find((op) => op.path?.[0] === 'providers')?.value
  check('restore writes through the shared settings form', write?.imported !== undefined, Object.keys(write ?? {}).join(','))
  check('restore keeps the protocol', write?.imported?.api === 'anthropic-messages', write?.imported?.api)
  check('restore keeps the catalog', write?.imported?.models?.[0]?.id === 'claude-like', JSON.stringify(write?.imported?.models))
  check('restore keeps the key reference', write?.imported?.apiKeyEnv === 'IMPORTED_API_KEY', write?.imported?.apiKeyEnv)
  check('restore keeps provider-level defaults', write?.imported?.defaultContextWindow === 100000 && write?.imported?.defaultMaxTokens === 2048, JSON.stringify(write?.imported))
  check('restore keeps reasoning and input settings', write?.imported?.defaultInput?.[0] === 'text' && write?.imported?.reasoning?.effort === 'medium', JSON.stringify(write?.imported))
  check('restore reports the count', text(container).includes('已导入 1 个模型提供方'), text(container).slice(0, 200))
  check('restored route appears in the compact list', text(container).includes('导入的模型') && text(container).includes('1 个模型'))

  Object.defineProperty(fileInput, 'files', { value: [{ text: async () => 'not json' }], configurable: true })
  act(() => fileInput.dispatchEvent(new window.Event('change', { bubbles: true })))
  await tick()
  await tick()
  check('restore rejects a non-JSON file with a message', text(container).includes('不是合法的 JSON'), text(container).slice(0, 200))

  Object.defineProperty(fileInput, 'files', { value: [{ text: async () => '{"format":"other"}' }], configurable: true })
  act(() => fileInput.dispatchEvent(new window.Event('change', { bubbles: true })))
  await tick()
  await tick()
  check('restore rejects a document without routes', text(container).includes('没有模型提供方'), text(container).slice(0, 200))

  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Read-only profile: nothing can be written.                          */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration } = makeClientContext({
    acme: { displayName: 'Acme', api: 'openai-completions', baseURL: 'https://acme.example.com/v1', models: [{ id: 'acme-1' }] },
  }, {}, { writable: false })
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  check('read-only export stays available', button(container, '导出')?.disabled === false)
  check('read-only restore is disabled', button(container, '恢复')?.disabled === true)
  check('read-only cloud save is disabled', button(container, '保存')?.disabled === true)
  check('read-only cloud actions are disabled', ['测试连接', '上传到云端', '从云端拉取'].every((label) => button(container, label)?.disabled === true))
  check('read-only is stated', text(container).includes('当前配置为只读'))
  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Cloud page: three short options, one save, command round trip.      */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration, cloudForm } = makeClientContext({ acme: { displayName: 'Acme', api: 'openai-completions', baseURL: 'https://acme.example.com/v1', models: [{ id: 'acme-1' }] } })
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  const rendered = text(container)
  check('cloud page renders without clicking a tab', rendered.includes('上传到云端') && rendered.includes('从云端拉取'), rendered.slice(0, 120))
  check('three options are short enough for one line', ['强制覆盖', '自动上传', '同步密钥'].every((label) => checkboxFor(container, label) !== undefined))
  check('there is no separate save-credentials button', button(container, '保存密钥') === undefined)
  check('there is no refresh button', button(container, '刷新状态') === undefined)
  check('upload waits for a configured backend', button(container, '上传到云端')?.disabled === true)

  const select = container.querySelector('select')
  act(() => setSelect(select, 's3'))
  await tick()
  const textInputs = [...container.querySelectorAll('input[type="text"]')]
  const labels = textInputs.map((input) => input.getAttribute('aria-label'))
  check('s3 fields appear once chosen', ['桶名', '区域', 'Endpoint', 'Access Key ID', '远端目录', '同步分组'].every((label) => labels.includes(label)), labels.join(','))
  check('the secret field is write-only and masked', container.querySelector('input[type="password"]')?.type === 'password')

  act(() => setInput(textInputs.find((input) => input.getAttribute('aria-label') === '桶名'), 'my-bucket'))
  act(() => setInput(container.querySelector('input[type="password"]'), 'top-secret'))
  act(() => button(container, '保存').click())
  await tick()

  const saved = cloudForm.writes.at(-1)
  check('one save writes the backend', saved?.some((op) => op.path[0] === 'backend' && op.value === 's3'), JSON.stringify(saved))
  check('one save writes the bucket', saved?.some((op) => op.path[0] === 's3Bucket' && op.value === 'my-bucket'), JSON.stringify(saved))
  check('one save writes the secret too', saved?.some((op) => op.path[0] === 's3SecretAccessKey' && op.value === 'top-secret'), JSON.stringify(saved))
  check('the stored secret is marked without echoing it', text(container).includes('已保存') && !text(container).includes('top-secret'))
  check('upload unlocks after saving', button(container, '上传到云端')?.disabled === false)

  act(() => button(container, '上传到云端').click())
  await tick()
  const command = JSON.parse(cloudForm.state.command)
  check('upload posts a command instead of calling the network', command.kind === 'push', cloudForm.state.command)
  check('the command carries an id', typeof command.id === 'string' && command.id.length > 0)
  check('the page shows a pending state', text(container).includes('处理中'), text(container).slice(-160))

  act(() => cloudForm.answer({ id: command.id, kind: 'push', ok: true, at: '2026-10-18T00:00:00.000Z', message: 'pushed', detail: JSON.stringify({ snapshotId: 'abc', routes: ['acme'], credentials: ['ACME_API_KEY'] }) }))
  await tick()
  const after = text(container)
  check('the answer is rendered', after.includes('pushed'), after.slice(-200))
  check('the answer names the credentials it stored', after.includes('ACME_API_KEY'), after.slice(-240))
  check('the detail is collapsed by default', container.querySelector('details.dmsDetails')?.open === false)
  check('the pending state clears', after.includes('处理中') === false)
  check('the run kind is localized', after.includes('· 上传'), after.slice(0, 240))
  check('the cloud page shows no raw dictionary key', !after.includes('@@missing:'), after.slice(0, 240))

  // An option changed but not saved must travel with the next action, not be
  // left in the page while the Host acts on the old persisted value.
  act(() => { checkboxFor(container, '同步密钥').click() })
  await tick()
  act(() => button(container, '上传到云端').click())
  await tick()
  const flushed = cloudForm.writes.at(-1)
  check('upload flushes a pending option', flushed?.some((op) => op.path[0] === 'syncCredentials' && op.value === false), JSON.stringify(flushed))
  check('upload flushes it before the command', cloudForm.state.syncCredentials === false, JSON.stringify(cloudForm.state))
  check('pending options are cleared after the action', button(container, '保存')?.disabled === true, text(container).slice(0, 240))
  act(() => cloudForm.answer({ id: 'flush-test', kind: 'push', ok: true, at: '2026-10-18T00:00:00.500Z', message: 'pushed' }))
  await tick()

  act(() => cloudForm.answer({ id: 'x', kind: 'pull', ok: false, at: '2026-10-18T00:00:01.000Z', message: 'cloud/conflict: remote moved', detail: JSON.stringify({ code: 'cloud/conflict' }) }))
  await tick()
  check('a failed run is reported as a warning', text(container).includes('cloud/conflict'), text(container).slice(-200))

  act(() => { checkboxFor(container, '强制覆盖').click() })
  await tick()
  act(() => button(container, '从云端拉取').click())
  await tick()
  check('forcing is carried into the command', JSON.parse(cloudForm.state.command).force === true, cloudForm.state.command)

  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Partial deployments and the English dictionary.                     */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration } = makeClientContext({
    acme: { displayName: 'Acme', api: 'openai-completions', baseURL: 'https://acme.example.com/v1', models: [{ id: 'acme-1' }] },
  }, {}, { served: ['llm-pi-ai'] })
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })
  const rendered = text(container)
  check('a deployment without the plugin namespace still shows the local summary', rendered.includes('本机配置') && rendered.includes('Acme'), rendered.slice(0, 160))
  check('it explains the missing cloud half', rendered.includes('没有提供云同步设置'), rendered.slice(0, 240))
  check('it offers no dead cloud controls', button(container, '上传到云端') === undefined)
  root.unmount()
}

{
  const { ctx, registration } = makeClientContext({
    acme: { displayName: 'Acme', api: 'openai-completions', baseURL: 'https://acme.example.com/v1', models: [{ id: 'acme-1' }] },
  }, {}, { language: 'en' })
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })
  const select = container.querySelector('select')
  act(() => setSelect(select, 's3'))
  await tick()
  const rendered = text(container)
  check('English renders the page title', rendered.includes('Model Key Sync'), rendered.slice(0, 80))
  check('English renders the local summary', rendered.includes('This machine') && rendered.includes('read-only'), rendered.slice(0, 160))
  check('English renders the action labels', ['Test', 'Upload', 'Pull', 'Save'].every((label) => button(container, label) !== undefined), buttons(container).join(','))
  check('English renders the S3 secret label', rendered.includes('Secret Access Key'), rendered.slice(0, 240))
  check('English uses the singular model count', rendered.includes('1 model'), rendered.slice(0, 200))
  check('English has no missing dictionary key', !rendered.includes('@@missing:'), rendered.slice(0, 240))
  root.unmount()
}


console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('failed:', failures.join(' | '))
  process.exit(1)
}

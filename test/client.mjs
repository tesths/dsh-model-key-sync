/**
 * Runtime test for the Client half of the Model Sync bundle.
 *
 * The bundle ships as a browser module, so nothing here is imported the way the
 * Host half is: this test plays the page. It installs jsdom, loads the bundle
 * through `window.__ModuleLoader__`, applies it to a fake Client context built
 * from the real contracts (locale dictionaries, config forms, slots), then
 * renders the section and drives it the way a user would.
 *
 * Run with: node test/client.mjs
 */
/**
 * Resolve a test-only dependency: prefer a normal install, fall back to the
 * scratch install this suite was developed against.
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

/* ------------------------------------------------------------------ */
/* A minimal replica of the Client contracts the bundle consumes.      */
/* ------------------------------------------------------------------ */

/** Dictionary lookup exactly like `locale.translate`: flat keys, then `{param}` substitution. */
function makeLocale() {
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
        const template = dictionaries.zh?.[key] ?? dictionaries.en?.[key] ?? `@@missing:${key}@@`
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
}

/** A settings form backed by a live provider map, mirroring ConfigFormController. */
function makeForm(initialProviders) {
  const state = { providers: structuredClone(initialProviders) }
  const listeners = new Set()
  const writes = []
  // `useSyncExternalStore` compares by identity, so the snapshot must be stable
  // between changes — exactly what the real store guarantees.
  let cached = { status: 'ready', value: { providers: state.providers }, revision: 1, writable: true }
  const snapshot = () => cached
  return {
    writes,
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops, expectedRevision) {
      writes.push(structuredClone(ops))
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'providers') state.providers = structuredClone(op.value)
      }
      cached = { status: 'ready', value: { providers: state.providers }, revision: writes.length + 1, writable: true }
      for (const listener of listeners) listener()
      return true
    },
  }
}

/** The plugin's own namespace: cloud fields, plus `command`/`status`. */
function makeCloudForm(initial = {}) {
  const state = {
    backend: '', remoteRoot: 'dsh-model-sync', profile: 'default',
    s3Bucket: '', s3Region: 'auto', s3Endpoint: '', s3AccessKeyId: '',
    webdavBaseURL: '', webdavUsername: '',
    command: '', status: '', ...initial,
  }
  const listeners = new Set()
  const writes = []
  let cached = { status: 'ready', value: { ...state }, revision: 1, writable: true }
  const publish = () => {
    cached = { status: 'ready', value: { ...state }, revision: cached.revision + 1, writable: true }
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
      for (const op of ops) if (op.op === 'set' && op.path.length === 1) state[op.path[0]] = op.value
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

function makeClientContext(providers, cloudOptions) {
  const locale = makeLocale()
  const form = makeForm(providers)
  const cloudForm = makeCloudForm(cloudOptions)
  const registration = { value: undefined }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => disposer?.()
    },
    locale,
    configForms: {
      get: (ns) => (ns === 'model-key-sync' ? cloudForm : form),
      list: () => ['llm-pi-ai', 'model-key-sync'],
      whileServed(_namespaces, register) {
        const off = register(new Set(['llm-pi-ai', 'model-key-sync']))
        return () => off?.()
      },
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(options, Component) {
        registration.value = { options, Component }
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
/* Empty profile: registration + empty state.                          */
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
  check('dictionary resolves a dotted key', t('field.route').startsWith('路由名'), t('field.route'))
  check('dictionary substitutes parameters', t('modelCount', { count: '3' }) === '3 个模型', t('modelCount', { count: '3' }))

  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  const rendered = text(container)
  check('renders the localized title', rendered.includes('模型密钥同步'), rendered.slice(0, 80))
  check('renders the intro copy', rendered.includes('本机配置'), rendered.slice(0, 120))
  check('shows the empty state', rendered.includes('还没有自定义模型'))
  check('shows every action button', ['复制 JSON', '下载文件', '从文件恢复', '添加自定义模型'].every((label) => rendered.includes(label)))
  check('no raw dictionary key leaked', !/field\.|error\.|model\.id|@@missing:/.test(rendered), rendered.slice(0, 240))
  check('offers a cloud tab', rendered.includes('本机配置') && rendered.includes('云同步'))
  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Populated profile: cards, editing, saving, removing.                */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration, form } = makeClientContext({
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
  check('shows the route id on the card', rendered.includes('acme-route'))
  check('shows the endpoint and protocol', rendered.includes('https://api.example.com/v1') && rendered.includes('openai-completions'))
  check('shows the model catalog', rendered.includes('deepseek-v4.1-flash') && rendered.includes('1 个模型'))
  check('warns about the route that cannot travel', rendered.includes('缺少端点或模型清单'))

  /* Add a route through the editor. */
  const addButton = [...container.querySelectorAll('button')].find((button) => text(button) === '+ 添加自定义模型')
  check('has the add-route control', addButton !== undefined)
  act(() => addButton.click())
  await tick()

  const inputs = [...container.querySelectorAll('input[type="text"]')]
  const setValue = (element, value) => {
    if (element === undefined) {
      failures.push('setValue on a missing input')
      return
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  // four text fields (route, name, endpoint, key reference) plus one model row
  check('editor opened with its fields', inputs.length === 8, String(inputs.length))
  act(() => setValue(inputs[0], 'mymodel'))
  act(() => setValue(inputs[1], '我的中转'))
  act(() => setValue(inputs[2], 'https://relay.example.com/v1'))

  const modelInputs = [...container.querySelectorAll('input[type="text"]')]
  act(() => setValue(modelInputs[4], 'relay-model-1'))

  const saveButton = [...container.querySelectorAll('button')].find((button) => text(button) === '保存到配置')
  check('has the save control', saveButton !== undefined)
  act(() => saveButton.click())
  await tick()

  const write = form.writes.at(-1)
  const nextProviders = write?.find((op) => op.path?.[0] === 'providers')?.value
  check('saves through the shared settings form', nextProviders !== undefined, JSON.stringify(form.writes))
  const added = nextProviders?.mymodel
  check('saves the route under its key', added !== undefined, Object.keys(nextProviders ?? {}).join(','))
  check('saves the display name', added?.displayName === '我的中转', added?.displayName)
  check('saves the endpoint', added?.baseURL === 'https://relay.example.com/v1', added?.baseURL)
  check('saves the protocol', added?.api === 'openai-completions', added?.api)
  check('saves the model catalog', added?.models?.[0]?.id === 'relay-model-1', JSON.stringify(added?.models))
  check('derives the key reference from the route', added?.apiKeyEnv === 'MYMODEL_API_KEY', added?.apiKeyEnv)
  check('keeps the untouched route intact', form.writes.at(-1) !== undefined && nextProviders?.['acme-route'] !== undefined)

  await tick()
  check('reports the save', text(container).includes('已保存 mymodel'), text(container).slice(0, 200))

  /* Remove a route. */
  const removeButton = [...container.querySelectorAll('button')].find((button) => text(button) === '移除')
  act(() => removeButton.click())
  await tick()
  const afterRemove = form.writes.at(-1)?.find((op) => op.path?.[0] === 'providers')?.value
  check('removes the route from the map', !('acme-route' in (afterRemove ?? {})), Object.keys(afterRemove ?? {}).join(','))
  check('reports the removal', text(container).includes('已移除'), text(container).slice(-120))

  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Restore from a file.                                                */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration, form } = makeClientContext({})
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

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
      },
    ],
  }
  const fileInput = container.querySelector('input[type="file"]')
  check('has a hidden file input', fileInput !== null)
  Object.defineProperty(fileInput, 'files', {
    value: [{ text: async () => JSON.stringify(document) }],
    configurable: true,
  })
  act(() => fileInput.dispatchEvent(new window.Event('change', { bubbles: true })))
  await tick()
  await tick()

  const write = form.writes.at(-1)?.find((op) => op.path?.[0] === 'providers')?.value
  check('imports the route from the document', write?.imported !== undefined, Object.keys(write ?? {}).join(','))
  check('imports the protocol as given', write?.imported?.api === 'anthropic-messages', write?.imported?.api)
  check('imports the catalog', write?.imported?.models?.[0]?.id === 'claude-like', JSON.stringify(write?.imported?.models))
  check('keeps the imported key reference', write?.imported?.apiKeyEnv === 'IMPORTED_API_KEY', write?.imported?.apiKeyEnv)
  check('reports the import count', text(container).includes('已导入 1 个模型提供方'), text(container).slice(0, 200))

  /* A file that is not JSON must report a problem, not crash. */
  Object.defineProperty(fileInput, 'files', { value: [{ text: async () => 'not json' }], configurable: true })
  act(() => fileInput.dispatchEvent(new window.Event('change', { bubbles: true })))
  await tick()
  await tick()
  check('rejects a non-JSON file with a message', text(container).includes('不是合法的 JSON'), text(container).slice(0, 200))

  /* A JSON document with no route must be rejected too. */
  Object.defineProperty(fileInput, 'files', { value: [{ text: async () => '{"format":"other"}' }], configurable: true })
  act(() => fileInput.dispatchEvent(new window.Event('change', { bubbles: true })))
  await tick()
  await tick()
  check('rejects a document without routes', text(container).includes('没有模型提供方'), text(container).slice(0, 200))

  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Validation blocks a write before it reaches the Host.               */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration, form } = makeClientContext({})
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  act(() => [...container.querySelectorAll('button')].find((button) => text(button) === '+ 添加自定义模型').click())
  await tick()
  const inputs = [...container.querySelectorAll('input[type="text"]')]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const setValue = (element, value) => {
    setter.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  act(() => setValue(inputs[0], 'Broken Route'))
  act(() => setValue(inputs[1], '坏路由'))
  act(() => setValue(inputs[2], 'ftp://nope'))
  act(() => [...container.querySelectorAll('button')].find((button) => text(button) === '保存到配置').click())
  await tick()

  check('blocks an invalid route id', form.writes.length === 0 && text(container).includes('路由名只能使用小写字母'), text(container).slice(0, 160))
  root.unmount()
}

/* ------------------------------------------------------------------ */
/* Cloud tab: settings write-through and the command round trip.        */
/* ------------------------------------------------------------------ */

{
  const { ctx, registration, cloudForm } = makeClientContext({ acme: { displayName: 'Acme', api: 'openai-completions', baseURL: 'https://acme.example.com/v1', models: [{ id: 'acme-1' }] } })
  clientApi.apply(ctx)
  const { options, Component } = registration.value
  const { container, root } = mount(Component, { ...options.inject(), close: () => {} })

  const button = (label) => [...container.querySelectorAll('button')].find((entry) => text(entry) === label)
  act(() => button('云同步').click())
  await tick()

  const rendered = text(container)
  check('cloud tab renders its own copy', rendered.includes('上传到云端') && rendered.includes('从云端拉取'), rendered.slice(0, 120))
  check('cloud tab offers a backend choice', container.querySelectorAll('select').length === 1)
  check('cloud tab hides sync until configured', button('上传到云端')?.disabled === true)
  check('cloud tab warns that keys are stored as plaintext', rendered.includes('明文'), rendered.slice(0, 400))

  const select = container.querySelector('select')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, 's3')
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await tick()
  const textInputs = [...container.querySelectorAll('input[type="text"]')]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const setValue = (element, value) => {
    setter.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const bucket = textInputs.find((input) => input.getAttribute('aria-label') === '桶名')
  check('s3 fields appear once chosen', bucket !== undefined, textInputs.map((i) => i.getAttribute('aria-label')).join(','))
  act(() => setValue(bucket, 'my-bucket'))
  act(() => button('保存配置').click())
  await tick()

  check('saving writes the backend choice', cloudForm.writes.some((ops) => ops.some((op) => op.path[0] === 'backend' && op.value === 's3')), JSON.stringify(cloudForm.writes.at(-1)))
  check('saving writes the bucket', cloudForm.writes.some((ops) => ops.some((op) => op.path[0] === 's3Bucket' && op.value === 'my-bucket')), JSON.stringify(cloudForm.writes.at(-1)))

  const secret = container.querySelector('input[type="password"]')
  check('the secret field is write-only and masked', secret !== undefined && secret.type === 'password')
  act(() => setValue(secret, 'top-secret'))
  act(() => button('保存密钥').click())
  await tick()
  const secretWrite = cloudForm.writes.at(-1)
  check('saving credentials sets the secret field', secretWrite.some((op) => op.path[0] === 's3SecretAccessKey' && op.value === 'top-secret'), JSON.stringify(secretWrite))

  act(() => button('上传到云端').click())
  await tick()
  const command = JSON.parse(cloudForm.state.command)
  check('upload posts a command instead of calling the network', command.kind === 'push', cloudForm.state.command)
  check('the command carries an id', typeof command.id === 'string' && command.id.length > 0)
  check('the page shows a pending state', text(container).includes('处理中'), text(container).slice(-160))

  act(() => cloudForm.answer({ id: command.id, kind: 'push', ok: true, at: '2026-10-18T00:00:00.000Z', message: 'pushed', detail: JSON.stringify({ snapshotId: 'abc', routes: ['acme'], credentials: ['ACME_API_KEY'] }) }))
  await tick()
  const after = text(container)
  check('the answer is rendered', after.includes('pushed'), after.slice(-200))
  check('the answer shows the snapshot id', after.includes('abc'), after.slice(-200))
  check('the pending state clears', after.includes('处理中') === false)
  check('the cloud tab shows no raw dictionary key', !after.includes('@@missing:'), after.slice(0, 240))
  check('the answer names the credentials it stored', after.includes('ACME_API_KEY'), after.slice(-240))

  act(() => cloudForm.answer({ id: 'x', kind: 'pull', ok: false, at: '2026-10-18T00:00:01.000Z', message: 'cloud/conflict: remote moved', detail: JSON.stringify({ code: 'cloud/conflict' }) }))
  await tick()
  check('a failed run is reported as a warning', text(container).includes('cloud/conflict'), text(container).slice(-200))

  const force = container.querySelector('input[type="checkbox"]')
  act(() => { force.click() })
  await tick()
  act(() => button('从云端拉取').click())
  await tick()
  check('forcing is carried into the command', JSON.parse(cloudForm.state.command).force === true, cloudForm.state.command)

  root.unmount()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('failed:', failures.join(' | '))
  process.exit(1)
}

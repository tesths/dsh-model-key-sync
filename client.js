/**
 * Client half of the Model Sync bundle.
 *
 * Adds a "Model Sync" section to Settings. Every read goes through the shared
 * settings mirror (`ctx.configForms`) and every write goes through the same
 * shared form the Models page uses, so this section can never disagree with the
 * Models page about what the profile holds.
 *
 * Two tabs. The local tab inspects, edits, exports and restores model
 * declarations through the shared settings mirror. The cloud tab edits this
 * plugin's own settings and posts an action for the Host to perform.
 *
 * How the cloud tab reaches the Host, and why not another way: a bundle
 * installed from a directory cannot declare its own Remote namespace — that
 * needs generated Typert artifacts — so there is no wire for a page-initiated
 * Host call. It can, however, read and write its own settings namespace, which
 * the settings Remote already carries. A command therefore travels as the value
 * of one field, and the Host answers by writing the outcome into another.
 *
 * @module dsh-model-key-sync/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-key-sync',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Settings namespace of the pi-ai row whose `providers` this page edits. */
    const LLM_NS = 'llm-pi-ai'
    /** Protocols a hand-declared route may use. */
    const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

    const STYLE_ID = 'dsh-model-key-sync/model-sync.css'
    const css = [
      '.dmsSection{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}',
      '.dmsTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dmsIntro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}',
      '.dmsNotice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}',
      '.dmsWarn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-bg,transparent);border-radius:var(--dsw-radius-md);margin:0;font-size:12px;line-height:18px;padding:8px 10px}',
      '.dmsSaved{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}',
      '.dmsCard{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:12px;padding:12px 14px;display:flex}',
      '.dmsHead{align-items:center;gap:8px;display:flex}',
      '.dmsIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.dmsName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
      '.dmsTag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}',
      '.dmsMono{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dmsActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}',
      '.dmsPrimary{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;font:inherit;cursor:pointer;border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
      '.dmsPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dmsSecondary{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);height:36px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
      '.dmsSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dmsActions .dmsSecondary{height:28px;padding:0 10px;font-size:12px;line-height:18px}',
      '.dmsPrimary:disabled,.dmsSecondary:disabled{opacity:.4;cursor:default}',
      '.dmsGrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;display:grid}',
      '.dmsTabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l3);margin-bottom:4px}',
      '.dmsTab{background:0 0;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:14px;line-height:22px;padding:6px 10px;margin-bottom:-1px}',
      '.dmsTab:hover:not(.dmsTabActive){color:var(--dsw-alias-label-primary)}',
      '.dmsTabActive{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}',
      '.dmsPanel{flex-direction:column;gap:12px;display:flex}',
      '.dmsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}',
      '.dmsInput{box-sizing:border-box;width:100%;height:32px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px}',
      '.dmsInput:disabled{opacity:.5}',
      '.dmsHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:16px}',
      '.dmsCheck{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}',
      '.dmsCheck input{width:14px;height:14px;margin:0}',
      '.dmsField{flex-direction:column;gap:6px;min-width:0;display:flex}',
      '.dmsLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}',
      '.dmsInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:14px;line-height:22px}',
      '.dmsInput:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
      '.dmsModels{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex}',
      '.dmsModelsHead{justify-content:space-between;align-items:center;display:flex}',
      '.dmsModel{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);padding:8px}',
      '.dmsModelRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto;align-items:center;gap:6px;display:grid}',
      '.dmsModelExtra{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding-top:6px;display:grid}',
      '.dmsIcon{box-sizing:border-box;border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;display:inline-flex}',
      '.dmsIcon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
      '.dmsLink{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;align-self:flex-start;align-items:center;gap:4px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}',
      '.dmsLink:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dmsRowActions{justify-content:flex-end;gap:8px;display:flex}',
      '.dmsFiles{flex-direction:column;gap:8px;display:flex}',
      '.dmsFile{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);align-items:center;gap:8px;padding:8px 10px;display:flex}',
      '.dmsFileText{flex-direction:column;min-width:0;display:flex}',
      '.dmsFileName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dmsPre{margin:0;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;max-height:320px;overflow:auto;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dmsEmpty{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-tertiary);text-align:center;padding:14px;font-size:13px;line-height:20px}',
      '.dmsVisuallyHidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    ].join('')

    const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))
    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const derivedKey = (route) => `${String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

    /** A snapshot record of one live provider profile: only the fields this page owns. */
    function recordOf(route, profile) {
      return {
        provider: route,
        displayName: typeof profile?.displayName === 'string' ? profile.displayName : route,
        api: typeof profile?.api === 'string' ? profile.api : 'openai-completions',
        baseURL: typeof profile?.baseURL === 'string' ? profile.baseURL : '',
        apiKeyEnv: typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0 ? profile.apiKeyEnv : derivedKey(route),
        models: Array.isArray(profile?.models) ? clone(profile.models) : [],
      }
    }

    /** Whether a live profile can travel: without a catalog and endpoint it cannot be restored elsewhere. */
    const syncable = (profile) => isRecord(profile)
      && Array.isArray(profile.models) && profile.models.length > 0
      && typeof profile.baseURL === 'string' && /^https?:\/\//i.test(profile.baseURL)

    /** Model rows padded for editing: numbers become strings so they can be typed. */
    function editableModels(models) {
      if (!Array.isArray(models) || models.length === 0) return [{ id: '', name: '', contextWindow: '', maxTokens: '' }]
      return models.map((model) => ({
        id: typeof model.id === 'string' ? model.id : '',
        name: typeof model.name === 'string' ? model.name : '',
        contextWindow: Number.isInteger(model.contextWindow) ? String(model.contextWindow) : '',
        maxTokens: Number.isInteger(model.maxTokens) ? String(model.maxTokens) : '',
        ...(model.input === undefined ? {} : { input: clone(model.input) }),
        ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: clone(model.reasoningEfforts) }),
        ...(model.compat === undefined ? {} : { compat: clone(model.compat) }),
      }))
    }

    /** Turn edited model rows back into profile model rows. */
    function committedModels(rows) {
      return rows
        .filter((row) => String(row.id ?? '').trim().length > 0)
        .map((row) => {
          const model = { id: String(row.id).trim() }
          if (String(row.name ?? '').trim().length > 0) model.name = String(row.name).trim()
          const contextWindow = Number.parseInt(row.contextWindow, 10)
          if (Number.isInteger(contextWindow) && contextWindow > 0) model.contextWindow = contextWindow
          const maxTokens = Number.parseInt(row.maxTokens, 10)
          if (Number.isInteger(maxTokens) && maxTokens > 0) model.maxTokens = maxTokens
          if (row.input !== undefined) model.input = clone(row.input)
          if (row.reasoningEfforts !== undefined) model.reasoningEfforts = clone(row.reasoningEfforts)
          if (row.compat !== undefined) model.compat = clone(row.compat)
          return model
        })
    }

    /** Build the profile fields this page owns from an edited card. */
    function profileOf(card, current) {
      const base = isRecord(current) ? clone(current) : {}
      for (const field of ['displayName', 'api', 'baseURL', 'models', 'apiKeyEnv', 'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'reasoning', 'cacheRetention', 'thinkingBudgets']) delete base[field]
      return {
        ...base,
        displayName: String(card.displayName).trim() || card.provider,
        api: card.api,
        baseURL: String(card.baseURL).trim(),
        models: committedModels(card.models),
        apiKeyEnv: String(card.apiKeyEnv ?? '').trim() || derivedKey(card.provider),
      }
    }

    /** Validate one edited card before it is written. */
    function validate(card, isNew) {
      if (String(card.provider ?? '').trim().length === 0) return 'error.route'
      if (isNew && !/^[a-z0-9][a-z0-9-]*$/.test(String(card.provider).trim())) return 'error.routeShape'
      if (String(card.displayName ?? '').trim().length === 0) return 'error.displayName'
      if (!/^https?:\/\/\S+/i.test(String(card.baseURL ?? '').trim())) return 'error.baseURL'
      if (!PROTOCOLS.includes(card.api)) return 'error.api'
      if (committedModels(card.models).length === 0) return 'error.models'
      return undefined
    }

    /** Normalize a pasted or downloaded document into route records. */
    /**
     * Parse the JSON status the Host writes back into the settings namespace.
     * @param {unknown} raw - the stored string.
     * @returns {{ ok?: boolean, message?: string, at?: string, kind?: string, detailText?: string } | undefined} the status.
     */
    function readStatus(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return undefined
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return undefined
      }
      if (parsed === null || typeof parsed !== 'object') return undefined
      const detail = typeof parsed.detail === 'string' ? parsed.detail : undefined
      let detailText
      if (detail !== undefined && detail.length > 0 && detail !== 'null') {
        try {
          const unwrapped = JSON.parse(detail)
          detailText = typeof unwrapped?.document === 'string' ? unwrapped.document : JSON.stringify(unwrapped, null, 2)
        } catch {
          detailText = detail
        }
      }
      const credentials = (() => {
        if (detail === undefined) return undefined
        try {
          const unwrapped = JSON.parse(detail)
          return Array.isArray(unwrapped?.credentials) ? unwrapped.credentials.map(String) : undefined
        } catch {
          return undefined
        }
      })()
      return {
        ok: parsed.ok === true,
        message: typeof parsed.message === 'string' ? parsed.message : '',
        at: typeof parsed.at === 'string' ? parsed.at : undefined,
        kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
        credentials,
        detailText,
      }
    }

    function routesOfDocument(document) {
      const routes = Array.isArray(document?.routes)
        ? document.routes
        : (document?.provider === undefined ? [] : [document])
      if (routes.length === 0) throw new Error('no-route')
      return routes.map((route) => {
        if (!isRecord(route) || typeof route.provider !== 'string') throw new Error('bad-route')
        return recordOf(route.provider, route)
      })
    }

    /* ------------------------------------------------------------------ */
    /* Presentational pieces                                              */
    /* ------------------------------------------------------------------ */

    function Field({ label, children }) {
      return h('label', { className: 'dmsField' }, h('span', { className: 'dmsLabel' }, label), children)
    }

    function TextInput({ value, onChange, placeholder, disabled, ariaLabel }) {
      return h('input', {
        className: 'dmsInput', type: 'text', value: value ?? '', placeholder,
        disabled: disabled === true, 'aria-label': ariaLabel,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function SelectInput({ value, onChange, options, disabled, ariaLabel }) {
      return h('select', {
        className: 'dmsInput', value, disabled: disabled === true, 'aria-label': ariaLabel,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option.id, value: option.id }, option.label)))
    }

    function ModelRow({ model, disabled, onChange, onRemove, t }) {
      return h('div', { className: 'dmsModel' }, [
        h('div', { className: 'dmsModelRow', key: 'row' }, [
          h(TextInput, {
            key: 'id', value: model.id, disabled, ariaLabel: t('model.id'),
            placeholder: t('model.idPlaceholder'), onChange: (value) => onChange({ ...model, id: value }),
          }),
          h(TextInput, {
            key: 'name', value: model.name, disabled, ariaLabel: t('model.name'),
            placeholder: t('model.namePlaceholder'), onChange: (value) => onChange({ ...model, name: value }),
          }),
          h('button', {
            key: 'remove', type: 'button', className: 'dmsIcon', disabled,
            title: t('model.remove'), 'aria-label': t('model.remove'), onClick: onRemove,
          }, '✕'),
        ]),
        h('div', { className: 'dmsModelExtra', key: 'extra' }, [
          h(TextInput, {
            key: 'cw', value: model.contextWindow, disabled, ariaLabel: t('model.contextWindow'),
            placeholder: t('model.contextWindow'), onChange: (value) => onChange({ ...model, contextWindow: value }),
          }),
          h(TextInput, {
            key: 'mt', value: model.maxTokens, disabled, ariaLabel: t('model.maxTokens'),
            placeholder: t('model.maxTokens'), onChange: (value) => onChange({ ...model, maxTokens: value }),
          }),
        ]),
      ])
    }

    /* ------------------------------------------------------------------ */
    /* Section                                                            */
    /* ------------------------------------------------------------------ */

    /** One editable cloud field: text, password or a select. */
    function CloudField({ label, value, onChange, placeholder, type, options, disabled, hint }) {
      if (Array.isArray(options)) {
        return h(Field, { label }, h(SelectInput, {
          value: value ?? '', ariaLabel: label, disabled,
          options, onChange,
        }))
      }
      return h('label', { className: 'dmsField' }, [
        h('span', { className: 'dmsLabel', key: 'l' }, label),
        h('input', {
          key: 'i',
          className: 'dmsInput',
          type: type ?? 'text',
          value: value ?? '',
          placeholder: placeholder ?? '',
          'aria-label': label,
          disabled,
          autoComplete: 'off',
          onChange: (event) => onChange(event.target.value),
        }),
        hint === undefined ? null : h('span', { className: 'dmsHint', key: 'h' }, hint),
      ])
    }

    /**
     * Cloud sync panel.
     *
     * Reads the plugin's own settings namespace, so the backend, the bucket and
     * the secrets are ordinary DSH settings. Actions are posted as a `command`
     * value; the Host performs them and answers through `status`, which arrives
     * back here as a normal settings push.
     */
    function CloudPanel(props) {
      const { t, cloudForm } = props
      const [failure, setFailure] = React.useState(undefined)
      const [posting, setPosting] = React.useState(false)
      const [force, setForce] = React.useState(false)
      const [draft, setDraft] = React.useState(undefined)
      const [secretDraft, setSecretDraft] = React.useState({})
      const [polled, setPolled] = React.useState(0)

      const snapshot = React.useSyncExternalStore(
        (listener) => cloudForm.subscribe(listener),
        () => cloudForm.getSnapshot(),
      )
      const value = isRecord(snapshot.value) ? snapshot.value : {}
      const writable = snapshot.writable === true
      const busy = posting

      const status = readStatus(value.status)
      const working = typeof value.command === 'string' && value.command.length > 0

      // A command the Host never answers (no backend, a crashed run) must not
      // leave the page spinning forever.
      React.useEffect(() => {
        if (!working || cloudForm === undefined) return undefined
        const timer = setTimeout(() => setPolled((count) => count + 1), 15000)
        return () => clearTimeout(timer)
      }, [working, value.command, polled])

      const field = (key) => (draft !== undefined && draft[key] !== undefined ? draft[key] : value[key])
      const setField = (key) => (next) => setDraft({ ...(draft ?? {}), [key]: next })
      // the backend is read from the draft too, so choosing one reveals its
      // fields before the configuration is saved
      const backend = typeof field('backend') === 'string' ? field('backend') : ''

      const save = async () => {
        if (draft === undefined) return
        setPosting(true)
        setFailure(undefined)
        try {
          const ops = Object.entries(draft)
            .filter(([, next]) => next !== undefined)
            .map(([key, next]) => ({ op: 'set', path: [key], value: next }))
          const accepted = ops.length === 0 ? true : await cloudForm.mutate(ops)
          if (!accepted) setFailure(t('error.rejected'))
          else setDraft(undefined)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setPosting(false)
        }
      }

      const saveSecrets = async () => {
        const ops = Object.entries(secretDraft)
          .filter(([, next]) => typeof next === 'string' && next.length > 0)
          .map(([key, next]) => ({ op: 'set', path: [key], value: next }))
        if (ops.length === 0) return
        setPosting(true)
        setFailure(undefined)
        try {
          const accepted = await cloudForm.mutate(ops)
          if (!accepted) setFailure(t('error.rejected'))
          else setSecretDraft({})
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setPosting(false)
        }
      }

      const run = async (kind) => {
        setPosting(true)
        setFailure(undefined)
        try {
          const command = JSON.stringify({ id: `${kind}-${Date.now()}`, kind, force })
          const accepted = await cloudForm.mutate([{ op: 'set', path: ['command'], value: command }])
          if (!accepted) setFailure(t('error.rejected'))
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setPosting(false)
        }
      }

      const configured = backend === 's3' ? value.s3Bucket !== '' && value.s3Bucket !== undefined : backend === 'webdav' ? value.webdavBaseURL !== '' && value.webdavBaseURL !== undefined : false

      return h('div', { className: 'dmsPanel' }, [
        h('p', { className: 'dmsIntro', key: 'intro' }, t('cloud.intro')),
        failure === undefined ? null : h('p', { className: 'dmsNotice', key: 'f', role: 'alert' }, failure),
        writable ? null : h('p', { className: 'dmsNotice', key: 'ro' }, t('readonly')),

        h('div', { className: 'dmsCard', key: 'backend' }, [
          h('div', { className: 'dmsHead', key: 'h' }, h('span', { className: 'dmsName', key: 'n' }, t('cloud.backendTitle'))),
          h(CloudField, {
            key: 'kind',
            label: t('cloud.backend'),
            value: backend,
            disabled: !writable,
            options: [
              { id: '', label: t('cloud.backendOff') },
              { id: 's3', label: t('cloud.backendS3') },
              { id: 'webdav', label: t('cloud.backendWebdav') },
            ],
            onChange: setField('backend'),
          }),
          h('div', { className: 'dmsGrid', key: 'grid' }, [
            h(CloudField, { key: 'root', label: t('cloud.remoteRoot'), value: field('remoteRoot'), disabled: !writable, onChange: setField('remoteRoot') }),
            h(CloudField, { key: 'profile', label: t('cloud.profile'), value: field('profile'), disabled: !writable, onChange: setField('profile'), hint: t('cloud.profileHint') }),
          ]),
          backend === 's3' ? h('div', { className: 'dmsGrid', key: 's3' }, [
            h(CloudField, { key: 'bucket', label: t('cloud.s3Bucket'), value: field('s3Bucket'), disabled: !writable, onChange: setField('s3Bucket') }),
            h(CloudField, { key: 'region', label: t('cloud.s3Region'), value: field('s3Region'), disabled: !writable, onChange: setField('s3Region') }),
            h(CloudField, { key: 'endpoint', label: t('cloud.s3Endpoint'), value: field('s3Endpoint'), disabled: !writable, onChange: setField('s3Endpoint'), placeholder: 'https://<account>.r2.cloudflarestorage.com' }),
            h(CloudField, { key: 'key', label: t('cloud.s3AccessKeyId'), value: field('s3AccessKeyId'), disabled: !writable, onChange: setField('s3AccessKeyId') }),
          ]) : null,
          backend === 'webdav' ? h('div', { className: 'dmsGrid', key: 'dav' }, [
            h(CloudField, { key: 'url', label: t('cloud.webdavURL'), value: field('webdavBaseURL'), disabled: !writable, onChange: setField('webdavBaseURL'), placeholder: 'https://dav.example.com/remote.php/dav/files/me' }),
            h(CloudField, { key: 'user', label: t('cloud.webdavUser'), value: field('webdavUsername'), disabled: !writable, onChange: setField('webdavUsername') }),
          ]) : null,
          crypto_keys(backend, value, secretDraft, setSecretDraft, writable),
          h('div', { className: 'dmsRowActions', key: 'save' }, [
            h('button', { key: 'save', type: 'button', className: 'dmsPrimary', disabled: !writable || draft === undefined || busy, onClick: save }, draft === undefined ? t('cloud.saved') : t('cloud.saveConfig')),
            h('button', { key: 'secrets', type: 'button', className: 'dmsSecondary', disabled: !writable || Object.keys(secretDraft).length === 0 || busy, onClick: saveSecrets }, t('cloud.saveSecrets')),
          ]),
        ]),

        h('div', { className: 'dmsCard', key: 'actions' }, [
          h('div', { className: 'dmsHead', key: 'h' }, h('span', { className: 'dmsName', key: 'n' }, t('cloud.actionsTitle'))),
          h('p', { className: 'dmsHint', key: 'hint' }, t('cloud.actionsHint')),
          h('label', { className: 'dmsCheck', key: 'force' }, [
            h('input', { key: 'c', type: 'checkbox', checked: force, disabled: !writable, onChange: (event) => setForce(event.target.checked) }),
            h('span', { key: 's' }, t('cloud.force')),
          ]),
          h('label', { className: 'dmsCheck', key: 'autoSync' }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: field('autoSync') === true,
              disabled: !writable,
              onChange: (event) => setField('autoSync')(event.target.checked),
            }),
            h('span', { key: 's' }, t('cloud.autoSync')),
          ]),
          h('label', { className: 'dmsCheck', key: 'syncKeys' }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: field('syncCredentials') !== false,
              disabled: !writable,
              onChange: (event) => setField('syncCredentials')(event.target.checked),
            }),
            h('span', { key: 's' }, t('cloud.syncKeys')),
          ]),
          field('syncCredentials') === false
            ? h('p', { className: 'dmsHint', key: 'keysOff' }, t('cloud.syncKeysOff'))
            : h('p', { className: 'dmsWarn', key: 'plain' }, t('cloud.plaintext')),
          h('div', { className: 'dmsRowActions', key: 'buttons', style: { justifyContent: 'flex-start' } }, [
            h('button', { key: 'test', type: 'button', className: 'dmsSecondary', disabled: !writable || busy || working, onClick: () => run('test') }, t('cloud.test')),
            h('button', { key: 'push', type: 'button', className: 'dmsPrimary', disabled: !writable || busy || working || !configured, onClick: () => run('push') }, t('cloud.push')),
            h('button', { key: 'pull', type: 'button', className: 'dmsSecondary', disabled: !writable || busy || working || !configured, onClick: () => run('pull') }, t('cloud.pull')),
            h('button', { key: 'status', type: 'button', className: 'dmsSecondary', disabled: !writable || busy || working, onClick: () => run('status') }, t('cloud.refresh')),
          ]),
          configured ? null : h('p', { className: 'dmsHint', key: 'need' }, t('cloud.needBackend')),
        ]),

        h('div', { className: 'dmsCard', key: 'state' }, [
          h('div', { className: 'dmsHead', key: 'h' }, h('span', { className: 'dmsName', key: 'n' }, t('cloud.stateTitle'))),
          working ? h('p', { className: 'dmsSaved', key: 'w', role: 'status' }, t('cloud.working')) : null,
          status === undefined
            ? h('p', { className: 'dmsHint', key: 'none' }, t('cloud.neverSynced'))
            : h('div', { key: 'status' }, [
                h('p', { className: status.ok ? 'dmsSaved' : 'dmsNotice', key: 'm', role: 'status' }, status.message),
                h('p', { className: 'dmsHint', key: 'meta' }, status.at === undefined ? '' : `${t('cloud.lastRun')} ${status.at}${status.kind === undefined ? '' : ` · ${status.kind}`}`),
                status.credentials === undefined || status.credentials.length === 0
                  ? null
                  : h('p', { className: 'dmsHint', key: 'keys' }, `${t('cloud.keysTravelled')} ${status.credentials.join('、')}`),
                status.detailText === undefined ? null : h('pre', { className: 'dmsPre', key: 'd' }, status.detailText),
              ]),
        ]),
      ])
    }

    /** Secret inputs: write-only, with a "stored / not stored" hint. */
    function crypto_keys(backend, value, secretDraft, setSecretDraft, writable) {
      const entry = (key, label, configuredKey) => h('label', { className: 'dmsField', key }, [
        h('span', { className: 'dmsLabel', key: 'l' }, label),
        h('input', {
          key: 'i',
          className: 'dmsInput',
          type: 'password',
          value: secretDraft[key] ?? '',
          placeholder: value[configuredKey] === true ? '••••••••' : '',
          'aria-label': label,
          disabled: !writable,
          autoComplete: 'new-password',
          onChange: (event) => setSecretDraft({ ...secretDraft, [key]: event.target.value }),
        }),
        h('span', { className: 'dmsHint', key: 'h' }, value[configuredKey] === true ? '已保存（留空表示不修改）' : '尚未保存'),
      ])
      if (backend === 's3') return h('div', { className: 'dmsGrid', key: 'secrets' }, [entry('s3SecretAccessKey', 'Secret Access Key', 's3SecretConfigured')])
      if (backend === 'webdav') return h('div', { className: 'dmsGrid', key: 'secrets' }, [entry('webdavPassword', 'WebDAV 密码', 'webdavPasswordConfigured')])
      return null
    }

    function ModelSyncSection(props) {
      const { t, form, cloudForm } = props
      const [tab, setTab] = React.useState('local')
      const active = tab === 'cloud' && cloudForm !== undefined ? 'cloud' : 'local'
      const snapshot = React.useSyncExternalStore(
        (listener) => (form === undefined ? () => {} : form.subscribe(listener)),
        () => form?.getSnapshot() ?? { value: {}, writable: false },
      )
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [editing, setEditing] = React.useState(undefined)
      const [draft, setDraft] = React.useState(undefined)
      const [preview, setPreview] = React.useState(undefined)
      const fileInput = React.useRef(null)

      const value = isRecord(snapshot.value) ? snapshot.value : {}
      const providers = isRecord(value.providers) ? value.providers : {}
      const routes = Object.entries(providers).map(([route, profile]) => ({ ...recordOf(route, profile), syncable: syncable(profile) }))
      const writable = snapshot.writable === true
      const editable = writable && !busy

      const flash = (message) => { setNotice(message); setFailure(undefined) }

      /** Write the whole provider map through the shared form. */
      const writeProviders = async (next) => {
        setBusy(true)
        setFailure(undefined)
        setNotice(undefined)
        try {
          const accepted = await form.mutate([{ op: 'set', path: ['providers'], value: next }])
          if (!accepted) setFailure(t('error.rejected'))
          return accepted
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
          return false
        } finally {
          setBusy(false)
        }
      }

      const startEdit = (route) => {
        setFailure(undefined)
        setNotice(undefined)
        setEditing(route ? route.provider : '')
        setDraft(route
          ? { ...route, models: editableModels(route.models) }
          : { provider: '', displayName: '', api: 'openai-completions', baseURL: '', apiKeyEnv: '', models: editableModels([]) })
      }

      const saveCard = async () => {
        const isNew = editing === ''
        const problem = validate(draft, isNew)
        if (problem !== undefined) { setFailure(t(problem)); return }
        const route = String(draft.provider).trim()
        const next = { ...clone(providers), [route]: profileOf(draft, providers[route]) }
        if (await writeProviders(next)) {
          setEditing(undefined)
          setDraft(undefined)
          flash(t('savedCard', { route }))
        }
      }

      const removeCard = async (route) => {
        const next = clone(providers)
        delete next[route]
        if (await writeProviders(next)) flash(t('removedCard', { route }))
      }

      const exportDocument = () => JSON.stringify({
        format: 'dsh-model-key-sync/provider',
        version: 1,
        savedAt: new Date().toISOString(),
        routes: Object.entries(providers).filter(([, profile]) => syncable(profile)).map(([route, profile]) => recordOf(route, profile)),
      }, null, 2)

      const copyAll = async () => {
        try {
          await navigator.clipboard.writeText(exportDocument())
          flash(t('copied'))
        } catch {
          setPreview(exportDocument())
          setFailure(t('error.clipboard'))
        }
      }

      const downloadAll = () => {
        const text = exportDocument()
        try {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `dsh-models-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
          anchor.click()
          URL.revokeObjectURL(url)
          flash(t('downloaded'))
        } catch {
          setPreview(text)
        }
      }

      const importFile = async (file) => {
        if (file === undefined || file === null) return
        setBusy(true)
        setFailure(undefined)
        setNotice(undefined)
        try {
          const text = await file.text()
          let document
          try {
            document = JSON.parse(text)
          } catch {
            setFailure(t('error.notJson'))
            return
          }
          const incoming = routesOfDocument(document)
          const next = { ...clone(providers) }
          for (const record of incoming) next[record.provider] = profileOf({ ...record, models: editableModels(record.models) }, providers[record.provider])
          const accepted = await form.mutate([{ op: 'set', path: ['providers'], value: next }])
          if (accepted) flash(t('imported', { count: String(incoming.length) }))
          else setFailure(t('error.rejected'))
        } catch (error) {
          const code = error instanceof Error ? error.message : ''
          setFailure(code === 'no-route' || code === 'bad-route' ? t(`error.${code}`) : t('error.import'))
        } finally {
          setBusy(false)
          if (fileInput.current !== null) fileInput.current.value = ''
        }
      }

      const renderEditor = () => h('div', { className: 'dmsCard', key: 'editor' }, [
        h('div', { className: 'dmsHead', key: 'head' }, [
          h('span', { className: 'dmsName', key: 'n' }, editing === '' ? t('newRoute') : t('editing', { route: editing })),
          h('span', { className: 'dmsActions', key: 'cancel' }, h('button', {
            type: 'button', className: 'dmsSecondary', disabled: busy,
            onClick: () => { setEditing(undefined); setDraft(undefined); setFailure(undefined) },
          }, t('cancel'))),
        ]),
        h('div', { className: 'dmsGrid', key: 'identity' }, [
          h(Field, { key: 'route', label: t('field.route') }, h(TextInput, {
            value: draft.provider, disabled: editing !== '' || busy, ariaLabel: t('field.route'),
            placeholder: t('field.routePlaceholder'),
            onChange: (text) => setDraft({ ...draft, provider: text, apiKeyEnv: derivedKey(text) }),
          })),
          h(Field, { key: 'name', label: t('field.displayName') }, h(TextInput, {
            value: draft.displayName, disabled: busy, ariaLabel: t('field.displayName'),
            placeholder: t('field.displayNamePlaceholder'),
            onChange: (text) => setDraft({ ...draft, displayName: text }),
          })),
          h(Field, { key: 'url', label: t('field.baseURL') }, h(TextInput, {
            value: draft.baseURL, disabled: busy, ariaLabel: t('field.baseURL'),
            placeholder: t('field.baseURLPlaceholder'),
            onChange: (text) => setDraft({ ...draft, baseURL: text }),
          })),
          h(Field, { key: 'api', label: t('field.api') }, h(SelectInput, {
            value: draft.api, disabled: busy, ariaLabel: t('field.api'),
            options: PROTOCOLS.map((id) => ({ id, label: t(`api.${id}`) })),
            onChange: (text) => setDraft({ ...draft, api: text }),
          })),
          h(Field, { key: 'key', label: t('field.apiKeyEnv') }, h(TextInput, {
            value: draft.apiKeyEnv, disabled: busy, ariaLabel: t('field.apiKeyEnv'),
            placeholder: derivedKey(draft.provider || 'route'),
            onChange: (text) => setDraft({ ...draft, apiKeyEnv: text }),
          })),
        ]),
        h('p', { className: 'dmsIntro', key: 'hint' }, t('field.apiKeyEnvHint')),
        h('div', { className: 'dmsModels', key: 'models' }, [
          h('div', { className: 'dmsModelsHead', key: 'head' }, [
            h('span', { key: 'label', className: 'dmsLabel' }, t('field.models')),
            h('button', {
              key: 'add', type: 'button', className: 'dmsLink', disabled: busy,
              onClick: () => setDraft({ ...draft, models: [...draft.models, { id: '', name: '', contextWindow: '', maxTokens: '' }] }),
            }, t('addModel')),
          ]),
          ...draft.models.map((model, index) => h(ModelRow, {
            key: index, model, t, disabled: busy,
            onChange: (next) => setDraft({ ...draft, models: draft.models.map((row, at) => (at === index ? next : row)) }),
            onRemove: () => setDraft({ ...draft, models: draft.models.filter((_row, at) => at !== index) }),
          })),
        ]),
        h('div', { className: 'dmsRowActions', key: 'save' }, h('button', {
          type: 'button', className: 'dmsPrimary', disabled: busy, onClick: saveCard,
        }, busy ? t('saving') : t('saveCard'))),
      ])

      const renderCards = () => {
        if (routes.length === 0) return h('p', { className: 'dmsEmpty', key: 'empty' }, t('noRoutes'))
        return h('div', { className: 'dmsFiles', key: 'cards' }, routes.map((route) => h('div', { className: 'dmsCard', key: route.provider }, [
          h('div', { className: 'dmsHead', key: 'head' }, [
            h('span', { className: 'dmsIdentity', key: 'id' }, [
              h('span', { className: 'dmsName', key: 'n' }, route.displayName || route.provider),
              h('span', { className: 'dmsTag', key: 't' }, t('customTag')),
              h('span', { className: 'dmsMono', key: 'r' }, route.provider),
            ]),
            h('span', { className: 'dmsActions', key: 'a' }, [
              h('button', { key: 'e', type: 'button', className: 'dmsSecondary', disabled: !editable, onClick: () => startEdit(route) }, t('edit')),
              h('button', { key: 'r', type: 'button', className: 'dmsSecondary', disabled: !editable, onClick: () => removeCard(route.provider) }, t('remove')),
            ]),
          ]),
          h('div', { className: 'dmsMono', key: 'url' }, `${route.baseURL || t('unset')} · ${route.api} · ${t('modelCount', { count: String(route.models.length) })}`),
          h('div', { className: 'dmsRowActions', key: 'models', style: { flexWrap: 'wrap', justifyContent: 'flex-start' } },
            route.models.map((model) => h('span', { className: 'dmsTag', key: model.id }, model.name || model.id))),
          route.syncable ? null : h('p', { className: 'dmsNotice', key: 'warn' }, t('notSyncable')),
        ])))
      }

      const tabs = h('div', { className: 'dmsTabs', key: 'tabs', role: 'tablist' }, [
        h('button', {
          key: 'local', type: 'button', role: 'tab', 'aria-selected': active === 'local',
          className: active === 'local' ? 'dmsTab dmsTabActive' : 'dmsTab',
          onClick: () => setTab('local'),
        }, t('tab.local')),
        cloudForm === undefined ? null : h('button', {
          key: 'cloud', type: 'button', role: 'tab', 'aria-selected': active === 'cloud',
          className: active === 'cloud' ? 'dmsTab dmsTabActive' : 'dmsTab',
          onClick: () => setTab('cloud'),
        }, t('tab.cloud')),
      ])

      if (active === 'cloud') {
        return h('div', { className: 'dmsSection' }, [
          h('h2', { className: 'dmsTitle', key: 'title' }, t('title')),
          tabs,
          h(CloudPanel, { key: 'panel', t, cloudForm }),
        ])
      }

      return h('div', { className: 'dmsSection' }, [
        h('h2', { className: 'dmsTitle', key: 'title' }, t('title')),
        tabs,
        h('p', { className: 'dmsIntro', key: 'intro' }, t('intro')),
        failure === undefined ? null : h('p', { className: 'dmsNotice', key: 'failure', role: 'alert' }, failure),
        notice === undefined ? null : h('p', { className: 'dmsSaved', key: 'notice', role: 'status' }, notice),
        writable ? null : h('p', { className: 'dmsNotice', key: 'readonly' }, t('readonly')),
        h('div', { className: 'dmsRowActions', key: 'tools', style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
          h('button', { key: 'copy', type: 'button', className: 'dmsSecondary', onClick: copyAll }, t('copy')),
          h('button', { key: 'download', type: 'button', className: 'dmsSecondary', onClick: downloadAll }, t('download')),
          h('button', { key: 'import', type: 'button', className: 'dmsSecondary', disabled: !editable || busy, onClick: () => fileInput.current?.click() }, t('importFile')),
          h('input', {
            key: 'input', ref: fileInput, type: 'file', accept: 'application/json,.json',
            className: 'dmsVisuallyHidden', tabIndex: -1,
            onChange: (event) => importFile(event.target.files?.[0]),
          }),
          h('button', { key: 'preview', type: 'button', className: 'dmsSecondary', onClick: () => setPreview(preview === undefined ? exportDocument() : undefined) },
            preview === undefined ? t('preview') : t('hidePreview')),
          h('button', { key: 'add', type: 'button', className: 'dmsSecondary', disabled: !editable, onClick: () => startEdit(undefined) }, t('addRoute')),
        ]),
        preview === undefined ? null : h('pre', { className: 'dmsPre', key: 'pre' }, preview),
        editing === undefined ? null : renderEditor(),
        renderCards(),
      ])
    }

    const inject = ['slots', 'locale', 'configForms']

    /** Settings namespace of the plugin's own row (cloud settings + command). */
    const OWN_NS = 'model-key-sync'

    function apply(ctx) {
      const NS = 'dsh-model-key-sync'
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-sync: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = css
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'model-sync: styles')
      // `whileServed` ties this page to the namespace it edits: a deployment that
      // never composed the pi-ai row shows no trace of it.
      // The page shows up when either half is available: the provider editor
      // needs the model adapter's namespace, cloud sync needs the plugin's own.
      // `whileServed` would hide the page if one of them were missing, so the
      // two faces are resolved independently and the page degrades per tab.
      ctx.effect(() => ctx.configForms.whileServed([LLM_NS, OWN_NS], () => ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: 'model-key-sync',
          order: 12,
          label: () => t('nav'),
          inject: () => {
            const served = new Set((ctx.configForms.list?.() ?? []).map((entry) => entry?.ns ?? entry))
            return {
              t,
              form: served.has(LLM_NS) || served.size === 0 ? ctx.configForms.get(LLM_NS) : undefined,
              cloudForm: served.has(OWN_NS) || served.size === 0 ? ctx.configForms.get(OWN_NS) : undefined,
            }
          },
        }, ModelSyncSection))), 'model-sync: settings section')
    }

    const zh =   {
    "nav": "模型密钥同步",
    "title": "模型密钥同步",
    "intro": "本机配置：查看、编辑、导出与恢复自定义模型。云同步页签可把模型和 API 密钥上传，在另一台机器拉取。",
    "readonly": "当前配置为只读，无法写入。",
    "customTag": "自定义",
    "edit": "编辑",
    "remove": "移除",
    "cancel": "取消",
    "saving": "保存中…",
    "saveCard": "保存到配置",
    "editing": "编辑 {route}",
    "newRoute": "新的模型提供方",
    "addRoute": "+ 添加自定义模型",
    "addModel": "+ 添加模型",
    "copy": "复制 JSON",
    "download": "下载文件",
    "importFile": "从文件恢复",
    "preview": "查看 JSON",
    "hidePreview": "收起 JSON",
    "unset": "未填写端点",
    "modelCount": "{count} 个模型",
    "noRoutes": "这个 profile 还没有自定义模型。点击「添加自定义模型」创建，或从文件恢复。",
    "notSyncable": "这个路由缺少端点或模型清单，导出后无法在另一台机器上恢复。",
    "savedCard": "已保存 {route}",
    "removedCard": "已移除 {route}",
    "copied": "已复制到剪贴板",
    "downloaded": "已开始下载",
    "imported": "已导入 {count} 个模型提供方",
    "field.route": "路由名（配置文件中的键）",
    "field.routePlaceholder": "小写字母、数字、连字符，例如 mymodel",
    "field.displayName": "显示名称",
    "field.displayNamePlaceholder": "例如 我的模型",
    "field.baseURL": "API 端点",
    "field.baseURLPlaceholder": "https://example.com/v1",
    "field.api": "协议",
    "field.apiKeyEnv": "API 密钥引用名",
    "field.apiKeyEnvHint": "这里只保存密钥的引用名，密钥本身在「设置 → 模型」里填写。",
    "field.models": "模型清单",
    "model.id": "模型 ID",
    "model.idPlaceholder": "模型 ID，例如 deepseek-v4.1-flash",
    "model.name": "显示名称",
    "model.namePlaceholder": "显示名称（可留空）",
    "model.contextWindow": "上下文长度",
    "model.maxTokens": "最大输出",
    "model.remove": "删除这个模型",
    "api.openai-completions": "OpenAI Chat Completions",
    "api.openai-responses": "OpenAI Responses",
    "api.anthropic-messages": "Anthropic Messages",
    "error.route": "请填写路由名",
    "error.routeShape": "路由名只能使用小写字母、数字和连字符",
    "error.displayName": "请填写显示名称",
    "error.baseURL": "API 端点需要以 http:// 或 https:// 开头",
    "error.api": "请选择协议",
    "error.models": "至少需要一个带模型 ID 的模型",
    "error.rejected": "配置被拒绝，请检查填写内容",
    "error.clipboard": "浏览器不允许写剪贴板，已改为显示 JSON",
    "error.notJson": "文件内容不是合法的 JSON",
    "error.import": "无法从这个文件恢复：它不是模型同步的 JSON",
    "error.no-route": "文件里没有模型提供方",
    "error.bad-route": "文件里的模型提供方格式不正确",
    "tab.local": "本机配置",
    "tab.cloud": "云同步",
    "cloud.intro": "把本机已配置好的模型上传到云端，另一台机器拉取后即可使用。密钥只存在本机设置里，不上传、不回显。",
    "cloud.backendTitle": "云端存储",
    "cloud.backend": "存储类型",
    "cloud.backendOff": "关闭云同步",
    "cloud.backendS3": "S3 兼容（R2 / OSS / B2 / MinIO）",
    "cloud.backendWebdav": "WebDAV（坚果云 / Nextcloud）",
    "cloud.remoteRoot": "远端目录",
    "cloud.profile": "同步分组",
    "cloud.profileHint": "同一分组的机器共享一份配置",
    "cloud.s3Bucket": "桶名",
    "cloud.s3Region": "区域",
    "cloud.s3Endpoint": "Endpoint",
    "cloud.s3AccessKeyId": "Access Key ID",
    "cloud.webdavURL": "集合地址",
    "cloud.webdavUser": "用户名",
    "cloud.saveSecrets": "保存密钥",
    "cloud.saveConfig": "保存配置",
    "cloud.saved": "已保存",
    "cloud.actionsTitle": "上传与拉取",
    "cloud.actionsHint": "上传把本机模型配置写入云端；拉取把云端配置合并到本机。默认不覆盖冲突，勾选「强制覆盖」才覆盖。",
    "cloud.force": "强制覆盖（忽略冲突）",
    "cloud.test": "测试连接",
    "cloud.push": "上传到云端",
    "cloud.pull": "从云端拉取",
    "cloud.refresh": "刷新状态",
    "cloud.needBackend": "先选择存储类型并填写地址，再上传或拉取。",
    "cloud.stateTitle": "同步状态",
    "cloud.working": "处理中…（Host 正在执行）",
    "cloud.neverSynced": "还没有执行过同步。",
    "cloud.lastRun": "执行于",
  "cloud.plaintext": "API 密钥会随模型配置一起上传，并以明文存放在云端——任何能访问这个云盘的人都能读到。",
  "cloud.keysTravelled": "本次涉及的密钥：",
  "cloud.autoSync": "模型改动后自动上传",
  "cloud.syncKeys": "同时同步 API 密钥",
  "cloud.syncKeysOff": "当前不同步密钥：只上传模型声明，新机器仍需手动填 key。"
  }


    const en =   {
    "nav": "Model Key Sync",
    "title": "Model Key Sync",
    "intro": "Export and restore your custom models — display name, API endpoint, protocol and catalog. Copy them as JSON, download a file, or restore from one.",
    "readonly": "This configuration is read-only, so nothing can be written.",
    "customTag": "custom",
    "edit": "Edit",
    "remove": "Remove",
    "cancel": "Cancel",
    "saving": "Saving…",
    "saveCard": "Save to profile",
    "editing": "Editing {route}",
    "newRoute": "New provider route",
    "addRoute": "+ Add custom provider",
    "addModel": "+ Add model",
    "copy": "Copy JSON",
    "download": "Download file",
    "importFile": "Restore from file",
    "preview": "Show JSON",
    "hidePreview": "Hide JSON",
    "unset": "no endpoint set",
    "modelCount": "{count} models",
    "noRoutes": "This profile has no custom models yet. Add one, or restore from a file.",
    "notSyncable": "This route has no endpoint or no model catalog, so restoring it on another machine would not work.",
    "savedCard": "Saved {route}",
    "removedCard": "Removed {route}",
    "copied": "Copied to the clipboard",
    "downloaded": "Download started",
    "imported": "Imported {count} provider(s)",
    "field.route": "Route id (the config key)",
    "field.routePlaceholder": "lower-case letters, digits, hyphens, e.g. mymodel",
    "field.displayName": "Display name",
    "field.displayNamePlaceholder": "e.g. My Model",
    "field.baseURL": "API endpoint",
    "field.baseURLPlaceholder": "https://example.com/v1",
    "field.api": "Protocol",
    "field.apiKeyEnv": "API key reference",
    "field.apiKeyEnvHint": "Only the key reference is stored here; the key itself is entered under Settings → Models.",
    "field.models": "Model catalog",
    "model.id": "Model id",
    "model.idPlaceholder": "model id, e.g. deepseek-v4.1-flash",
    "model.name": "Display name",
    "model.namePlaceholder": "display name (optional)",
    "model.contextWindow": "Context window",
    "model.maxTokens": "Max output",
    "model.remove": "Remove this model",
    "api.openai-completions": "OpenAI Chat Completions",
    "api.openai-responses": "OpenAI Responses",
    "api.anthropic-messages": "Anthropic Messages",
    "error.route": "A route id is required",
    "error.routeShape": "A route id may use lower-case letters, digits and hyphens only",
    "error.displayName": "A display name is required",
    "error.baseURL": "The API endpoint must start with http:// or https://",
    "error.api": "Choose a protocol",
    "error.models": "At least one model with an id is required",
    "error.rejected": "The configuration was rejected; check the values",
    "error.clipboard": "The browser refused clipboard access, so the JSON is shown instead",
    "error.notJson": "That file is not valid JSON",
    "error.import": "This file cannot be restored: it is not a Model Sync JSON document",
    "error.no-route": "The file holds no provider route",
    "error.bad-route": "A provider route in the file is malformed",
    "tab.local": "This machine",
    "tab.cloud": "Cloud",
    "cloud.intro": "Upload the models configured here and pull them on another machine. Credentials stay in this machine's settings: they are never uploaded and never echoed back.",
    "cloud.backendTitle": "Cloud storage",
    "cloud.backend": "Backend",
    "cloud.backendOff": "Cloud sync off",
    "cloud.backendS3": "S3-compatible (R2 / OSS / B2 / MinIO)",
    "cloud.backendWebdav": "WebDAV (Nextcloud / nutstore)",
    "cloud.remoteRoot": "Remote directory",
    "cloud.profile": "Sync group",
    "cloud.profileHint": "Machines in the same group share one configuration",
    "cloud.s3Bucket": "Bucket",
    "cloud.s3Region": "Region",
    "cloud.s3Endpoint": "Endpoint",
    "cloud.s3AccessKeyId": "Access key id",
    "cloud.webdavURL": "Collection URL",
    "cloud.webdavUser": "User name",
    "cloud.saveSecrets": "Save credentials",
    "cloud.saveConfig": "Save configuration",
    "cloud.saved": "Saved",
    "cloud.actionsTitle": "Upload and pull",
    "cloud.actionsHint": "Upload writes this machine's models to the cloud; pull merges the cloud configuration here. Conflicts are refused unless you force them.",
    "cloud.force": "Force overwrite (ignore conflicts)",
    "cloud.test": "Test connection",
    "cloud.push": "Upload to cloud",
    "cloud.pull": "Pull from cloud",
    "cloud.refresh": "Refresh state",
    "cloud.needBackend": "Pick a backend and fill in its address before uploading or pulling.",
    "cloud.stateTitle": "Sync state",
    "cloud.working": "Working… (the Host is running it)",
    "cloud.neverSynced": "No sync has run yet.",
    "cloud.lastRun": "Ran at",
  "cloud.plaintext": "API keys travel with the model configuration and are stored in the remote as plaintext — anyone with access to that remote can read them.",
  "cloud.keysTravelled": "Credentials involved:",
  "cloud.autoSync": "Upload automatically after a model edit",
  "cloud.syncKeys": "Sync API keys too",
  "cloud.syncKeysOff": "Keys are excluded: only model declarations travel, so a new machine still needs its key entered."
  }


    return { inject, apply }
  },
})

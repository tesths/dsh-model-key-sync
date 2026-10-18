/**
 * Client half of the Model Sync bundle.
 *
 * Adds a "Model Sync" section to Settings. Every read goes through the shared
 * settings mirror (`ctx.configForms`) and the only write to the model profile is
 * a restore, which goes through the same shared form the Models page uses, so
 * this section can never disagree with the Models page about what it holds.
 *
 * One page, centred on cloud sync: the cloud panel edits this plugin's own
 * settings and posts an action for the Host to perform. A compact, read-only
 * summary of this machine's routes — endpoint and model count — sits beneath it
 * with just two escape hatches, export and restore, for users who do not want
 * cloud sync at all.
 *
 * How the cloud panel reaches the Host, and why not another way: a bundle
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

    /** Settings namespace of the pi-ai row whose `providers` this page reads. */
    const LLM_NS = 'llm-pi-ai'
    const STYLE_ID = 'dsh-model-key-sync/model-sync.css'
    const css = [
      '.dmsSection{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:10px;display:flex}',
      '.dmsTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dmsNotice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}',
      '.dmsWarn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-bg,transparent);border-radius:var(--dsw-radius-md);margin:0;font-size:12px;line-height:18px;padding:6px 8px}',
      '.dmsSaved{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}',
      '.dmsCard{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:8px;padding:10px 12px;display:flex}',
      '.dmsHead{align-items:center;gap:8px;display:flex;min-width:0}',
      '.dmsIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.dmsName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;white-space:nowrap}',
      '.dmsTag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}',
      '.dmsMono{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dmsActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex;flex:none}',
      '.dmsPrimary{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:30px;font:inherit;cursor:pointer;border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);justify-content:center;align-items:center;gap:4px;padding:0 12px;font-size:13px;line-height:20px;display:inline-flex;white-space:nowrap}',
      '.dmsPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dmsSecondary{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);height:30px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;justify-content:center;align-items:center;gap:4px;padding:0 12px;font-size:13px;line-height:20px;display:inline-flex;white-space:nowrap}',
      '.dmsSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dmsActions .dmsPrimary,.dmsActions .dmsSecondary{height:26px;padding:0 9px;font-size:12px;line-height:18px}',
      '.dmsPrimary:disabled,.dmsSecondary:disabled{opacity:.4;cursor:default}',
      '.dmsPanel{flex-direction:column;gap:8px;display:flex}',
      '.dmsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 10px}',
      '.dmsInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;height:30px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 9px;font-size:13px;line-height:20px}',
      '.dmsInput:disabled{opacity:.5}',
      '.dmsInput:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
      '.dmsSelectInline{flex:1 1 160px;max-width:240px;min-width:0}',
      '.dmsHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:16px}',
      '.dmsCheck{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dmsCheck input{width:14px;height:14px;margin:0;flex:none}',
      '.dmsChecks{display:flex;align-items:center;gap:14px;flex-wrap:nowrap}',
      '.dmsField{flex-direction:column;gap:4px;min-width:0;display:flex}',
      '.dmsLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;align-items:center;gap:6px;display:flex;min-width:0}',
      '.dmsLocalList{flex-direction:column;gap:2px;display:flex}',
      '.dmsLocalRow{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) auto;align-items:center;gap:8px;display:grid;padding:2px 0}',
      '.dmsLocalName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dmsStatusLine{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dmsDetails{min-width:0}',
      '.dmsDetails summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dmsPre{margin:6px 0 0;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;max-height:180px;overflow:auto;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dmsVisuallyHidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    ].join('')

    /** Stable snapshot for a deployment that does not serve the pi-ai namespace. */
    const EMPTY_SNAPSHOT = Object.freeze({ status: 'ready', value: Object.freeze({}), writable: false })

    const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))
    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const derivedKey = (route) => `${String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
    /** Provider fields whose values are carried alongside the route. */
    const ROUTE_FIELDS = ['defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'reasoning', 'cacheRetention', 'thinkingBudgets']

    /** A snapshot record of one live provider profile: only the fields this page owns. */
    function recordOf(route, profile) {
      const record = {
        provider: route,
        displayName: typeof profile?.displayName === 'string' ? profile.displayName : route,
        api: typeof profile?.api === 'string' ? profile.api : 'openai-completions',
        baseURL: typeof profile?.baseURL === 'string' ? profile.baseURL : '',
        apiKeyEnv: typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0 ? profile.apiKeyEnv : derivedKey(route),
        models: Array.isArray(profile?.models) ? clone(profile.models) : [],
      }
      for (const field of ROUTE_FIELDS) {
        if (profile?.[field] !== undefined) record[field] = clone(profile[field])
      }
      return record
    }

    /** Whether a live profile can travel: without a catalog and endpoint it cannot be restored elsewhere. */
    const syncable = (profile) => isRecord(profile)
      && Array.isArray(profile.models) && profile.models.length > 0
      && typeof profile.baseURL === 'string' && /^https?:\/\//i.test(profile.baseURL)

    /** Model rows normalized for restoration: numbers become strings while they pass through. */
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

    /** Build the profile fields this page owns from a restored record. */
    function profileOf(card, current) {
      const base = isRecord(current) ? clone(current) : {}
      for (const field of ['displayName', 'api', 'baseURL', 'models', 'apiKeyEnv']) delete base[field]
      const profile = {
        ...base,
        displayName: String(card.displayName).trim() || card.provider,
        api: card.api,
        baseURL: String(card.baseURL).trim(),
        models: committedModels(card.models),
        apiKeyEnv: String(card.apiKeyEnv ?? '').trim() || derivedKey(card.provider),
      }
      // Carry the provider-level values the route owns. A file that predates
      // them leaves the current values in place, so restore never deletes data
      // merely because the export did not know about it.
      for (const field of ROUTE_FIELDS) {
        if (card[field] !== undefined) profile[field] = clone(card[field])
      }
      return profile
    }

    /**
     * Parse the JSON status the Host writes back into the settings namespace.
     * @param {unknown} raw - the stored string.
     * @returns {{ ok?: boolean, message?: string, at?: string, kind?: string, credentials?: string[], detailText?: string } | undefined} the status.
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

    /** Normalize a pasted or downloaded document into route records. */
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

    function SelectInput({ value, onChange, options, disabled, ariaLabel, className }) {
      return h('select', {
        className: className === undefined ? 'dmsInput' : `dmsInput ${className}`,
        value, disabled: disabled === true, 'aria-label': ariaLabel,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option.id, value: option.id }, option.label)))
    }

    /* ------------------------------------------------------------------ */
    /* Section                                                            */
    /* ------------------------------------------------------------------ */

    /** One cloud field: text or a select. Secrets use SecretField. */
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

    /** A write-only secret field: the stored value is never echoed back. */
    function SecretField({ label, stored, value, onChange, disabled, t }) {
      return h('label', { className: 'dmsField' }, [
        h('span', { className: 'dmsLabel', key: 'l' }, [
          h('span', { key: 'n' }, label),
          stored ? h('span', { className: 'dmsTag', key: 's' }, t('cloud.stored')) : null,
        ]),
        h('input', {
          key: 'i',
          className: 'dmsInput',
          type: 'password',
          value: value ?? '',
          placeholder: stored ? '••••••••' : '',
          'aria-label': label,
          disabled,
          autoComplete: 'new-password',
          title: stored ? t('cloud.secretStoredHint') : undefined,
          onChange: (event) => onChange(event.target.value),
        }),
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
      const [stalled, setStalled] = React.useState(false)

      const snapshot = React.useSyncExternalStore(
        (listener) => cloudForm.subscribe(listener),
        () => cloudForm.getSnapshot(),
      )
      const value = isRecord(snapshot.value) ? snapshot.value : {}
      const writable = snapshot.writable === true
      const busy = posting

      const status = readStatus(value.status)
      const working = typeof value.command === 'string' && value.command.length > 0
      const pending = working && !stalled

      // A command the Host never answers (no backend, a crashed run) must not
      // leave the page locked forever. After the timeout the buttons unlock and
      // the failure line explains what happened; a late answer still renders.
      React.useEffect(() => {
        if (!working) {
          setStalled(false)
          setFailure((current) => (current === t('cloud.timeout') ? undefined : current))
          return undefined
        }
        if (stalled) return undefined
        const timer = setTimeout(() => {
          setStalled(true)
          setFailure(t('cloud.timeout'))
        }, 15000)
        return () => clearTimeout(timer)
      }, [working, value.command, stalled])

      const field = (key) => (draft !== undefined && draft[key] !== undefined ? draft[key] : value[key])
      const setField = (key) => (next) => setDraft({ ...(draft ?? {}), [key]: next })
      // the backend is read from the draft too, so choosing one reveals its
      // fields before the configuration is saved
      const backend = typeof field('backend') === 'string' ? field('backend') : ''

      /** The pending field and secret writes, in one reusable list. */
      const pendingOps = () => {
        const ops = []
        for (const [key, next] of Object.entries(draft ?? {})) {
          if (next !== undefined) ops.push({ op: 'set', path: [key], value: next })
        }
        const secretKey = backend === 's3' ? 's3SecretAccessKey' : backend === 'webdav' ? 'webdavPassword' : undefined
        for (const [key, next] of Object.entries(secretDraft)) {
          if (key === secretKey && typeof next === 'string' && next.length > 0) ops.push({ op: 'set', path: [key], value: next })
        }
        return ops
      }

      const dirty = pendingOps().length > 0

      /** Save the visible configuration and any newly typed secret in one write. */
      const save = async () => {
        const ops = pendingOps()
        if (ops.length === 0) return
        setPosting(true)
        setFailure(undefined)
        try {
          const accepted = await cloudForm.mutate(ops)
          if (!accepted) setFailure(t('error.rejected'))
          else {
            setDraft(undefined)
            setSecretDraft({})
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setPosting(false)
        }
      }

      /**
       * Run an action. Pending edits are written in the same mutation as the
       * command, so the Host can never act on values older than what the page
       * shows — unchecking "sync keys" and pressing Upload cannot upload keys.
       */
      const run = async (kind) => {
        const command = JSON.stringify({ id: `${kind}-${Date.now()}`, kind, force })
        const ops = [...pendingOps(), { op: 'set', path: ['command'], value: command }]
        setPosting(true)
        setFailure(undefined)
        try {
          const accepted = await cloudForm.mutate(ops)
          if (!accepted) setFailure(t('error.rejected'))
          else {
            setStalled(false)
            setDraft(undefined)
            setSecretDraft({})
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setPosting(false)
        }
      }

      const configured = backend === 's3'
        ? typeof value.s3Bucket === 'string' && value.s3Bucket.length > 0
        : backend === 'webdav' ? typeof value.webdavBaseURL === 'string' && value.webdavBaseURL.length > 0 : false
      const lock = !writable || busy || pending
      const kindText = status?.kind === undefined ? '' : (['push', 'pull', 'test'].includes(status.kind) ? t(`cloud.kind.${status.kind}`) : status.kind)

      const checks = h('div', { className: 'dmsChecks', key: 'checks' }, [
        h('label', { className: 'dmsCheck', key: 'force', title: t('cloud.forceHint') }, [
          h('input', { key: 'c', type: 'checkbox', checked: force, disabled: !writable, onChange: (event) => setForce(event.target.checked) }),
          h('span', { key: 's' }, t('cloud.force')),
        ]),
        h('label', { className: 'dmsCheck', key: 'autoSync', title: t('cloud.autoSyncHint') }, [
          h('input', {
            key: 'c',
            type: 'checkbox',
            checked: field('autoSync') === true,
            disabled: !writable,
            onChange: (event) => setField('autoSync')(event.target.checked),
          }),
          h('span', { key: 's' }, t('cloud.autoSync')),
        ]),
        h('label', { className: 'dmsCheck', key: 'syncKeys', title: t('cloud.syncKeysHint') }, [
          h('input', {
            key: 'c',
            type: 'checkbox',
            checked: field('syncCredentials') !== false,
            disabled: !writable,
            onChange: (event) => setField('syncCredentials')(event.target.checked),
          }),
          h('span', { key: 's' }, t('cloud.syncKeys')),
        ]),
      ])

      const actions = h('div', { className: 'dmsHead', key: 'actions' }, [
        h('span', { className: 'dmsName', key: 'n' }, t('cloud.actionsTitle')),
        h('span', { className: 'dmsActions', key: 'a' }, [
          h('button', { key: 'test', type: 'button', className: 'dmsSecondary', disabled: lock, onClick: () => run('test') }, t('cloud.test')),
          h('button', { key: 'push', type: 'button', className: 'dmsPrimary', disabled: lock || !configured, onClick: () => run('push') }, t('cloud.push')),
          h('button', { key: 'pull', type: 'button', className: 'dmsSecondary', disabled: lock || !configured, onClick: () => run('pull') }, t('cloud.pull')),
        ]),
      ])

      return h('div', { className: 'dmsPanel' }, [
        failure === undefined ? null : h('p', { className: 'dmsNotice', key: 'f', role: 'alert' }, failure),
        writable ? null : h('p', { className: 'dmsNotice', key: 'ro' }, t('readonly')),

        h('div', { className: 'dmsCard', key: 'backend' }, [
          h('div', { className: 'dmsHead', key: 'h' }, [
            h('span', { className: 'dmsName', key: 'n' }, t('cloud.backendTitle')),
            h(SelectInput, {
              key: 'kind',
              className: 'dmsSelectInline',
              value: backend,
              disabled: !writable,
              ariaLabel: t('cloud.backend'),
              options: [
                { id: '', label: t('cloud.backendOff') },
                { id: 's3', label: t('cloud.backendS3') },
                { id: 'webdav', label: t('cloud.backendWebdav') },
              ],
              onChange: setField('backend'),
            }),
            h('span', { className: 'dmsActions', key: 'save' }, h('button', {
              key: 'save', type: 'button', className: 'dmsPrimary', disabled: !writable || !dirty || busy,
              title: t('cloud.saveHint'), onClick: save,
            }, t('cloud.saveConfig'))),
          ]),
          backend === '' ? null : h('div', { className: 'dmsGrid', key: 'grid' }, [
            h(CloudField, { key: 'root', label: t('cloud.remoteRoot'), value: field('remoteRoot'), disabled: !writable, onChange: setField('remoteRoot') }),
            h(CloudField, { key: 'profile', label: t('cloud.profile'), value: field('profile'), disabled: !writable, onChange: setField('profile') }),
            backend === 's3' ? h(CloudField, { key: 'bucket', label: t('cloud.s3Bucket'), value: field('s3Bucket'), disabled: !writable, onChange: setField('s3Bucket') }) : null,
            backend === 's3' ? h(CloudField, { key: 'region', label: t('cloud.s3Region'), value: field('s3Region'), disabled: !writable, onChange: setField('s3Region') }) : null,
            backend === 's3' ? h(CloudField, { key: 'endpoint', label: t('cloud.s3Endpoint'), value: field('s3Endpoint'), disabled: !writable, onChange: setField('s3Endpoint'), placeholder: 'https://<account>.r2.cloudflarestorage.com' }) : null,
            backend === 's3' ? h(CloudField, { key: 'key', label: t('cloud.s3AccessKeyId'), value: field('s3AccessKeyId'), disabled: !writable, onChange: setField('s3AccessKeyId') }) : null,
            backend === 's3' ? h(SecretField, {
              key: 'secret', t, label: t('cloud.s3Secret'), stored: value.s3SecretConfigured === true,
              value: secretDraft.s3SecretAccessKey ?? '', disabled: !writable,
              onChange: (next) => setSecretDraft({ ...secretDraft, s3SecretAccessKey: next }),
            }) : null,
            backend === 'webdav' ? h(CloudField, { key: 'url', label: t('cloud.webdavURL'), value: field('webdavBaseURL'), disabled: !writable, onChange: setField('webdavBaseURL'), placeholder: 'https://dav.example.com/remote.php/dav/files/me' }) : null,
            backend === 'webdav' ? h(CloudField, { key: 'user', label: t('cloud.webdavUser'), value: field('webdavUsername'), disabled: !writable, onChange: setField('webdavUsername') }) : null,
            backend === 'webdav' ? h(SecretField, {
              key: 'secret', t, label: t('cloud.webdavPassword'), stored: value.webdavPasswordConfigured === true,
              value: secretDraft.webdavPassword ?? '', disabled: !writable,
              onChange: (next) => setSecretDraft({ ...secretDraft, webdavPassword: next }),
            }) : null,
          ]),
        ]),

        h('div', { className: 'dmsCard', key: 'actions' }, [
          actions,
          checks,
          field('syncCredentials') === false
            ? h('p', { className: 'dmsHint', key: 'keysOff' }, t('cloud.syncKeysOff'))
            : h('p', { className: 'dmsWarn', key: 'plain' }, t('cloud.plaintext')),
          configured ? null : h('p', { className: 'dmsHint', key: 'need' }, t('cloud.needBackend')),
        ]),

        h('div', { className: 'dmsCard', key: 'state' }, [
          h('div', { className: 'dmsHead', key: 'h' }, [
            h('span', { className: 'dmsName', key: 'n' }, t('cloud.stateTitle')),
            working && !stalled ? h('span', { className: 'dmsActions', key: 'w' }, h('span', { className: 'dmsSaved', key: 's', role: 'status' }, t('cloud.working'))) : null,
          ]),
          status === undefined
            ? h('p', { className: 'dmsHint', key: 'none' }, t('cloud.neverSynced'))
            : h('div', { className: 'dmsStatusLine', key: 'status' }, [
                h('span', { className: status.ok ? 'dmsSaved' : 'dmsNotice', key: 'm', role: 'status' }, status.message),
                status.at === undefined ? null : h('span', { className: 'dmsHint', key: 'meta' }, `${t('cloud.lastRun')} ${status.at}${kindText.length === 0 ? '' : ` · ${kindText}`}`),
              ]),
          status !== undefined && status.credentials !== undefined && status.credentials.length > 0
            ? h('p', { className: 'dmsHint', key: 'keys' }, `${t('cloud.keysTravelled')} ${status.credentials.join(t('listSeparator'))}`)
            : null,
          status !== undefined && status.detailText !== undefined
            ? h('details', { className: 'dmsDetails', key: 'd' }, [
                h('summary', { key: 's' }, t('cloud.details')),
                h('pre', { className: 'dmsPre', key: 'p' }, status.detailText),
              ])
            : null,
        ]),
      ])
    }

    function ModelSyncSection(props) {
      const { t, form, cloudForm } = props
      const snapshot = React.useSyncExternalStore(
        (listener) => (form === undefined ? () => {} : form.subscribe(listener)),
        () => form?.getSnapshot() ?? EMPTY_SNAPSHOT,
      )
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const fileInput = React.useRef(null)

      const value = isRecord(snapshot.value) ? snapshot.value : {}
      const providers = isRecord(value.providers) ? value.providers : {}
      const routes = Object.entries(providers).map(([route, profile]) => ({ ...recordOf(route, profile), syncable: syncable(profile) }))
      const writable = snapshot.writable === true
      const editable = writable && !busy && form !== undefined

      const flash = (message) => { setNotice(message); setFailure(undefined) }

      /** The exported document: only routes that can be restored elsewhere. */
      const exportDocument = () => JSON.stringify({
        format: 'dsh-model-key-sync/provider',
        version: 1,
        savedAt: new Date().toISOString(),
        routes: Object.entries(providers).filter(([, profile]) => syncable(profile)).map(([route, profile]) => recordOf(route, profile)),
      }, null, 2)

      const downloadAll = () => {
        const text = exportDocument()
        setFailure(undefined)
        setNotice(undefined)
        try {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `dsh-models-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
          anchor.click()
          URL.revokeObjectURL(url)
          flash(t('downloaded'))
        } catch {
          setFailure(t('error.download'))
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

      /** One read-only row per route: name, endpoint and how many models it carries. */
      const localRow = (route) => h('div', { className: 'dmsLocalRow', key: route.provider, title: route.provider }, [
        h('span', { className: 'dmsLocalName', key: 'n' }, route.displayName || route.provider),
        h('span', { className: 'dmsMono', key: 'u', title: route.baseURL || undefined }, route.baseURL || t('unset')),
        h('span', { className: 'dmsTag', key: 'c' }, t(route.models.length === 1 ? 'modelCountOne' : 'modelCount', { count: String(route.models.length) })),
      ])

      const local = h('div', { className: 'dmsCard', key: 'local' }, [
        h('div', { className: 'dmsHead', key: 'head' }, [
          h('span', { className: 'dmsIdentity', key: 'id' }, [
            h('span', { className: 'dmsName', key: 'n' }, t('local.title')),
            h('span', { className: 'dmsTag', key: 't' }, t('local.readonly')),
          ]),
          h('span', { className: 'dmsActions', key: 'a' }, [
            h('button', {
              key: 'export', type: 'button', className: 'dmsSecondary', disabled: busy,
              title: t('local.exportHint'), onClick: downloadAll,
            }, t('local.export')),
            h('button', {
              key: 'restore', type: 'button', className: 'dmsSecondary', disabled: !editable,
              title: t('local.restoreHint'), onClick: () => fileInput.current?.click(),
            }, t('local.restore')),
            h('input', {
              key: 'input', ref: fileInput, type: 'file', accept: 'application/json,.json',
              className: 'dmsVisuallyHidden', tabIndex: -1,
              onChange: (event) => importFile(event.target.files?.[0]),
            }),
          ]),
        ]),
        routes.length === 0
          ? h('p', { className: 'dmsHint', key: 'empty' }, t('local.empty'))
          : h('div', { className: 'dmsLocalList', key: 'list' }, routes.map(localRow)),
        routes.some((route) => !route.syncable) ? h('p', { className: 'dmsHint', key: 'skip' }, t('local.skippedHint')) : null,
        failure === undefined ? null : h('p', { className: 'dmsNotice', key: 'failure', role: 'alert' }, failure),
        notice === undefined ? null : h('p', { className: 'dmsSaved', key: 'notice', role: 'status' }, notice),
      ])

      return h('div', { className: 'dmsSection' }, [
        h('h2', { className: 'dmsTitle', key: 'title' }, t('title')),
        cloudForm === undefined
          ? h('p', { className: 'dmsNotice', key: 'unavailable' }, t('cloud.unavailable'))
          : h(CloudPanel, { key: 'cloud', t, cloudForm }),
        local,
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
      // `whileServed` registers when any listed namespace is served and hands
      // the served set to the callback. Resolve each half from that set, so a
      // deployment serving only one namespace still shows the half it can
      // render instead of an empty page or a dead cloud section.
      ctx.effect(() => ctx.configForms.whileServed([LLM_NS, OWN_NS], (servedNamespaces) => {
        const served = servedNamespaces instanceof Set
          ? servedNamespaces
          : new Set(Array.isArray(servedNamespaces) ? servedNamespaces : [])
        return ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-key-sync',
          order: 12,
          label: () => t('nav'),
          inject: () => {
            const has = (ns) => served.size === 0 || served.has(ns)
            return {
              t,
              form: has(LLM_NS) ? ctx.configForms.get(LLM_NS) : undefined,
              cloudForm: has(OWN_NS) ? ctx.configForms.get(OWN_NS) : undefined,
            }
          },
        }, ModelSyncSection))
      }), 'model-sync: settings section')
    }

    const zh = {
      "nav": "模型密钥同步",
      "title": "模型密钥同步",
      "readonly": "当前配置为只读。",
      "downloaded": "已开始下载",
      "imported": "已导入 {count} 个模型提供方",
      "unset": "未填写端点",
      "modelCount": "{count} 个模型",
      "modelCountOne": "{count} 个模型",
      "listSeparator": "、",
      "error.rejected": "配置被拒绝，请检查填写内容",
      "error.download": "浏览器不允许下载，请检查权限",
      "error.notJson": "文件内容不是合法的 JSON",
      "error.import": "无法从这个文件恢复：它不是模型同步的 JSON",
      "error.no-route": "文件里没有模型提供方",
      "error.bad-route": "文件里的模型提供方格式不正确",
      "local.title": "本机配置",
      "local.readonly": "只读",
      "local.empty": "还没有自定义模型。",
      "local.export": "导出",
      "local.exportHint": "下载本机模型声明为 JSON 文件",
      "local.restore": "恢复",
      "local.restoreHint": "从 JSON 文件恢复模型声明",
      "local.skippedHint": "未填写端点或没有模型的条目不会导出。",
      "cloud.backendTitle": "云端存储",
      "cloud.backend": "存储类型",
      "cloud.backendOff": "关闭云同步",
      "cloud.backendS3": "S3 兼容（R2 / OSS / B2 / MinIO）",
      "cloud.backendWebdav": "WebDAV（坚果云 / Nextcloud）",
      "cloud.remoteRoot": "远端目录",
      "cloud.profile": "同步分组",
      "cloud.s3Bucket": "桶名",
      "cloud.s3Region": "区域",
      "cloud.s3Endpoint": "Endpoint",
      "cloud.s3AccessKeyId": "Access Key ID",
      "cloud.s3Secret": "Secret Access Key",
      "cloud.webdavURL": "集合地址",
      "cloud.webdavUser": "用户名",
      "cloud.webdavPassword": "WebDAV 密码",
      "cloud.saveConfig": "保存",
      "cloud.saveHint": "保存云端配置和新填写的密钥",
      "cloud.actionsTitle": "上传与拉取",
      "cloud.force": "强制覆盖",
      "cloud.forceHint": "忽略云端冲突，用本机覆盖",
      "cloud.autoSync": "自动上传",
      "cloud.autoSyncHint": "模型改动后自动上传（拉取不会触发）",
      "cloud.syncKeys": "同步密钥",
      "cloud.syncKeysHint": "同时上传和恢复 API 密钥",
      "cloud.test": "测试连接",
      "cloud.push": "上传到云端",
      "cloud.pull": "从云端拉取",
      "cloud.needBackend": "先选择存储类型并填写连接信息。",
      "cloud.stateTitle": "同步状态",
      "cloud.working": "处理中…",
      "cloud.neverSynced": "还没有执行过同步。",
      "cloud.lastRun": "执行于",
      "cloud.plaintext": "API 密钥会以明文存放在云端。",
      "cloud.keysTravelled": "本次涉及的密钥：",
      "cloud.syncKeysOff": "不同步密钥：只上传模型声明。",
      "cloud.details": "详情",
      "cloud.stored": "已保存",
      "cloud.secretStoredHint": "已保存，留空表示不修改",
      "cloud.unavailable": "当前部署没有提供云同步设置。",
      "cloud.timeout": "等待 Host 响应超时，可以重试。",
      "cloud.kind.push": "上传",
      "cloud.kind.pull": "拉取",
      "cloud.kind.test": "测试",
    }

    const en = {
      "nav": "Model Key Sync",
      "title": "Model Key Sync",
      "readonly": "This configuration is read-only.",
      "downloaded": "Download started",
      "imported": "Imported {count} provider(s)",
      "unset": "no endpoint set",
      "modelCount": "{count} models",
      "modelCountOne": "{count} model",
      "listSeparator": ", ",
      "error.rejected": "The configuration was rejected; check the values",
      "error.download": "The browser refused the download",
      "error.notJson": "That file is not valid JSON",
      "error.import": "This file cannot be restored: it is not a Model Sync JSON document",
      "error.no-route": "The file holds no provider route",
      "error.bad-route": "A provider route in the file is malformed",
      "local.title": "This machine",
      "local.readonly": "read-only",
      "local.empty": "No custom models yet.",
      "local.export": "Export",
      "local.exportHint": "Download this machine's model declarations as a JSON file",
      "local.restore": "Restore",
      "local.restoreHint": "Restore model declarations from a JSON file",
      "local.skippedHint": "Routes without an endpoint or models are skipped when exporting.",
      "cloud.backendTitle": "Cloud storage",
      "cloud.backend": "Backend",
      "cloud.backendOff": "Cloud sync off",
      "cloud.backendS3": "S3-compatible (R2 / OSS / B2 / MinIO)",
      "cloud.backendWebdav": "WebDAV (Nextcloud / nutstore)",
      "cloud.remoteRoot": "Remote directory",
      "cloud.profile": "Sync group",
      "cloud.s3Bucket": "Bucket",
      "cloud.s3Region": "Region",
      "cloud.s3Endpoint": "Endpoint",
      "cloud.s3AccessKeyId": "Access key id",
      "cloud.s3Secret": "Secret Access Key",
      "cloud.webdavURL": "Collection URL",
      "cloud.webdavUser": "User name",
      "cloud.webdavPassword": "WebDAV password",
      "cloud.saveConfig": "Save",
      "cloud.saveHint": "Save cloud settings and any newly typed secret",
      "cloud.actionsTitle": "Upload and pull",
      "cloud.force": "Force",
      "cloud.forceHint": "Ignore cloud conflicts and overwrite with this machine",
      "cloud.autoSync": "Auto upload",
      "cloud.autoSyncHint": "Upload after a model change; a pull never triggers an upload",
      "cloud.syncKeys": "Sync keys",
      "cloud.syncKeysHint": "Upload and restore API keys too",
      "cloud.test": "Test",
      "cloud.push": "Upload",
      "cloud.pull": "Pull",
      "cloud.needBackend": "Choose a backend and fill in its connection details first.",
      "cloud.stateTitle": "Sync state",
      "cloud.working": "Working…",
      "cloud.neverSynced": "No sync has run yet.",
      "cloud.lastRun": "Ran at",
      "cloud.plaintext": "API keys are stored in the cloud as plaintext.",
      "cloud.keysTravelled": "Credentials involved:",
      "cloud.syncKeysOff": "Keys are excluded: only model declarations travel.",
      "cloud.details": "Details",
      "cloud.stored": "Stored",
      "cloud.secretStoredHint": "Stored; leave blank to keep it",
      "cloud.unavailable": "Cloud sync is not available in this deployment.",
      "cloud.timeout": "Timed out waiting for the Host; you can retry.",
      "cloud.kind.push": "Upload",
      "cloud.kind.pull": "Pull",
      "cloud.kind.test": "Test",
    }


    return { inject, apply }
  },
})

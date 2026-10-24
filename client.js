/** AI Gateway: settings page — saved gateways, add/edit with a built-in connection check. */
window.__ModuleLoader__.load({
  id: 'dsh-ai-gateway-provider',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useId, useSyncExternalStore } = React;
    const NS = 'ai-gateway-ui';

    const ZH = {
      nav: 'AI 网关', title: 'AI 网关', subtitle: '接入任意 OpenAI 兼容网关，保存后它的模型会出现在对话的模型选择器里。',
      add: '添加网关', refresh: '刷新', refreshing: '刷新中…',
      emptyTitle: '还没有网关', emptyBody: '填入网关地址和令牌，检查通过后保存，就能在对话里使用它的模型。',
      howTitle: '怎么使用', how1: '添加网关：填地址和令牌，点「检查连接」。', how2: '检查通过后点「保存」，令牌只存进 DSH 凭据库。', how3: '在对话的模型选择器里选「{0}」下的模型即可。',
      active: '使用中', setActive: '设为使用中', edit: '编辑', remove: '删除', confirmRemove: '确认删除', cancel: '取消',
      models: '{0} 个模型', backendUnknown: '通用 OpenAI 兼容', quota: '额度', quotaNone: '这个网关没有额度接口', quotaPending: '读取中…',
      quotaError: '额度读取失败', unlimited: '不限额', remaining: '剩余', used: '已用', account: '账户', noKey: '令牌缺失，请编辑后重新填写',
      inPicker: '对话中可选的模型', inPickerHint: '在对话的模型选择器里找「{0}」。', otherModels: '另有 {0} 个生图、视频等模型，不出现在对话选择器里。',
      moreModels: '还有 {0} 个', catalogError: '模型列表暂时读不到',
      dialogAdd: '添加网关', dialogEdit: '编辑网关', name: '名称', namePlaceholder: '例如：主力网关', nameHint: '留空则用网关域名。',
      address: '网关地址', addressHint: '站点根地址，或以 /v1 结尾的地址。', apiKey: 'API 令牌', apiKeyHint: '只存进 DSH 凭据库，不会显示也不写进配置。',
      apiKeyKeep: '留空则继续使用已保存的令牌', show: '显示', hide: '隐藏',
      check: '检查连接', checking: '检查中…', save: '保存', saving: '保存中…', checkFirst: '先检查连接，通过后才能保存。', changedSinceCheck: '地址或令牌改过了，请重新检查。',
      checkOk: '可以接入', checkBad: '暂时无法接入', modelsListed: '列出了 {0} 个模型', backend: '后端',
      quotaWill: '保存后会显示额度（{0}）', quotaWont: '没有额度接口：保存后不显示额度，不影响使用。',
      saved: '已保存「{0}」，它的模型现在可以在对话里选择。', removed: '已删除网关', activated: '已切换到「{0}」',
      conflict: '设置在别的窗口被改过，请刷新后再试。', loadFailed: '读取失败', retry: '重试',
      code_unauthorized: '令牌被拒绝（401/403）', 'code_not-found': '接口不存在（404）', code_html: '返回的是网页，不是 API', code_redirect: '地址发生了重定向，请填写最终地址',
      code_network: '无法连接到这个地址', code_timeout: '请求超时', code_http: '网关返回错误', code_address: '地址格式不对', 'code_key-required': '需要填写令牌',
      kind_new_api: 'New API 令牌额度', kind_litellm: 'LiteLLM 预算', kind_openai_billing: 'OpenAI 风格账单接口',
      routeWaiting: '模型路由暂时被占用：{0}',
    };
    const EN = {
      nav: 'AI Gateway', title: 'AI Gateway', subtitle: 'Connect any OpenAI-compatible gateway. Once saved, its models appear in the chat model picker.',
      add: 'Add gateway', refresh: 'Refresh', refreshing: 'Refreshing…',
      emptyTitle: 'No gateways yet', emptyBody: 'Enter a gateway address and token, check the connection, and save to use its models in chat.',
      howTitle: 'How to use', how1: 'Add a gateway: enter the address and token, then Check connection.', how2: 'Save once the check passes. The token goes only into the DSH credential store.', how3: 'Pick a model under “{0}” in the chat model picker.',
      active: 'In use', setActive: 'Use this one', edit: 'Edit', remove: 'Delete', confirmRemove: 'Confirm delete', cancel: 'Cancel',
      models: '{0} models', backendUnknown: 'OpenAI-compatible', quota: 'Quota', quotaNone: 'This gateway has no quota endpoint', quotaPending: 'Loading…',
      quotaError: 'Quota unavailable', unlimited: 'Unlimited', remaining: 'Remaining', used: 'Used', account: 'Account', noKey: 'Token missing; edit and enter it again',
      inPicker: 'Models available in chat', inPickerHint: 'Look for “{0}” in the chat model picker.', otherModels: '{0} more image, video or other models are not shown in the chat picker.',
      moreModels: '{0} more', catalogError: 'The model list cannot be read right now',
      dialogAdd: 'Add gateway', dialogEdit: 'Edit gateway', name: 'Name', namePlaceholder: 'e.g. Main gateway', nameHint: 'Leave empty to use the gateway host.',
      address: 'Gateway address', addressHint: 'A site root, or an address ending in /v1.', apiKey: 'API token', apiKeyHint: 'Stored only in the DSH credential store; never shown or written to config.',
      apiKeyKeep: 'Leave empty to keep the saved token', show: 'Show', hide: 'Hide',
      check: 'Check connection', checking: 'Checking…', save: 'Save', saving: 'Saving…', checkFirst: 'Check the connection first; Save unlocks once it passes.', changedSinceCheck: 'The address or token changed; check again.',
      checkOk: 'Ready to connect', checkBad: 'Cannot connect yet', modelsListed: '{0} models listed', backend: 'Backend',
      quotaWill: 'Quota will be shown after saving ({0})', quotaWont: 'No quota endpoint: quota will not be shown. Models still work.',
      saved: 'Saved “{0}”. Its models can now be picked in chat.', removed: 'Gateway deleted', activated: 'Switched to “{0}”',
      conflict: 'Settings changed in another window; refresh and try again.', loadFailed: 'Could not load', retry: 'Retry',
      code_unauthorized: 'Token rejected (401/403)', 'code_not-found': 'Endpoint not found (404)', code_html: 'Returned a web page, not an API', code_redirect: 'The address redirects; enter the final address',
      code_network: 'Cannot reach this address', code_timeout: 'Timed out', code_http: 'The gateway returned an error', code_address: 'The address is not valid', 'code_key-required': 'Enter the token',
      kind_new_api: 'New API token quota', kind_litellm: 'LiteLLM budget', kind_openai_billing: 'OpenAI-style billing routes',
      routeWaiting: 'Model route is busy: {0}',
    };
    let translate;
    const t = (key, ...args) => {
      let v = translate ? translate(key) : (EN[key] ?? key);
      if (v === key && EN[key]) v = EN[key];
      args.forEach((a, i) => { v = String(v).replace(`{${i}}`, a); });
      return v;
    };
    const kindText = (kind) => t(`kind_${String(kind).replace(/-/g, '_')}`);
    const codeText = (code, fallback) => {
      const key = `code_${code}`;
      const v = t(key);
      return v === key ? (fallback || t('code_http')) : v;
    };

    // ------------------------------------------------------------ styles
    // Single column everywhere: the settings panel is narrow, so nothing sits side by side
    // except short inline items that wrap.
    const CSS = `
      .aig{--l1:var(--dsw-alias-border-l1);--l2:var(--dsw-alias-border-l2);--tx:var(--dsw-alias-label-primary);--sub:var(--dsw-alias-label-secondary);--bg:var(--dsw-alias-bg-layer-1);--bg2:var(--dsw-alias-bg-layer-2);--br:var(--dsw-alias-brand-primary);--ok:var(--dsw-alias-state-success-primary);--bad:var(--dsw-alias-state-error-primary);color:var(--tx);font:inherit;font-size:13px;line-height:1.55;width:100%;min-width:0;box-sizing:border-box}
      .aig *{box-sizing:border-box}.aig button,.aig input{font:inherit;color:inherit}.aig button{cursor:pointer}.aig button:disabled{cursor:default;opacity:.5}
      .aig button:focus-visible,.aig input:focus-visible{outline:2px solid var(--br);outline-offset:2px}
      .aig-page{padding:2px 0 28px;max-width:760px}
      .aig-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 16px;margin-bottom:18px}
      .aig-head>div:first-child{flex:1 1 260px;min-width:0}
      .aig-head h2{font-size:21px;line-height:1.3;font-weight:650;letter-spacing:-.4px;margin:0 0 4px}
      .aig-sub{color:var(--sub);font-size:12px}
      .aig-actions{display:flex;flex-wrap:wrap;gap:8px}
      .aig-btn{min-height:32px;border:1px solid var(--l1);background:var(--bg);padding:5px 12px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
      .aig-btn:hover:not(:disabled){background:var(--bg2);border-color:var(--l2)}
      .aig-btn.primary{background:var(--br);border-color:var(--br);color:var(--dsw-alias-bg-base)}
      .aig-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--br) 86%,var(--dsw-alias-bg-base));border-color:transparent}
      .aig-btn.danger{color:var(--bad)}
      .aig-btn.small{min-height:28px;padding:3px 9px;font-size:12px}
      .aig-card{border:1px solid var(--l1);border-radius:10px;background:var(--bg);padding:14px 16px;margin-bottom:12px;min-width:0}
      .aig-card.active{border-color:var(--br);box-shadow:inset 3px 0 0 var(--br)}
      .aig-gw-title{min-width:0}
      .aig-gw-title strong{font-size:14px;font-weight:600;overflow-wrap:anywhere}
      .aig-url{font-size:11.5px;color:var(--sub);overflow-wrap:anywhere}
      .aig-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--l2);color:var(--sub);white-space:nowrap;margin-left:8px;vertical-align:2px}
      .aig-pill.on{border-color:var(--br);color:var(--tx)}
      .aig-pill.on::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--ok)}
      .aig-facts{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:10px;font-size:12px;color:var(--sub)}
      .aig-facts b{color:var(--tx);font-weight:550;font-variant-numeric:tabular-nums}
      .aig-gw-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
      .aig-warn{color:var(--bad);font-size:12px;margin-top:8px}
      .aig-section{margin:20px 0 8px;font-size:12px;font-weight:600;color:var(--sub);letter-spacing:.02em}
      .aig-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .aig-chip{font-size:11.5px;padding:2px 8px;border-radius:5px;background:var(--bg2);overflow-wrap:anywhere;max-width:100%}
      .aig-chip.more{color:var(--sub);background:transparent;border:1px dashed var(--l2)}
      .aig-steps{margin:0;padding-left:18px;font-size:12.5px}
      .aig-steps li+li{margin-top:4px}
      .aig-empty{padding:20px 18px}
      .aig-empty h3{margin:0 0 4px;font-size:15px;font-weight:600}
      .aig-toast{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--l1);background:var(--bg2);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12.5px}
      .aig-error{color:var(--bad);font-size:12px}
      .aig-dialog{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 48px);border:1px solid var(--l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--tx);padding:0;overflow:auto;box-shadow:0 16px 56px color-mix(in srgb,var(--tx) 18%,transparent)}
      .aig-dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);backdrop-filter:blur(2px)}
      .aig-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 6px}
      .aig-dialog-head h3{margin:0;font-size:16px;font-weight:600}
      .aig-dialog-body{padding:8px 20px 4px}
      .aig-dialog-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px 16px;border-top:1px solid var(--l1);margin-top:12px}
      .aig-dialog-foot .aig-sub{flex:1 1 180px;min-width:0}
      .aig-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;min-width:0}
      .aig-field label{font-size:12px;font-weight:550}
      .aig-input{display:flex;align-items:center;min-width:0;border:1px solid var(--l1);border-radius:7px;background:var(--dsw-alias-bg-base);min-height:34px;padding:0 4px 0 10px}
      .aig-input:focus-within{border-color:var(--br);box-shadow:0 0 0 3px color-mix(in srgb,var(--br) 14%,transparent)}
      .aig-input input{flex:1;min-width:0;width:100%;border:0;outline:0;background:transparent;padding:7px 0;font-size:13px}
      .aig-input input:focus-visible{outline:0}
      .aig-ghost{border:0;background:transparent;color:var(--sub);font-size:11.5px;padding:4px 7px;border-radius:5px;flex-shrink:0;display:inline-flex;align-items:center}
      .aig-ghost:hover{background:var(--bg2);color:var(--tx)}
      .aig-hint{font-size:11.5px;color:var(--sub)}
      .aig-result{border:1px solid var(--l1);border-radius:8px;padding:10px 12px;margin-top:2px;font-size:12.5px}
      .aig-result.ok{border-color:color-mix(in srgb,var(--ok) 45%,var(--l1))}
      .aig-result.bad{border-color:color-mix(in srgb,var(--bad) 45%,var(--l1))}
      .aig-result-title{display:flex;align-items:center;gap:7px;font-weight:600;margin-bottom:4px}
      .aig-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--ok)}
      .aig-result.bad .aig-dot{background:var(--bad)}
      .aig-result ul{margin:4px 0 0;padding-left:17px;color:var(--sub)}
      .aig-spin{animation:aig-spin 1s linear infinite}@keyframes aig-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){.aig-spin{animation:none}}
    `;
    function Styles() { return h('style', null, CSS); }

    const PATHS = {
      plus: 'M12 5v14M5 12h14', refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5', spin: 'M21 12a9 9 0 1 1-6.22-8.56',
      close: 'M18 6 6 18M6 6l12 12', check: 'M20 6 9 17l-5-5',
    };
    function Icon({ name, size = 14, className }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className }, h('path', { d: PATHS[name] }));
    }

    // ------------------------------------------------------------ data
    function apiUrl(path) {
      const u = new URL(document.baseURI);
      u.search = ''; u.hash = '';
      if (!u.pathname.endsWith('/')) u.pathname += '/';
      return new URL(`ai-gateway/api/${path}`, u).href;
    }
    async function api(path, body, signal) {
      const response = await fetch(apiUrl(path), {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let value; try { value = await response.json(); } catch { /* handled below */ }
      if (!response.ok) throw Object.assign(new Error(value?.error || `HTTP ${response.status}`), { status: response.status, code: value?.code ?? null });
      return value;
    }

    const store = {
      state: undefined, error: undefined, busy: false, listeners: new Set(), version: 0,
      emit() { this.version++; for (const fn of this.listeners) fn(); },
      subscribe: (fn) => { store.listeners.add(fn); return () => store.listeners.delete(fn); },
      snapshot: () => store.version,
      async load(force = false) {
        this.busy = true; this.emit();
        try { this.state = await api(force ? 'refresh' : 'state', force ? {} : undefined); this.error = undefined; }
        catch (e) { this.error = e.message; }
        finally { this.busy = false; this.emit(); }
      },
      async mutate(path, body) {
        const r = await api(path, { revision: this.state?.revision, ...body });
        await this.load();
        return r;
      },
    };
    const useStore = () => { useSyncExternalStore(store.subscribe, store.snapshot); return store; };

    const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

    // ------------------------------------------------------------ add / edit dialog
    function GatewayDialog({ initial, onClose, onSaved }) {
      const id = useId();
      const ref = useRef();
      const editing = Boolean(initial);
      const [name, setName] = useState(initial?.name ?? '');
      const [baseURL, setBaseURL] = useState(initial?.baseURL ?? '');
      const [apiKey, setApiKey] = useState('');
      const [reveal, setReveal] = useState(false);
      const [busy, setBusy] = useState('');
      const [result, setResult] = useState(null);
      const [checkedFor, setCheckedFor] = useState(null);
      const [error, setError] = useState('');
      const fingerprint = `${baseURL.trim()}\u0000${apiKey.trim()}`;
      const fresh = checkedFor === fingerprint;
      const canSave = fresh && result?.usable && !busy;

      useEffect(() => {
        const dialog = ref.current;
        if (dialog && !dialog.open) dialog.showModal?.();
      }, []);
      useEffect(() => {
        const dialog = ref.current;
        const cancel = (e) => { e.preventDefault(); if (!busy) onClose(); };
        dialog?.addEventListener('cancel', cancel);
        return () => dialog?.removeEventListener('cancel', cancel);
      }, [busy]);

      const check = async () => {
        setBusy('check'); setError('');
        try {
          const report = await api('check', { id: initial?.id, baseURL: baseURL.trim(), apiKey: apiKey.trim() || undefined });
          setResult(report); setCheckedFor(fingerprint);
        } catch (e) {
          setResult(null); setCheckedFor(null);
          setError(e.code ? codeText(e.code, e.message) : e.message);
        } finally { setBusy(''); }
      };
      const save = async () => {
        setBusy('save'); setError('');
        try {
          const r = await store.mutate('channel/save', { id: initial?.id, name: name.trim(), baseURL: baseURL.trim(), apiKey: apiKey.trim() || undefined });
          let label = name.trim();
          if (!label) { try { label = new URL(r.report?.root ?? baseURL.trim()).host; } catch { label = baseURL.trim(); } }
          onSaved(label);
        } catch (e) {
          setError(e.status === 409 ? t('conflict') : e.code ? codeText(e.code, e.message) : e.message);
        } finally { setBusy(''); }
      };

      const r = result;
      return h('dialog', { ref, className: 'aig aig-dialog', 'aria-labelledby': `${id}-title` },
        h(Styles),
        h('div', { className: 'aig-dialog-head' },
          h('h3', { id: `${id}-title` }, t(editing ? 'dialogEdit' : 'dialogAdd')),
          h('button', { type: 'button', className: 'aig-ghost', onClick: onClose, disabled: Boolean(busy), 'aria-label': t('cancel') }, h(Icon, { name: 'close' }))),
        h('div', { className: 'aig-dialog-body' },
          h('div', { className: 'aig-field' },
            h('label', { htmlFor: `${id}-url` }, t('address')),
            h('div', { className: 'aig-input' }, h('input', { id: `${id}-url`, value: baseURL, placeholder: 'https://gateway.example.com', inputMode: 'url', autoComplete: 'off', spellCheck: false, disabled: Boolean(busy), onChange: (e) => setBaseURL(e.target.value) })),
            h('div', { className: 'aig-hint' }, t('addressHint'))),
          h('div', { className: 'aig-field' },
            h('label', { htmlFor: `${id}-key` }, t('apiKey')),
            h('div', { className: 'aig-input' },
              h('input', { id: `${id}-key`, value: apiKey, type: reveal ? 'text' : 'password', placeholder: editing ? t('apiKeyKeep') : 'sk-…', autoComplete: 'off', spellCheck: false, disabled: Boolean(busy), onChange: (e) => setApiKey(e.target.value) }),
              h('button', { type: 'button', className: 'aig-ghost', onClick: () => setReveal(!reveal), 'aria-pressed': reveal }, t(reveal ? 'hide' : 'show'))),
            h('div', { className: 'aig-hint' }, t('apiKeyHint'))),
          h('div', { className: 'aig-field' },
            h('label', { htmlFor: `${id}-name` }, t('name')),
            h('div', { className: 'aig-input' }, h('input', { id: `${id}-name`, value: name, placeholder: t('namePlaceholder'), autoComplete: 'off', disabled: Boolean(busy), onChange: (e) => setName(e.target.value) })),
            h('div', { className: 'aig-hint' }, t('nameHint'))),
          r && h('div', { className: `aig-result ${r.usable ? 'ok' : 'bad'}`, role: 'status', 'aria-live': 'polite' },
            h('div', { className: 'aig-result-title' }, h('span', { className: 'aig-dot', 'aria-hidden': true }), t(r.usable ? 'checkOk' : 'checkBad')),
            r.usable
              ? h('ul', null,
                h('li', null, t('modelsListed', r.models.count)),
                h('li', null, `${t('backend')}: ${r.backend?.family === 'unknown' ? t('backendUnknown') : [r.backend?.name, r.backend?.version].filter(Boolean).join(' ')}`),
                h('li', null, r.quota ? t('quotaWill', kindText(r.quota.kind)) : t('quotaWont')))
              : h('div', { className: 'aig-error' }, codeText(r.models?.code, r.models?.error))),
          r && !fresh && h('div', { className: 'aig-hint', style: { marginTop: 6 } }, t('changedSinceCheck')),
          error && h('div', { className: 'aig-error', role: 'alert', style: { marginTop: 8 } }, error)),
        h('div', { className: 'aig-dialog-foot' },
          h('span', { className: 'aig-sub' }, canSave ? '' : t('checkFirst')),
          h('button', { type: 'button', className: 'aig-btn', onClick: check, disabled: Boolean(busy) || !baseURL.trim() },
            busy === 'check' && h(Icon, { name: 'spin', className: 'aig-spin' }), t(busy === 'check' ? 'checking' : 'check')),
          h('button', { type: 'button', className: 'aig-btn primary', onClick: save, disabled: !canSave },
            busy === 'save' ? h(Icon, { name: 'spin', className: 'aig-spin' }) : h(Icon, { name: 'check' }), t(busy === 'save' ? 'saving' : 'save'))));
    }

    // ------------------------------------------------------------ gateway card
    function QuotaLine({ quota }) {
      if (!quota || quota.status === 'none') return h('span', null, t('quotaNone'));
      if (quota.status === 'pending') return h('span', null, `${t('quota')}: ${t('quotaPending')}`);
      if (quota.status === 'error') return h('span', { title: quota.message }, `${t('quota')}: ${t('quotaError')}`);
      const unit = quota.unit && !/^site/.test(quota.unit) ? ` ${quota.unit}` : '';
      return h(React.Fragment, null,
        quota.unlimited
          ? h('span', null, `${t('quota')}: `, h('b', null, t('unlimited')))
          : h('span', null, `${t('remaining')} `, h('b', null, `${fmt(quota.remaining)}${unit}`)),
        h('span', null, `${t('used')} `, h('b', null, `${fmt(quota.used)}${unit}`)),
        quota.account && h('span', null, `${t('account')} `, h('b', null, `${fmt(quota.account.remaining)}${unit}`)));
    }

    function GatewayCard({ gw, onEdit, onToast }) {
      const [confirm, setConfirm] = useState(false);
      const [busy, setBusy] = useState(false);
      const run = async (path, toast) => {
        setBusy(true);
        try { await store.mutate(path, { id: gw.id }); onToast(toast); }
        catch (e) { onToast(e.status === 409 ? t('conflict') : e.message); }
        finally { setBusy(false); setConfirm(false); }
      };
      const backend = gw.backend?.family && gw.backend.family !== 'unknown'
        ? [gw.backend.name, gw.backend.version].filter(Boolean).join(' ')
        : t('backendUnknown');
      return h('div', { className: `aig-card${gw.active ? ' active' : ''}` },
        h('div', { className: 'aig-gw-title' },
          h('strong', null, gw.name), gw.active && h('span', { className: 'aig-pill on' }, t('active')),
          h('div', { className: 'aig-url' }, gw.baseURL)),
        h('div', { className: 'aig-facts' },
          h('span', null, backend),
          gw.backend?.modelCount != null && h('span', null, t('models', gw.backend.modelCount)),
          h(QuotaLine, { quota: gw.quota })),
        !gw.keyConfigured && h('div', { className: 'aig-warn' }, t('noKey')),
        h('div', { className: 'aig-gw-actions' },
          !gw.active && h('button', { type: 'button', className: 'aig-btn small', disabled: busy, onClick: () => run('channel/activate', t('activated', gw.name)) }, t('setActive')),
          h('button', { type: 'button', className: 'aig-btn small', disabled: busy, onClick: onEdit }, t('edit')),
          confirm
            ? h(React.Fragment, null,
              h('button', { type: 'button', className: 'aig-btn small danger', disabled: busy, onClick: () => run('channel/delete', t('removed')) }, t('confirmRemove')),
              h('button', { type: 'button', className: 'aig-btn small', disabled: busy, onClick: () => setConfirm(false) }, t('cancel')))
            : h('button', { type: 'button', className: 'aig-btn small danger', disabled: busy, onClick: () => setConfirm(true) }, t('remove'))));
    }

    function ModelsCard({ models, routeName, catalogError }) {
      if (!models) {
        return catalogError
          ? h('div', { className: 'aig-card' }, h('div', { className: 'aig-error' }, t('catalogError')), h('div', { className: 'aig-sub' }, catalogError))
          : null;
      }
      const LIMIT = 24;
      return h('div', { className: 'aig-card' },
        h('div', { className: 'aig-sub' }, t('inPickerHint', routeName)),
        h('div', { className: 'aig-chips' },
          models.chat.slice(0, LIMIT).map((m) => h('span', { key: m.id, className: 'aig-chip', lang: 'en' }, m.name)),
          models.chat.length > LIMIT && h('span', { className: 'aig-chip more' }, t('moreModels', models.chat.length - LIMIT))),
        models.other.length > 0 && h('div', { className: 'aig-sub', style: { marginTop: 10 } }, t('otherModels', models.other.length)));
    }

    // ------------------------------------------------------------ page
    function SettingsPage() {
      const s = useStore();
      const [dialog, setDialog] = useState(null);
      const [toast, setToast] = useState('');
      useEffect(() => { if (!s.state && !s.busy) s.load(); }, []);
      useEffect(() => { if (!toast) return undefined; const timer = setTimeout(() => setToast(''), 6000); return () => clearTimeout(timer); }, [toast]);

      const state = s.state;
      const gateways = state?.channels ?? [];
      const routeName = state?.route?.displayName ?? 'AI Gateway';
      const addButton = h('button', { type: 'button', className: 'aig-btn primary', onClick: () => setDialog({ mode: 'add' }) }, h(Icon, { name: 'plus' }), t('add'));
      return h('div', { className: 'aig aig-page' }, h(Styles),
        h('div', { className: 'aig-head' },
          h('div', null, h('h2', null, t('title')), h('div', { className: 'aig-sub' }, t('subtitle'))),
          h('div', { className: 'aig-actions' },
            gateways.length > 0 && h('button', { type: 'button', className: 'aig-btn', disabled: s.busy, onClick: () => s.load(true) },
              h(Icon, { name: s.busy ? 'spin' : 'refresh', className: s.busy ? 'aig-spin' : undefined }), t(s.busy ? 'refreshing' : 'refresh')),
            gateways.length > 0 && addButton)),
        toast && h('div', { className: 'aig-toast', role: 'status' }, h('span', null, toast), h('button', { type: 'button', className: 'aig-ghost', onClick: () => setToast(''), 'aria-label': t('cancel') }, h(Icon, { name: 'close', size: 12 }))),
        s.error && !state && h('div', { className: 'aig-card' }, h('div', { className: 'aig-error' }, `${t('loadFailed')}: ${s.error}`), h('div', { className: 'aig-actions', style: { marginTop: 10 } }, h('button', { type: 'button', className: 'aig-btn small', onClick: () => s.load() }, t('retry')))),
        state && gateways.length === 0 && h('div', { className: 'aig-card aig-empty' },
          h('h3', null, t('emptyTitle')),
          h('div', { className: 'aig-sub' }, t('emptyBody')),
          h('div', { className: 'aig-actions', style: { marginTop: 12 } }, addButton)),
        gateways.map((gw) => h(GatewayCard, { key: gw.id, gw, onEdit: () => setDialog({ mode: 'edit', gw }), onToast: setToast })),
        state?.route?.status === 'waiting' && h('div', { className: 'aig-warn' }, t('routeWaiting', state.route.error ?? '')),
        gateways.length > 0 && h(React.Fragment, null,
          h('div', { className: 'aig-section' }, t('inPicker')),
          h(ModelsCard, { models: state.models, routeName, catalogError: state.errors?.catalog?.message })),
        h('div', { className: 'aig-section' }, t('howTitle')),
        h('div', { className: 'aig-card' }, h('ol', { className: 'aig-steps' }, h('li', null, t('how1')), h('li', null, t('how2')), h('li', null, t('how3', routeName)))),
        dialog && h(GatewayDialog, {
          initial: dialog.mode === 'edit' ? dialog.gw : null,
          onClose: () => setDialog(null),
          onSaved: (label) => { setDialog(null); setToast(t('saved', label)); },
        }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN));
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH));
        translate = ctx.locale.bind(NS);
        ctx.effect(() => () => { translate = undefined; });
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'ai-gateway', order: 19.5, label: () => t('nav') }, SettingsPage));
      },
    };
  },
});

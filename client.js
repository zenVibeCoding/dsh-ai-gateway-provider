/** AI Gateway: settings page with the gateway probe (preview). */
window.__ModuleLoader__.load({
  id: 'dsh-ai-gateway-provider',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useId, useEffect } = React;
    const NS = 'ai-gateway-ui';
    const VERSION = '0.1.0';

    const ZH = {
      nav: 'AI 网关', title: 'AI Gateway', subtitle: '接入任意 OpenAI 兼容网关。先探测它支持什么，再决定如何接入。',
      preview: '预览版', previewNote: '这个版本只做网关探测，还不会出现在模型选择器里，也不会影响任何对话。',
      probeTitle: '探测网关', probeHint: '只发送只读 GET 请求，不调用模型，不产生费用。令牌只用于本次探测，不会保存。',
      address: '网关地址', addressHint: '站点根地址或以 /v1 结尾的地址都可以。', addressPlaceholder: 'https://gateway.example.com',
      apiKey: 'API 令牌', apiKeyHint: '可留空：只探测公开部分（后端类型、版本）。', show: '显示', hide: '隐藏',
      run: '开始探测', running: '探测中…', clear: '清除结果',
      usable: '可以接入', notUsable: '暂时无法接入', took: '耗时',
      models: '模型', modelsCount: '个模型', protocols: '协议', backend: '后端', quota: '额度', media: '生成能力',
      unknownBackend: '未识别（按通用 OpenAI 兼容处理）', evidence: '依据',
      noQuota: '没有可用的额度接口：接入后不显示额度，这不是错误。', unlimited: '不限额', remaining: '剩余', used: '已用', limit: '总额', account: '账户余额',
      imageModels: '生图模型', videoModels: '视频模型', none: '无', notes: '说明', attempts: '尝试过的额度接口',
      protocolUnreported: '未上报', errorTitle: '探测失败', needAddress: '请先填写网关地址',
      kindNewApi: 'New API 令牌额度', kindLitellm: 'LiteLLM 预算', kindBilling: 'OpenAI 风格账单接口',
      quotaSkipped: '未检查：填写令牌后才能读取额度。', needKey: '需要令牌才能读取模型列表',
      code_unauthorized: '令牌被拒绝（401/403）', 'code_not-found': '接口不存在（404）', code_html: '返回的是网页，不是 API', code_redirect: '发生重定向，为保护令牌未跟随',
      code_network: '无法连接到这个地址', code_timeout: '请求超时', code_http: '网关返回错误',
      'note_protocol-unreported': '部分模型没有上报协议，接入后默认按 OpenAI Chat Completions 调用，可在模型参数里手动改。',
      'note_models-failed': '模型列表没有读到：请检查地址和令牌。', 'note_no-token': '没有填写令牌，只探测了公开部分（后端类型、版本）。',
      technical: '技术细节',
      roadmap: '接下来', roadmap1: '把探测结果保存为渠道，并注册模型路由', roadmap2: '没有额度接口的网关自动隐藏额度界面', roadmap3: '可选的管理密钥，用来读取 CLIProxy / Sub2API 额度',
    };
    const EN = {
      nav: 'AI Gateway', title: 'AI Gateway', subtitle: 'Connect any OpenAI-compatible gateway. Probe what it supports first, then decide how to connect it.',
      preview: 'Preview', previewNote: 'This build only probes gateways. It does not appear in the model picker and does not affect any conversation.',
      probeTitle: 'Probe a gateway', probeHint: 'Read-only GET requests only: no model is called and nothing is billed. The token is used for this probe only and is not saved.',
      address: 'Gateway address', addressHint: 'A site root or an address ending in /v1.', addressPlaceholder: 'https://gateway.example.com',
      apiKey: 'API token', apiKeyHint: 'Optional: without it only the public parts (backend, version) are probed.', show: 'Show', hide: 'Hide',
      run: 'Probe', running: 'Probing…', clear: 'Clear result',
      usable: 'Ready to connect', notUsable: 'Cannot connect yet', took: 'Took',
      models: 'Models', modelsCount: 'models', protocols: 'Protocols', backend: 'Backend', quota: 'Quota', media: 'Generation',
      unknownBackend: 'Not recognised (treated as plain OpenAI-compatible)', evidence: 'Evidence',
      noQuota: 'No quota endpoint answered: quota will be hidden once connected. This is not an error.', unlimited: 'Unlimited', remaining: 'Remaining', used: 'Used', limit: 'Limit', account: 'Account balance',
      imageModels: 'Image models', videoModels: 'Video models', none: 'None', notes: 'Notes', attempts: 'Quota endpoints tried',
      protocolUnreported: 'unreported', errorTitle: 'Probe failed', needAddress: 'Enter a gateway address first',
      kindNewApi: 'New API token quota', kindLitellm: 'LiteLLM budget', kindBilling: 'OpenAI-style billing routes',
      quotaSkipped: 'Not checked: enter a token to read quota.', needKey: 'A token is needed to read the model list',
      code_unauthorized: 'Token rejected (401/403)', 'code_not-found': 'Endpoint not found (404)', code_html: 'Returned a web page, not an API', code_redirect: 'Redirected; not followed to protect the token',
      code_network: 'Cannot reach this address', code_timeout: 'Timed out', code_http: 'The gateway returned an error',
      'note_protocol-unreported': 'Some models do not report a protocol; they will use OpenAI Chat Completions unless changed in model settings.',
      'note_models-failed': 'The model list did not load: check the address and the token.', 'note_no-token': 'No token given: only the public parts (backend, version) were probed.',
      technical: 'Technical detail',
      roadmap: 'Next', roadmap1: 'Save a probed gateway as a channel and register its model route', roadmap2: 'Hide quota UI automatically where a gateway has no quota endpoint', roadmap3: 'Optional management key to read CLIProxy / Sub2API quota',
    };
    let translate;
    const t = (key) => (translate ? translate(key) : (EN[key] ?? key));

    const CSS = `
      .aig{--aig-line:var(--dsw-alias-border-l1);--aig-line2:var(--dsw-alias-border-l2);--aig-text:var(--dsw-alias-label-primary);--aig-sub:var(--dsw-alias-label-secondary);--aig-bg:var(--dsw-alias-bg-layer-1);--aig-raised:var(--dsw-alias-bg-layer-2);--aig-brand:var(--dsw-alias-brand-primary);color:var(--aig-text);font:inherit;font-size:13px;line-height:1.55;width:100%;min-width:0;box-sizing:border-box}
      .aig *{box-sizing:border-box}.aig button,.aig input{font:inherit}.aig button{cursor:pointer}.aig button:disabled{cursor:default;opacity:.55}
      .aig button:focus-visible,.aig input:focus-visible{outline:2px solid var(--aig-brand);outline-offset:2px}
      .aig-page{padding:4px 2px 28px;max-width:1080px;margin:0 auto}
      .aig-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
      .aig-eyebrow{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.09em;color:var(--aig-sub);margin-bottom:7px}
      .aig-head h2{font-size:23px;line-height:1.3;font-weight:650;letter-spacing:-.6px;margin:0 0 6px}
      .aig-sub{color:var(--aig-sub);font-size:12px}
      .aig-tag{font-size:10px;letter-spacing:.04em;padding:1px 7px;border-radius:999px;border:1px solid var(--aig-line2);color:var(--aig-sub)}
      .aig-note{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--aig-line);border-radius:9px;padding:10px 13px;margin-bottom:18px;font-size:12px;color:var(--aig-sub);background:var(--aig-bg)}
      .aig-note svg{flex-shrink:0;margin-top:2px}
      .aig-card{border:1px solid var(--aig-line);border-radius:11px;background:var(--aig-bg);padding:18px 20px;margin-bottom:16px}
      .aig-card h3{margin:0 0 4px;font-size:15px;font-weight:600}
      .aig-form{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto;gap:12px;align-items:end;margin-top:14px}
      .aig-field{display:flex;flex-direction:column;gap:6px;min-width:0}
      .aig-field label{font-size:12px;font-weight:550}
      .aig-input{display:flex;align-items:center;border:1px solid var(--aig-line);border-radius:7px;background:var(--dsw-alias-bg-base);min-height:34px;padding:0 4px 0 10px}
      .aig-input:focus-within{border-color:var(--aig-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--aig-brand) 14%,transparent)}
      .aig-input input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--aig-text);padding:7px 0;font-size:13px}
      .aig-input input:focus-visible{outline:0}
      .aig-hint{font-size:11px;color:var(--aig-sub);min-height:17px}
      .aig-ghost{border:0;background:transparent;color:var(--aig-sub);font-size:11px;padding:4px 7px;border-radius:5px}
      .aig-ghost:hover{background:var(--aig-raised);color:var(--aig-text)}
      .aig-btn{min-height:34px;border:1px solid var(--aig-line);background:var(--aig-bg);color:var(--aig-text);padding:5px 13px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
      .aig-btn:hover:not(:disabled){background:var(--aig-raised);border-color:var(--aig-line2)}
      .aig-btn.primary{background:var(--aig-brand);border-color:var(--aig-brand);color:var(--dsw-alias-bg-base)}
      .aig-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--aig-brand) 88%,var(--dsw-alias-bg-base));border-color:transparent}
      .aig-actions{display:flex;gap:8px;margin-bottom:23px}
      .aig-result-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
      .aig-verdict{display:flex;align-items:center;gap:10px}
      .aig-verdict strong{font-size:15px;font-weight:600}
      .aig-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
      .aig-dot.ok{background:var(--dsw-alias-state-success-primary)}.aig-dot.bad{background:var(--dsw-alias-state-error-primary)}
      .aig-rows{border:1px solid var(--aig-line);border-radius:9px;overflow:hidden}
      .aig-row{display:grid;grid-template-columns:132px minmax(0,1fr);gap:16px;padding:11px 14px;align-items:baseline}
      .aig-row+.aig-row{border-top:1px solid var(--aig-line)}
      .aig-row dt{font-size:12px;color:var(--aig-sub)}
      .aig-row dd{margin:0;min-width:0;overflow-wrap:anywhere}
      .aig-chips{display:flex;flex-wrap:wrap;gap:6px}
      .aig-chip{font-size:11px;padding:1px 8px;border-radius:5px;background:var(--aig-raised);color:var(--aig-text);font-variant-numeric:tabular-nums}
      .aig-chip.muted{color:var(--aig-sub)}
      .aig-num{font-variant-numeric:tabular-nums}
      .aig-kv{display:flex;flex-wrap:wrap;gap:4px 18px}
      .aig-kv span{color:var(--aig-sub);font-size:12px}.aig-kv b{font-weight:550;color:var(--aig-text);margin-left:5px}
      .aig-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
      .aig-list{margin:0;padding-left:18px;color:var(--aig-sub);font-size:12px}
      .aig-list li+li{margin-top:3px}
      .aig-spin{animation:aig-spin 1s linear infinite}@keyframes aig-spin{to{transform:rotate(360deg)}}
      @media(max-width:760px){.aig-form{grid-template-columns:1fr}.aig-row{grid-template-columns:1fr;gap:4px}.aig-head h2{font-size:20px}}
      @media(prefers-reduced-motion:reduce){.aig-spin{animation:none}}
    `;
    function Styles() { return h('style', null, CSS); }

    const PATHS = {
      info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
      probe: 'M21 21l-4.35-4.35M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z',
      spin: 'M21 12a9 9 0 1 1-6.22-8.56',
      gateway: 'M3 6h4l3 6-3 6H3M21 12h-7M17 8l4 4-4 4',
    };
    function Icon({ name, size = 14, className }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className },
        h('path', { d: PATHS[name] }));
    }

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
      let value; try { value = await response.json(); } catch { /* explicit failure below */ }
      if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
      return value;
    }

    const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }));
    const codeText = (code, detail) => (code ? t(`code_${code}`) : detail) || '—';
    const kindLabel = (kind) => t({ 'new-api': 'kindNewApi', litellm: 'kindLitellm', 'openai-billing': 'kindBilling' }[kind] ?? kind);

    function Field({ id, label, hint, children }) {
      return h('div', { className: 'aig-field' }, h('label', { htmlFor: id }, label), children, h('div', { className: 'aig-hint' }, hint));
    }

    function Result({ report }) {
      const q = report.quota;
      const protocolEntries = Object.entries(report.protocols ?? {});
      const media = report.media ?? {};
      return h('div', { className: 'aig-card', 'aria-live': 'polite' },
        h('div', { className: 'aig-result-head' },
          h('div', { className: 'aig-verdict' },
            h('span', { className: `aig-dot ${report.usable ? 'ok' : 'bad'}`, 'aria-hidden': true }),
            h('div', null, h('strong', null, t(report.usable ? 'usable' : 'notUsable')), h('div', { className: 'aig-sub' }, report.root))),
          h('span', { className: 'aig-sub aig-num' }, `${t('took')} ${report.ms ?? '—'} ms`)),
        h('dl', { className: 'aig-rows', style: { margin: 0 } },
          h('div', { className: 'aig-row' }, h('dt', null, t('models')),
            h('dd', null, report.models?.count != null
              ? h(React.Fragment, null, h('div', { className: 'aig-num', style: { marginBottom: 6 } }, `${report.models.count} ${t('modelsCount')}`),
                h('div', { className: 'aig-chips' }, report.models.sample.map((id) => h('span', { key: id, className: 'aig-chip', lang: 'en' }, id))))
              : report.notes?.includes('no-token') && report.models?.code === 'unauthorized'
                ? h('span', { className: 'aig-sub' }, t('needKey'))
                : h('span', { className: 'aig-error', title: report.models?.error ? `${t('technical')}: ${report.models.error}` : undefined }, codeText(report.models?.code, report.models?.error)))),
          report.usable && h('div', { className: 'aig-row' }, h('dt', null, t('protocols')),
            h('dd', null, h('div', { className: 'aig-chips' }, protocolEntries.map(([name, count]) =>
              h('span', { key: name, className: `aig-chip ${name === 'unreported' ? 'muted' : ''}`, lang: 'en' }, `${name === 'unreported' ? t('protocolUnreported') : name} · ${count}`))))),
          h('div', { className: 'aig-row' }, h('dt', null, t('backend')),
            h('dd', null, report.backend?.family === 'unknown'
              ? h('span', { className: 'aig-sub' }, t('unknownBackend'))
              : h(React.Fragment, null, h('span', null, report.backend?.name || report.backend?.family, report.backend?.version ? ` · ${report.backend.version}` : ''),
                h('div', { className: 'aig-sub' }, `${t('evidence')}: ${report.backend?.evidence}`)))),
          h('div', { className: 'aig-row' }, h('dt', null, t('quota')),
            h('dd', null, q
              ? h(React.Fragment, null,
                h('div', { style: { marginBottom: 4 } }, kindLabel(q.kind), h('span', { className: 'aig-sub' }, ` · ${q.unit}`)),
                h('div', { className: 'aig-kv' },
                  q.unlimited ? h('span', null, t('unlimited')) : h('span', null, t('remaining'), h('b', { className: 'aig-num' }, fmt(q.remaining))),
                  h('span', null, t('used'), h('b', { className: 'aig-num' }, fmt(q.used))),
                  !q.unlimited && q.limit != null && h('span', null, t('limit'), h('b', { className: 'aig-num' }, fmt(q.limit))),
                  q.account && h('span', null, t('account'), h('b', { className: 'aig-num' }, fmt(q.account.remaining)))))
              : h('span', { className: 'aig-sub' }, t(report.quotaChecked === false ? 'quotaSkipped' : 'noQuota')))),
          report.usable && h('div', { className: 'aig-row' }, h('dt', null, t('media')),
            h('dd', null, h('div', { className: 'aig-kv' },
              h('span', null, t('imageModels'), h('b', { className: 'aig-num' }, media.imageModels?.length || t('none'))),
              h('span', null, t('videoModels'), h('b', { className: 'aig-num' }, media.videoModels?.length || t('none')))))),
          report.quotaAttempts?.length > 0 && h('div', { className: 'aig-row' }, h('dt', null, t('attempts')),
            h('dd', null, h('ul', { className: 'aig-list' }, report.quotaAttempts.map((a) =>
              h('li', { key: a.kind, title: a.error ? `${t('technical')}: ${a.error}` : undefined }, `${kindLabel(a.kind)}: `, a.ok ? '✓' : codeText(a.code, a.error)))))),
          report.notes?.length > 0 && h('div', { className: 'aig-row' }, h('dt', null, t('notes')),
            h('dd', null, h('ul', { className: 'aig-list' }, report.notes.map((n) => h('li', { key: n }, t(`note_${n}`))))))));
    }

    function SettingsPage() {
      const id = useId();
      const [baseURL, setBaseURL] = useState('');
      const [apiKey, setApiKey] = useState('');
      const [reveal, setReveal] = useState(false);
      const [busy, setBusy] = useState(false);
      const [report, setReport] = useState(null);
      const [error, setError] = useState('');
      const controller = useRef();
      useEffect(() => () => controller.current?.abort(), []);

      const run = async (event) => {
        event?.preventDefault();
        if (busy) return;
        if (!baseURL.trim()) { setError(t('needAddress')); return; }
        controller.current?.abort();
        controller.current = new AbortController();
        setBusy(true); setError('');
        try {
          setReport(await api('probe', { baseURL: baseURL.trim(), apiKey: apiKey.trim() || undefined }, controller.current.signal));
        } catch (e) {
          if (e.name !== 'AbortError') { setReport(null); setError(e.message); }
        } finally { setBusy(false); }
      };

      return h('div', { className: 'aig aig-page' }, h(Styles),
        h('div', { className: 'aig-head' },
          h('div', null,
            h('div', { className: 'aig-eyebrow' }, h(Icon, { name: 'gateway', size: 13 }), 'AI GATEWAY', h('span', { className: 'aig-tag' }, `${t('preview')} ${VERSION}`)),
            h('h2', null, t('title')),
            h('div', { className: 'aig-sub' }, t('subtitle')))),
        h('div', { className: 'aig-note', role: 'note' }, h(Icon, { name: 'info' }), t('previewNote')),
        h('form', { className: 'aig-card', onSubmit: run, noValidate: true },
          h('h3', null, t('probeTitle')),
          h('div', { className: 'aig-sub' }, t('probeHint')),
          h('div', { className: 'aig-form' },
            h(Field, { id: `${id}-url`, label: t('address'), hint: t('addressHint') },
              h('div', { className: 'aig-input' }, h('input', { id: `${id}-url`, value: baseURL, placeholder: t('addressPlaceholder'), autoComplete: 'off', spellCheck: false, inputMode: 'url', disabled: busy, onChange: (e) => setBaseURL(e.target.value) }))),
            h(Field, { id: `${id}-key`, label: t('apiKey'), hint: t('apiKeyHint') },
              h('div', { className: 'aig-input' },
                h('input', { id: `${id}-key`, value: apiKey, type: reveal ? 'text' : 'password', placeholder: 'sk-…', autoComplete: 'off', spellCheck: false, disabled: busy, onChange: (e) => setApiKey(e.target.value) }),
                h('button', { type: 'button', className: 'aig-ghost', onClick: () => setReveal(!reveal), 'aria-pressed': reveal }, t(reveal ? 'hide' : 'show')))),
            h('div', { className: 'aig-actions' },
              h('button', { type: 'submit', className: 'aig-btn primary', disabled: busy },
                h(Icon, { name: busy ? 'spin' : 'probe', className: busy ? 'aig-spin' : undefined }), t(busy ? 'running' : 'run')),
              report && !busy && h('button', { type: 'button', className: 'aig-btn', onClick: () => { setReport(null); setError(''); } }, t('clear')))),
          error && h('div', { className: 'aig-error', role: 'alert' }, `${t('errorTitle')}: ${error}`)),
        report && h(Result, { report }),
        h('div', { className: 'aig-card' },
          h('h3', null, t('roadmap')),
          h('ul', { className: 'aig-list', style: { marginTop: 8 } }, ['roadmap1', 'roadmap2', 'roadmap3'].map((k) => h('li', { key: k }, t(k))))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN));
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH));
        translate = ctx.locale.bind(NS);
        ctx.effect(() => () => { translate = undefined; });
        // Order 19.5: right after the New API page, so the two gateway pages sit together.
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'ai-gateway', order: 19.5, label: () => t('nav') }, SettingsPage));
      },
    };
  },
});

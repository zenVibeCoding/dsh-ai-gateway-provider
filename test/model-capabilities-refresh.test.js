import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clone = (value) => JSON.parse(JSON.stringify(value));
const entry = (id) => ({ id, name: id, kind: 'chat', input: ['text'], source: {}, endpointTypes: [] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// Run the shipped page, dialog and store with the same lightweight renderer used by
// the editor tests. Effects track dependencies and cleanup; only HTTP is simulated.
function harness(t, { holdInitialList = false } = {}) {
  const roots = []; const calls = []; const held = deferred(); let active;
  const channels = ['a', 'b'].map((id) => ({ id, name: id, baseURL: `https://${id}.example`, balance: { status: 'none' }, backend: {} }));
  const snapshot = { revision: 1, channels, defaults: {}, modelsDev: {}, route: { routes: [] } };
  const upstream = new Map(channels.map((c) => [c.id, [entry(`${c.id}-old`)]]));
  const cache = new Map(); let failRefresh = false;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((v) => v !== null && v !== undefined && v !== false) }),
    Fragment: 'fragment',
    useState(initial) {
      const root = active; const i = root.cursor++;
      if (!(i in root.slots)) root.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [root.slots[i], (value) => {
        root.slots[i] = typeof value === 'function' ? value(root.slots[i]) : value;
        root.dirty = true;
      }];
    },
    useRef(initial) {
      const root = active; const i = root.cursor++;
      if (!(i in root.slots)) root.slots[i] = { current: initial };
      return root.slots[i];
    },
    useEffect(callback, deps) {
      const root = active; const i = root.cursor++; const previous = root.slots[i];
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        root.effects.push(() => {
          previous?.cleanup?.();
          root.slots[i] = { deps, cleanup: callback() };
        });
      }
    },
    useId: () => 'test-refresh',
  };
  let source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const anchor = "    return {\n      inject: ['slots', 'locale'],";
  assert.ok(source.includes(anchor));
  source = source.replace(anchor, '    globalThis.__refreshTest = { SettingsPage, store };\n' + anchor);
  const response = (value, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => clone(value) });
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => factory((id) => id === 'react' ? React : undefined) } },
    console, URL, AbortController, structuredClone,
    document: { baseURI: 'https://dsh.example/', hidden: false },
    localStorage: { getItem: () => null },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    async fetch(url, options) {
      const path = new URL(url).pathname.split('/ai-gateway/api/')[1];
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      if (path === 'state') return response(snapshot);
      if (path === 'refresh') {
        if (failRefresh) return response({ error: 'refresh failed' }, false);
        cache.clear();
        return response(snapshot);
      }
      if (path === 'models/discover') {
        // Discovery has a separate backend cache from models/list.
        return response({ models: upstream.get(body.channelId).map((e) => ({ ...e, status: 'enabled' })), missing: [] });
      }
      if (path === 'models/list') {
        if (body.force || !cache.has(body.channelId)) cache.set(body.channelId, clone(upstream.get(body.channelId)));
        const result = { channelId: body.channelId, entries: clone(cache.get(body.channelId)) };
        if (holdInitialList && calls.filter((c) => c.path === 'models/list').length === 1) await held.promise;
        return response(result);
      }
      if (path === 'models/set') {
        snapshot.revision++;
        cache.clear();
        return response(snapshot);
      }
      throw new Error(`unexpected request: ${path}`);
    },
  };
  vm.runInNewContext(source, sandbox);
  const { SettingsPage, store } = sandbox.__refreshTest;
  store.state = clone(snapshot);
  const all = (node) => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all), ...all(node.props?.footer)];
  function mount(component, props = {}) {
    const root = {
      slots: [], cursor: 0, effects: [], dirty: true, tree: null,
      render() {
        active = this; this.cursor = 0; this.dirty = false; this.tree = component(props); active = undefined;
        for (const effect of this.effects.splice(0)) effect();
      },
      find: (predicate) => all(root.tree).find(predicate),
      unmount() { for (const slot of this.slots) slot?.cleanup?.(); roots.splice(roots.indexOf(this), 1); },
    };
    roots.push(root); root.render(); return root;
  }
  const page = mount(SettingsPage);
  t.after(() => { for (const root of [...roots]) root.unmount(); store.dispose(); });
  async function flush() {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      for (const root of [...roots]) if (root.dirty) root.render();
    }
  }
  const capabilities = () => page.find((n) => n.type?.name === 'ModelsPanel');
  const sync = () => page.find((n) => n.type?.name === 'Button' && n.props.icon === 'refresh').props.onClick();
  return {
    calls, upstream, store, snapshot, flush, sync,
    releaseInitialList: () => held.resolve(),
    failRefresh: (value) => { failRefresh = value; },
    ids: () => clone(capabilities().props.view.models?.entries.map((m) => m.id) ?? []),
    listCalls: () => calls.filter((c) => c.path === 'models/list'),
    async showModels() {
      await flush();
      page.find((n) => n.props.id === 'nas-tab-models').props.onClick();
      await flush();
    },
    async discover() {
      const panel = capabilities(); const root = mount(panel.type, panel.props);
      root.find((n) => n.type?.name === 'Button' && n.props.icon === 'download').props.onClick();
      await flush();
      const dialog = root.find((n) => n.type?.name === 'DiscoverDialog');
      const modal = mount(dialog.type, dialog.props);
      await flush(); modal.unmount(); root.unmount();
    },
    async selectChannel(id) {
      page.find((n) => n.props.role === 'tab' && n.props.title === id).props.onClick();
      await flush();
    },
  };
}

test('Sync data reloads the visible capabilities without a settings revision change', async (t) => {
  const h = harness(t); await h.showModels();
  assert.deepEqual(h.ids(), ['a-old']);
  h.upstream.set('a', [entry('a-old'), entry('a-new')]);
  await h.sync(); await h.flush();
  assert.equal(h.store.state.revision, 1);
  assert.deepEqual(h.ids(), ['a-old', 'a-new']);
  assert.equal(h.listCalls().length, 2);
  assert.ok(h.listCalls().every((c) => c.body.channelId === 'a'), 'does not fetch other gateways');
});

test('fetching models refreshes automatic-mode capabilities even when nothing needs adding', async (t) => {
  const h = harness(t); await h.showModels();
  h.upstream.set('a', [entry('a-old'), entry('a-new')]);
  await h.discover();
  assert.equal(h.store.state.revision, 1);
  assert.deepEqual(h.ids(), ['a-old', 'a-new']);
  assert.equal(h.listCalls().at(-1).body.force, true, 'bypasses the separate capabilities catalog cache');
  assert.equal(h.calls.some((c) => c.path === 'models/set'), false, 'discovery does not edit the saved model list');
});

test('background snapshots do not refetch model catalogs', async (t) => {
  const h = harness(t); await h.showModels();
  h.upstream.set('a', [entry('a-new')]);
  for (let i = 0; i < 3; i++) { await h.store.load(); await h.flush(); }
  assert.equal(h.listCalls().length, 1);
  assert.deepEqual(h.ids(), ['a-old']);
});

test('a delayed old model response cannot overwrite a manual refresh', async (t) => {
  const h = harness(t, { holdInitialList: true }); await h.showModels();
  h.upstream.set('a', [entry('a-new')]);
  await h.sync(); await h.flush();
  assert.deepEqual(h.ids(), ['a-new']);
  h.releaseInitialList(); await h.flush();
  assert.deepEqual(h.ids(), ['a-new']);
});

test('failed sync preserves the list and a subsequent sync can retry', async (t) => {
  const h = harness(t); await h.showModels();
  h.upstream.set('a', [entry('a-new')]); h.failRefresh(true);
  await h.sync(); await h.flush();
  assert.equal(h.listCalls().length, 1);
  assert.deepEqual(h.ids(), ['a-old']);
  h.failRefresh(false); await h.sync(); await h.flush();
  assert.deepEqual(h.ids(), ['a-new']);
});

test('saved model changes still reload, and manual sync follows the selected channel', async (t) => {
  const h = harness(t); await h.showModels();
  h.upstream.set('a', [entry('a-added')]);
  await h.store.mutate('models/set', { channelId: 'a', add: ['a-added'], revision: 1 }); await h.flush();
  assert.equal(h.store.state.revision, 2);
  assert.deepEqual(h.ids(), ['a-added']);
  await h.selectChannel('b');
  assert.deepEqual(h.ids(), ['b-old']);
  h.upstream.set('b', [entry('b-new')]);
  const before = h.listCalls().length;
  await h.sync(); await h.flush();
  assert.deepEqual(h.ids(), ['b-new']);
  assert.equal(h.listCalls().length, before + 1);
  assert.equal(h.listCalls().at(-1).body.channelId, 'b');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual editor's event handlers with a minimal hook renderer, without
// a browser/profile/token or a separate mock UI implementation.
function harness() {
  const slots = []; let cursor = 0; let exports;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((v) => v !== null && v !== undefined && v !== false) }),
    Fragment: 'fragment',
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect: () => {}, useId: () => 'test-editor',
  };
  let source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const anchor = "    return {\n      inject: ['slots', 'locale'],";
  assert.ok(source.includes(anchor));
  source = source.replace(anchor, "    globalThis.__editorTest = { ModelEditor, store };\n" + anchor);
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => factory((id) => id === 'react' ? React : undefined) } }, console, setTimeout, clearTimeout, AbortController, URL, document: {} };
  vm.runInNewContext(source, sandbox);
  exports = sandbox.__editorTest;
  const writes = []; exports.store.mutate = async (path, body) => { writes.push(JSON.parse(JSON.stringify(body))); return {}; };
  const model = { id: 'gpt-example', kind: 'chat', override: {}, automaticReasoning: true, automaticReasoningKnown: true, automaticReasoningLevels: ['medium', 'high'], automaticThinkingLevelMap: { medium: 'medium', high: 'high' }, reasoning: true, reasoningLevels: ['medium', 'high'], speedEnabled: true, allowedServiceTiers: ['default', 'priority', 'ultrafast'], speedTiers: { source: 'gateway', tiers: ['priority', 'ultrafast'], compatible: true }, input: ['text'] };
  function render() { cursor = 0; return exports.ModelEditor({ model, channel: { id: 'gw', name: 'Gateway' }, revision: 1, onClose: () => {}, onSaved: () => {} }); }
  function all(node) { if (!node || typeof node !== 'object') return []; return [node, ...(node.children ?? []).flatMap(all), ...all(node.props?.footer)]; }
  const text = (node) => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
  const find = (predicate) => all(render()).find(predicate);
  async function save() { find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} }); for (let i = 0; i < 8; i++) await Promise.resolve(); return writes.at(-1); }
  const component = (name) => find((node) => node.type?.name === name);
  const view = (name) => { const node = component(name); return node.type(node.props); };
  return { model, render, all, text, find, save, writes, component, view };
}

test('reasoning and speed panels expose the same row-table and master-switch interaction', () => {
  const h = harness();
  for (const name of ['ReasoningLevelsEditor', 'SpeedLevelsEditor']) {
    const nodes = h.all(h.view(name));
    assert.ok(nodes.some((n) => n.props.role === 'switch' && n.props['aria-checked'] === true));
    assert.ok(nodes.some((n) => n.props.className === 'nas-levels-table'));
    assert.ok(nodes.some((n) => n.props.className === 'nas-levels-add'));
    assert.ok(nodes.some((n) => n.props.className === 'nas-levels-remove'));
  }
});

test('panel master switches independently disable reasoning and speed', async () => {
  const h = harness();
  h.component('ReasoningLevelsEditor').props.onToggle();
  h.component('SpeedLevelsEditor').props.onToggle();
  for (const name of ['ReasoningLevelsEditor', 'SpeedLevelsEditor']) {
    assert.equal(h.all(h.view(name)).some((n) => n.props.className === 'nas-levels-table'), false);
  }
  const saved = await h.save();
  assert.equal(saved.override.reasoning, false);
  assert.equal(saved.override.speedEnabled, false);
  assert.equal(saved.override.serviceTier, null);
});

test('reasoning rows can be deleted and preserve the remaining wire values', async () => {
  const h = harness();
  h.model.override = { reasoning: true, defaultReasoningEffort: 'high' };
  const rows = h.all(h.view('ReasoningLevelsEditor')).filter((n) => n.props.className === 'nas-levels-remove');
  rows[1].props.onClick();
  const saved = await h.save();
  assert.equal(saved.override.defaultReasoningEffort, null);
  assert.equal(saved.override.thinkingLevelMap.medium, 'medium');
  assert.equal('high' in saved.override.thinkingLevelMap, false);
});

test('reasoning row changes update both selector and wire value instead of retaining old effort', async () => {
  const h = harness();
  const select = h.all(h.view('ReasoningLevelsEditor')).find((n) => n.type === 'select');
  select.props.onChange({ target: { value: 'low' } });
  const saved = await h.save();
  assert.equal(saved.override.thinkingLevelMap.low, 'low');
  assert.equal(saved.override.thinkingLevelMap.high, 'high');
  assert.equal('medium' in saved.override.thinkingLevelMap, false);
});

test('speed row delete/add and wire values use the same table controls', async () => {
  const h = harness();
  const rows = h.all(h.view('SpeedLevelsEditor')).filter((n) => n.props.className === 'nas-levels-remove');
  rows[2].props.onClick();
  let saved = await h.save();
  assert.deepEqual(saved.override.allowedServiceTiers, ['default', 'priority']);
  assert.equal(saved.override.reasoning, null);
  const add = h.all(h.view('SpeedLevelsEditor')).find((n) => n.props.className === 'nas-levels-add');
  assert.equal(add.props.disabled, false); add.props.onClick();
  saved = await h.save();
  assert.deepEqual(saved.override.allowedServiceTiers, ['default', 'priority', 'ultrafast']);
  const wires = h.all(h.view('SpeedLevelsEditor')).filter((n) => n.type === 'input');
  assert.deepEqual(wires.map((n) => n.props.value), ['default', 'priority', 'ultrafast']);
  assert.ok(wires.every((n) => !n.props.readOnly && typeof n.props.onChange === 'function'));
});

test('both row editors prevent duplicate choices and deletion of the last row', () => {
  const h = harness();
  for (const name of ['ReasoningLevelsEditor', 'SpeedLevelsEditor']) {
    const nodes = h.all(h.view(name));
    const selects = nodes.filter((n) => n.type === 'select');
    assert.ok(selects[0].children.some((n) => n.type === 'option' && n.props.value === selects[1].props.value && n.props.disabled));
  }
  h.component('SpeedLevelsEditor').props.onChange([{ level: 'default', value: 'default' }]);
  assert.equal(h.all(h.view('SpeedLevelsEditor')).find((n) => n.props.className === 'nas-levels-remove').props.disabled, true);
  h.component('ReasoningLevelsEditor').props.onChange([{ level: 'medium', value: 'medium' }]);
  assert.equal(h.all(h.view('ReasoningLevelsEditor')).find((n) => n.props.className === 'nas-levels-remove').props.disabled, true);
});

test('custom speed can be added even when no further gateway tiers were matched', async () => {
  const h = harness();
  h.model.speedTiers.tiers = ['priority'];
  h.model.allowedServiceTiers = ['default', 'priority'];
  const add = h.all(h.view('SpeedLevelsEditor')).find((n) => n.props.className === 'nas-levels-add');
  assert.equal(add.props.disabled, false); add.props.onClick();
  let nodes = h.all(h.view('SpeedLevelsEditor'));
  nodes.find((n) => n.props['aria-label'] === '自定义速度档位名').props.onChange({ target: { value: 'turbo' } });
  nodes = h.all(h.view('SpeedLevelsEditor'));
  nodes.filter((n) => n.type === 'input' && n.props['aria-label'] === 'API 参数值')[2].props.onChange({ target: { value: 'vendor-priority' } });
  const saved = await h.save();
  assert.deepEqual(saved.override.allowedServiceTiers, ['default', 'priority', 'turbo']);
  assert.equal(saved.override.serviceTierMap.turbo, 'vendor-priority');
  assert.equal(saved.override.serviceTier, 'default', 'adding a custom option must not select it automatically');
});

test('preset speed API values can be edited without changing local selector identity', async () => {
  const h = harness();
  const wire = h.all(h.view('SpeedLevelsEditor')).filter((n) => n.type === 'input' && n.props['aria-label'] === 'API 参数值')[1];
  wire.props.onChange({ target: { value: 'fast-lane' } });
  const saved = await h.save();
  assert.equal(saved.override.serviceTierMap.priority, 'fast-lane');
  assert.ok(saved.override.allowedServiceTiers.includes('priority'));
});

test('preset selector offers a direct custom-name option', async () => {
  const h = harness();
  let select = h.all(h.view('SpeedLevelsEditor')).find((n) => n.type === 'select');
  assert.ok(select.children.some((n) => n.props.value === '__custom'));
  select.props.onChange({ target: { value: '__custom' } });
  h.all(h.view('SpeedLevelsEditor')).find((n) => n.props['aria-label'] === '自定义速度档位名').props.onChange({ target: { value: 'economy' } });
  const wires = h.all(h.view('SpeedLevelsEditor')).filter((n) => n.type === 'input' && n.props['aria-label'] === 'API 参数值');
  wires[0].props.onChange({ target: { value: 'flex' } });
  const saved = await h.save();
  assert.equal(saved.override.serviceTierMap.economy, 'flex');
  assert.equal(saved.override.serviceTier, null, 'renaming the default option should not auto-select a billed tier');
});

test('invalid, duplicate or blank custom speed rows are blocked before mutation', async () => {
  for (const rows of [
    [{ level: '', value: '' }], [{ level: 'Bad Name', value: 'turbo' }], [{ level: 'constructor', value: 'turbo' }],
    [{ level: 'turbo', value: '' }], [{ level: 'turbo', value: 'x'.repeat(129) }], [{ level: 'turbo', value: 'x\u0000y' }],
    [{ level: 'turbo', value: 'fast' }, { level: 'turbo', value: 'priority' }],
  ]) {
    const h = harness(); h.component('SpeedLevelsEditor').props.onChange(rows);
    assert.equal(await h.save(), undefined); assert.equal(h.writes.length, 0);
  }
});

test('default-speed field stays removed and only row selection remains', async () => {
  const h = harness();
  assert.equal(h.find((n) => n.type === 'select' && n.props.id?.endsWith('-service-tier')), undefined);
  assert.equal(h.find((n) => n.props.label === '此网关下该模型的默认速度'), undefined);
  assert.equal((await h.save()).override.serviceTier, 'default');
});


test('row editor preserves legacy pinned reasoning subsets when opened and saved', async () => {
  const h = harness();
  h.model.override = { reasoningLevels: ['high'] };
  assert.deepEqual(JSON.parse(JSON.stringify(h.component('ReasoningLevelsEditor').props.rows)), [{ level: 'high', value: 'high' }]);
  const saved = await h.save();
  assert.equal(saved.override.thinkingLevelMap.high, 'high');
  assert.equal('medium' in saved.override.thinkingLevelMap, false);
});

test('reasoning preset changes use the detected wire mapping for off/none', async () => {
  const h = harness(); h.model.automaticThinkingLevelMap.off = 'none';
  const select = h.all(h.view('ReasoningLevelsEditor')).find((n) => n.type === 'select');
  select.props.onChange({ target: { value: 'off' } });
  assert.equal((await h.save()).override.thinkingLevelMap.off, 'none');
});

/**
 * Gateway channels: what is saved, and the only code path that saves it.
 *
 * A channel is written only after a successful probe of the exact address and
 * token being saved, so a saved gateway is always one that listed its models at
 * save time. The probe's findings (backend family, which quota endpoint answers)
 * are stored with the channel, so later reads never have to guess again.
 *
 * Kept free of DSH imports: the host passes settings, credentials and the probe in.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gatewayRoot } from './probe.js';

// Schemastery may materialize absent optional fields; compare and persist plain JSON.
const jsonConfig = (value) => JSON.parse(JSON.stringify(value ?? null));
export const channelError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export function hostLabel(url) {
  try { return new URL(gatewayRoot(url)).host; } catch { return 'gateway'; }
}

/** Credential reference prefix; one fresh name per saved token. */
export function keyNameFor(id) {
  return `AI_GATEWAY_${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

export function validateBaseURL(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw channelError(400, 'enter a gateway address', 'address');
  let url;
  try { url = new URL(value.trim()); } catch { throw channelError(400, 'the gateway address is not a valid URL', 'address'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw channelError(400, 'use an http(s) address without credentials, query or fragment', 'address');
  }
  return gatewayRoot(url.href);
}

export function resolveChannels(raw = {}) {
  const list = (Array.isArray(raw.channels) ? raw.channels : [])
    .filter((c) => c && typeof c.id === 'string' && c.id && typeof c.baseURL === 'string')
    .map((c) => ({ ...c, name: c.name || hostLabel(c.baseURL), headers: c.headers ?? {}, apiKeyEnv: c.apiKeyEnv || keyNameFor(c.id) }));
  if (new Set(list.map((c) => c.id)).size !== list.length) throw channelError(400, 'duplicate channel ids');
  return { list, active: list.find((c) => c.id === raw.activeChannel) ?? list[0] };
}

/** What a successful probe contributes to a saved channel. Absent fields are omitted, never null. */
export function backendOf(report) {
  const out = { family: report.backend?.family ?? 'unknown', modelCount: report.models?.count ?? 0, checkedAt: Date.now() };
  if (report.backend?.name) out.name = String(report.backend.name).slice(0, 120);
  if (report.backend?.version) out.version = String(report.backend.version).slice(0, 60);
  if (report.quota?.kind) out.quotaKind = report.quota.kind;
  return out;
}

/** Serialized, compare-and-swap writes. The page and any future agent tool share this. */
export class ChannelService {
  constructor(host) {
    this.host = host;
    this.queue = Promise.resolve();
  }

  descriptor() {
    const d = this.host.settings()?.describe().find((x) => x.ns === this.host.ns);
    if (!d || !Number.isInteger(d.revision)) throw channelError(503, 'gateway settings are unavailable');
    return d;
  }

  revision() { return this.descriptor().revision; }

  run(action, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(channelError(400, 'request must be an object'));
    if (!['save', 'activate', 'delete'].includes(action)) return Promise.reject(channelError(400, 'unknown action'));
    const result = this.queue.then(() => this.write(action, args));
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * Probe without saving. With a saved channel id and no token, the saved token is
   * used — but never for a different address, so it cannot be sent to another host.
   */
  async check({ id, baseURL, apiKey }) {
    if (apiKey !== undefined && typeof apiKey !== 'string') throw channelError(400, 'apiKey must be a string');
    const { list } = resolveChannels(this.host.current());
    const ch = id ? list.find((c) => c.id === id) : undefined;
    if (id && !ch) throw channelError(404, 'unknown gateway');
    const root = validateBaseURL(baseURL ?? ch?.baseURL);
    const typed = apiKey?.trim();
    if (!typed && ch && gatewayRoot(ch.baseURL) !== root) throw channelError(400, 'enter the token again: the address changed', 'key-required');
    const key = typed || (ch ? await this.host.keyFor(ch) : undefined);
    const headers = ch && gatewayRoot(ch.baseURL) === root ? { ...ch.headers } : {};
    return this.host.probe({ baseURL: root, apiKey: key, headers });
  }

  async write(action, args) {
    const revision = this.revision();
    if (!Number.isInteger(args.revision)) throw channelError(400, 'revision is required; reload first');
    if (revision !== args.revision) throw channelError(409, 'gateway settings changed in another window; reload and try again', 'conflict');
    const state = resolveChannels(this.host.current());
    const list = jsonConfig(state.list);
    let active = state.active?.id;
    let ch = args.id ? list.find((c) => c.id === args.id) : undefined;
    if (args.id && !ch) throw channelError(404, 'unknown gateway');
    let stagedKey;
    let retiredKey;
    let report;

    if (action === 'save') {
      const baseURL = validateBaseURL(args.baseURL);
      const name = String(args.name ?? '').trim() || hostLabel(baseURL);
      if (name.length > 120) throw channelError(400, 'gateway name is too long');
      if (args.apiKey !== undefined && typeof args.apiKey !== 'string') throw channelError(400, 'apiKey must be a string');
      const apiKey = args.apiKey?.trim();
      if (apiKey && /\s/.test(apiKey)) throw channelError(400, 'the token must not contain spaces');
      if (!ch && !apiKey) throw channelError(400, 'enter the token for this gateway', 'key-required');
      if (ch && gatewayRoot(ch.baseURL) !== baseURL && !apiKey) throw channelError(400, 'enter the token again: the address changed', 'key-required');

      // The save itself proves the gateway works; the page's earlier check is advisory.
      report = await this.host.probe({
        baseURL,
        apiKey: apiKey || await this.host.keyFor(ch),
        headers: ch && gatewayRoot(ch.baseURL) === baseURL ? { ...ch.headers } : {},
      });
      if (!report.usable) {
        throw channelError(400, `the gateway did not list its models: ${report.models?.error ?? 'unknown error'}`, report.models?.code ?? 'unusable');
      }

      if (!ch) {
        ch = { id: `gw-${randomUUID().slice(0, 8)}`, headers: {} };
        list.push(ch);
      }
      Object.assign(ch, { name, baseURL, backend: backendOf(report) });
      if (apiKey) {
        // A fresh reference per token: a failed write can never rotate the live one.
        retiredKey = ch.apiKeyEnv;
        stagedKey = `${keyNameFor(ch.id)}_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
        ch.apiKeyEnv = stagedKey;
      }
      if (args.activate === true || !active) active = ch.id;
    } else if (action === 'activate') {
      active = ch.id;
    } else {
      list.splice(list.indexOf(ch), 1);
      retiredKey = ch.apiKeyEnv;
      if (active === ch.id) active = list[0]?.id;
    }

    const ops = [{ op: 'set', path: ['channels'], value: list }];
    ops.push(active ? { op: 'set', path: ['activeChannel'], value: active } : { op: 'unset', path: ['activeChannel'] });
    try {
      if (stagedKey) await this.host.storeKey(stagedKey, args.apiKey.trim());
      await this.host.settings().mutate(this.host.ns, ops, revision);
    } catch (error) {
      if (stagedKey) await this.host.unsetKey(stagedKey).catch(() => {});
      if (error?.code === 'SETTINGS_CONFLICT') throw channelError(409, 'gateway settings changed in another window; reload and try again', 'conflict');
      throw error;
    }
    const applied = resolveChannels(this.host.current());
    if (!isDeepStrictEqual(jsonConfig(applied.list), list) || applied.active?.id !== active) {
      throw channelError(503, 'saved, but the live settings did not update; reload the page');
    }
    // Only tokens this plugin created are removed, and only after the write landed.
    if (retiredKey && retiredKey !== stagedKey && retiredKey.startsWith('AI_GATEWAY_')) {
      const stillUsed = applied.list.some((c) => c.apiKeyEnv === retiredKey);
      if (!stillUsed) await this.host.unsetKey(retiredKey).catch(() => {});
    }
    this.host.changed?.();
    return { ok: true, revision: this.revision(), channelId: ch.id, activeChannel: active ?? null, ...(report ? { report } : {}) };
  }
}

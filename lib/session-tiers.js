/**
 * Per-conversation speed tier choices, made from the composer.
 *
 * Key: session id + channel id + model id. A choice belongs to one conversation and
 * one exact gateway model, so switching model or gateway never carries a paid tier
 * somewhere it was not chosen. `null` stored for a key means "follow the model's
 * default"; absence means the same. The model editor's default is the fallback.
 */
import { readCache, writeCache } from './util.js';
import { SERVICE_TIERS } from './service-tiers.js';

const FILE = 'session-tiers.json';
const LIMIT = 2000;
const ID = /^[^\u0000-\u001f\u007f]{1,512}$/;

export class SessionTiers {
  constructor({ logger } = {}) {
    this.logger = logger;
    const saved = readCache(FILE);
    this.map = new Map(Array.isArray(saved?.entries) ? saved.entries.filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && SERVICE_TIERS.includes(e[1])) : []);
  }

  static key(sessionId, channelId, modelId) {
    for (const [name, value] of [['sessionId', sessionId], ['channelId', channelId], ['modelId', modelId]]) {
      if (typeof value !== 'string' || !ID.test(value)) throw Object.assign(new Error(`${name} is invalid`), { status: 400 });
    }
    return `${sessionId}\u0000${channelId}\u0000${modelId}`;
  }

  get(sessionId, channelId, modelId) {
    if (!sessionId) return undefined;
    try { return this.map.get(SessionTiers.key(String(sessionId), channelId, modelId)); } catch { return undefined; }
  }

  /** `tier` null/undefined clears the conversation choice (falls back to the model default). */
  set(sessionId, channelId, modelId, tier) {
    const key = SessionTiers.key(sessionId, channelId, modelId);
    if (tier !== null && tier !== undefined && !SERVICE_TIERS.includes(tier)) throw Object.assign(new Error('invalid service tier'), { status: 400 });
    this.map.delete(key);
    if (tier !== null && tier !== undefined) this.map.set(key, tier);
    while (this.map.size > LIMIT) this.map.delete(this.map.keys().next().value);
    this.persist();
  }

  /** Drop choices for a gateway that no longer exists. */
  forgetChannel(channelId) {
    let changed = false;
    for (const key of this.map.keys()) if (key.split('\u0000')[1] === channelId) { this.map.delete(key); changed = true; }
    if (changed) this.persist();
  }

  persist() {
    try { writeCache(FILE, { entries: [...this.map.entries()] }); }
    catch (error) { this.logger?.warn?.(`ai-gateway: could not save session speed tiers: ${error?.message ?? error}`); }
  }
}

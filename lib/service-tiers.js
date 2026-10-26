/**
 * Gateway-scoped OpenAI service tiers (speed modes).
 *
 * Neither a model name nor models.dev can establish whether this gateway, for this
 * model, on this account, actually serves an accelerated tier. Three kinds of evidence
 * exist, and they are kept apart:
 *   1. declaration — the gateway's own catalog lists the tier for this model;
 *   2. observation — a test request with the tier came back stamped with it;
 *   3. user choice — the user opted to try a tier nobody declared.
 * None is inferred from another. A declaration is never a billed test.
 */
export const SERVICE_TIERS = ['default', 'priority', 'ultrafast'];
export const ACCELERATED_TIERS = ['priority', 'ultrafast'];
export const DEFAULT_ENDPOINT_PRIORITY = ['openai', 'anthropic', 'openai-response', 'gemini'];
const PROTOCOLS = new Set(DEFAULT_ENDPOINT_PRIORITY);
const OPENAI_PROTOCOLS = new Set(['openai', 'openai-response', 'openai-completions', 'openai-responses', 'responses']);
const TIER_ID = /^[a-z][a-z0-9_-]{0,31}$/;

/** Match the adapter's selected protocol, not merely one protocol in a multi-protocol list. */
export function selectedProtocol(endpointTypes, priority = DEFAULT_ENDPOINT_PRIORITY) {
  const advertised = endpointTypes?.length ? endpointTypes : ['openai'];
  for (const type of priority) if (advertised.includes(type) && PROTOCOLS.has(type)) return type;
  return advertised.find((type) => PROTOCOLS.has(type)) ?? 'openai';
}

/** OpenAI's documented `fast` spelling is the same tier as `priority`; overrides store one value. */
export function canonicalTier(value) {
  return value === 'fast' ? 'priority' : value;
}

/** One tier element: a plain id (`"priority"`) or CLIProxyAPI's `{ id, name, description }`. */
function tierId(value) {
  const id = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) ? value.id : undefined;
  return typeof id === 'string' && TIER_ID.test(id) ? canonicalTier(id) : undefined;
}

/**
 * What one gateway catalog entry declares. Recognised fields, all per model:
 *   - `supported_service_tiers` / `service_tiers`: strings or `{ id }` objects;
 *   - `additional_speed_tiers`: strings (CLIProxyAPI's Codex catalog: `["fast"]`).
 * An empty array is an explicit "no accelerated tier"; anything malformed is unknown,
 * never guessed. Global/provider-level metadata is deliberately not consulted.
 */
export function advertisedServiceTiers(model) {
  if (!model || typeof model !== 'object') return { source: 'unknown', tiers: [] };
  const found = new Set();
  let declared = false;
  for (const key of ['supported_service_tiers', 'service_tiers', 'additional_speed_tiers']) {
    if (!Object.hasOwn(model, key)) continue;
    const value = model[key];
    if (!Array.isArray(value) || value.length > 32) return { source: 'unknown', tiers: [] };
    const ids = value.map(tierId);
    if (ids.some((id) => id === undefined)) return { source: 'unknown', tiers: [] };
    declared = true;
    for (const id of ids) found.add(id);
  }
  if (!declared) return { source: 'unknown', tiers: [] };
  return { source: 'gateway', tiers: SERVICE_TIERS.filter((tier) => found.has(tier)) };
}

/**
 * A saved tier is refused only when it can never mean anything: an unknown value, a
 * non-chat model, or a protocol without `service_tier`. An undeclared tier is the user's
 * explicit, acknowledged choice and is sent as chosen (the page warns before saving it).
 */
export function serviceTierError(entry, protocol) {
  const selected = entry?.serviceTier;
  if (selected === undefined || selected === null) return undefined;
  if (!SERVICE_TIERS.includes(selected)) return 'invalid service tier; use default, priority or ultrafast';
  if (entry?.kind && entry.kind !== 'chat') return 'OpenAI service tiers are only supported for chat models';
  if (!OPENAI_PROTOCOLS.has(protocol)) return 'OpenAI service tiers require OpenAI Chat Completions or Responses; clear the service tier or change the protocol';
  return undefined;
}

export function assertServiceTier(entry, protocol) {
  const error = serviceTierError(entry, protocol);
  if (error) throw Object.assign(new Error(error), { code: 'UNSUPPORTED_SERVICE_TIER', status: 400 });
  return entry?.serviceTier ?? undefined;
}

export function speedTiersFor(model, selected, protocol, kind = 'chat') {
  const info = {
    ...advertisedServiceTiers(model),
    selected: selected ?? null,
    protocol,
    compatible: kind === 'chat' && OPENAI_PROTOCOLS.has(protocol),
  };
  // Declared means "the gateway says it serves it"; anything else accelerated is a user trial.
  info.selectionSource = selected == null ? 'none'
    : selected === 'default' || (info.source === 'gateway' && info.tiers.includes(selected)) ? 'declared'
      : 'manual';
  const error = serviceTierError({ kind, serviceTier: selected }, protocol);
  if (error) info.validationError = error;
  return info;
}

/**
 * Judge one test: did the response carry the tier that was asked for?
 *   verified    — the response names the requested accelerated tier;
 *   downgraded  — the response names another tier (usually `default`: the gateway dropped
 *                 the parameter, or the upstream fell back and billed standard);
 *   unconfirmed — the response named no tier, so nothing can be concluded either way.
 * Latency is never evidence: a fast answer at standard tier proves nothing.
 */
export function tierOutcome(requested, returned) {
  if (!requested || !ACCELERATED_TIERS.includes(requested)) return undefined;
  if (typeof returned !== 'string' || !returned) return 'unconfirmed';
  return canonicalTier(returned) === requested ? 'verified' : 'downgraded';
}

/**
 * Only alter the final serialized payload. Preserve history/model identities and
 * the caller's explicit onPayload callback, then apply the saved wire identity
 * and service tier. The no-override path is untouched (including SDK defaults).
 */
export function withModelPayload(api, mapping, entries = new Map(), protocol, tierFor) {
  const wrap = (method) => (model, context, options) => {
    const upstreamModel = mapping.get(model.id);
    const entry = entries.get(model.id);
    // A conversation's own choice (composer) wins over the model default (editor).
    const chosen = tierFor?.(options?.sessionId, model.id);
    const effective = chosen === undefined ? entry : { ...entry, serviceTier: chosen ?? undefined };
    const serviceTier = assertServiceTier(effective, protocol);
    const mapped = upstreamModel && upstreamModel !== model.id;
    if (!mapped && serviceTier === undefined) return api[method](model, context, options);
    return api[method](model, context, {
      ...options,
      onPayload: async (payload, nativeModel) => {
        const next = await options?.onPayload?.(payload, nativeModel);
        return { ...(next ?? payload), ...(mapped ? { model: upstreamModel } : {}), ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}) };
      },
    });
  };
  return { ...api, stream: wrap('stream'), streamSimple: wrap('streamSimple') };
}

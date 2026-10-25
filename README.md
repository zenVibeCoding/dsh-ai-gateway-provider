# AI Gateway for DeepSeek Harness

[![npm](https://img.shields.io/npm/v/dsh-ai-gateway-provider)](https://www.npmjs.com/package/dsh-ai-gateway-provider)
[![license](https://img.shields.io/npm/l/dsh-ai-gateway-provider)](LICENSE)

Connect **any OpenAI-compatible gateway** to DeepSeek Harness.

Most providers are the same three endpoints with different names on the box. Instead of a list of supported vendors, this plugin follows the protocol and probes each gateway for what it can actually do: if it speaks `/v1/models` and `/v1/chat/completions`, it works — including a gateway nobody has heard of yet.

![Gateways](docs/screenshots/channels.png)

## Install

```sh
# in DeepSeek Harness → Settings → Plugins → install by package name
dsh-ai-gateway-provider
```

Requires DSH ≥ 0.2.1-rc.1.

## What it does

- **Probe before saving.** A gateway is written only after it lists its models with the address and token you entered. A wrong URL or a revoked token is refused at that moment, not on the first message.
- **Model management per gateway.** Fetch the gateway's list, add a model it does not list, edit any model's name, upstream mapping, context window, output cap, input modalities, reasoning levels and wire protocol, and hide what you do not want.
- **Grouped model table.** Models are grouped by vendor — `devin/claude-opus-5` and `claude-opus-5-5` sit together under Anthropic — with a per-group "tested / working" count. Groups collapse, and the grouping can be switched off.
- **Hide models.** Hide one model, or a whole vendor group, from the chat picker without removing it; Hidden models stay in the list, greyed out, so clicking again unhides them. Hiding never turns an automatic gateway into a fixed list.
- **Model tests.** Test one model or a batch: one tiny request each, bounded output, errors classified (no upstream channel, invalid token, rate limited, timed out).
- **Quota where it exists, silence where it does not.** New API, LiteLLM and one-api-family backends report quota; every other gateway simply shows no quota instead of an error.
- **The gateway's own identity.** The channel shows the site's favicon when it has one, its declared name (page title, then the backend's own name), its version, chat protocols and public facts. Unknown gateways fall back to a neutral icon.

![Model capabilities](docs/screenshots/models.png)

## Supported backends

The plugin never needs to recognise a vendor — recognition only decides the icon and which quota endpoint to call.

| Backend | Detected by | Quota |
| --- | --- | --- |
| New API / one-api / done-hub / one-hub / Veloera / VoAPI | `GET /api/status` (`system_name`, `quota_per_unit`) | `GET /api/usage/token/` |
| LiteLLM | `GET /key/info` answering | key budget (`spend` / `max_budget`) |
| CLIProxyAPI | `GET /` banner `CLI Proxy API Server` | none |
| Anything else that is OpenAI-compatible | `GET /v1/models` answering | none |

Wire protocols per model: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini. The gateway's `supported_endpoint_types` decides; the model editor can override.

## Add a gateway

![Add gateway](docs/screenshots/add.png)

1. Settings → AI Gateway → **Add gateway**.
2. Enter the address and token, then **Test connection**.
3. The name is filled with what the gateway calls itself (only when you have not typed one), its favicon previews in the address field, and the check reports the model counts.
4. Save. The gateway's models appear in the chat model picker under **AI Gateway**.

Only one gateway is active at a time; switching affects every session using the plugin. Tokens are stored in the DSH credential store — never in the config, never returned to the page.

## Privacy and safety

- Requests are read-only `GET`s; **no model is called and nothing is billed** by probing.
- Redirects are never followed, so a token cannot be forwarded to another host.
- Site icons are fetched only from the gateway's own origin, size-limited, and cached on disk for 24 hours.
- Identification uses only public endpoints and stores only public facts (family, version, title, icon) — no token, no user data.
- A gateway without a quota endpoint is reported as having none, never as an error.

## Limits

- No image or video generation tools: the New API tools in `dsh-newapi-provider` depend on its own task API. A gateway's image models are listed but not driven from here.
- Quota adapters cover the three families above. A backend that exposes quota some other way shows none until an adapter is added.
- Gateway identification is heuristic; a gateway that hides every public endpoint is treated as a plain OpenAI-compatible endpoint, which is still enough to use it.

## Development

```sh
npm test                                    # 94 tests against local fake gateways
node scripts/probe.mjs --base <url>         # probe from a shell
GATEWAY_KEY=sk-... node scripts/probe.mjs --base <url>
```

## License

MIT

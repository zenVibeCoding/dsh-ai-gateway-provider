# AI Gateway for DeepSeek Harness

> **Preview 0.1.0** — this build only probes gateways. It does not register a model route yet and cannot affect conversations. Not published to npm.

Connect any OpenAI-compatible gateway. Instead of a list of supported vendors, the plugin follows the protocol standards and probes each gateway for what it can actually do.

## What is standard and what is not

| Layer | Standard | Used as |
| --- | --- | --- |
| Model list | `GET /v1/models` | Required. Its answer decides whether a gateway is usable. |
| Chat | OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini `generateContent` | Per model, from `supported_endpoint_types` or set by hand. |
| Images | `/v1/images/generations`, `/v1/images/edits` | Optional. |
| Video | `/v1/videos` (OpenAI family only) | Optional. |
| **Quota** | **None** | Optional adapters. A gateway without one still works; quota is just hidden. |

## Probe

Settings → AI Gateway → *Probe a gateway*, or from a shell:

```sh
GATEWAY_KEY=sk-... node scripts/probe.mjs --base https://gateway.example.com
```

Every request is a read-only `GET`; no model is called and nothing is billed. The probe:

1. reads `GET /v1/models` with the token — the only required step;
2. reads `GET /api/status` without the token, to recognise the backend family;
3. tries quota adapters in order, stopping at the first that answers:
   - **New API family** — `GET /api/usage/token/`, converted with the site's own display rules;
   - **LiteLLM** — `GET /key/info` (key sent only in the `Authorization` header, never in the URL);
   - **OpenAI-style billing routes** — `GET /v1/dashboard/billing/subscription` + `/usage`, still served by one-api forks.

Safety: redirects are never followed, so a token cannot be forwarded to another host; bodies are size-limited; the token never appears in results or errors and is not stored by the page.

## Development

```sh
npm test          # probe tests against local fake gateways
npm run probe -- --base <url>
```

Planning notes live in `~/dsh-ai-gateway-plugin/task_plan.md`.

## License

MIT

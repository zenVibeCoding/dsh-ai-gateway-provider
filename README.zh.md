# AI 网关（DeepSeek Harness 插件）

[![npm](https://img.shields.io/npm/v/dsh-ai-gateway-provider)](https://www.npmjs.com/package/dsh-ai-gateway-provider)
[![license](https://img.shields.io/npm/l/dsh-ai-gateway-provider)](LICENSE)

把**任意 AI 网关**接进 DeepSeek Harness——对话可走 OpenAI、Anthropic、Gemini 协议，模型、参数、额度一处管好。

![AI 网关](assets/cover.png)

这类项目本质上是同样的三个接口，只是名字不同。所以这个插件不去维护一份厂商清单，而是按协议来：只要它说 `/v1/models` 和 `/v1/chat/completions`，就能用——包括一个还没人听过的新网关。

![渠道列表](docs/screenshots/channels.png)

## 安装

```sh
# DeepSeek Harness → 设置 → 内置插件 → 按包名安装
dsh-ai-gateway-provider
```

需要 DSH ≥ 0.2.1-rc.1。

## 它做什么

- **先探测再保存。** 只有用你填的地址和令牌成功列出模型，网关才会被写入配置；地址错了、令牌被吊销了，当场就拒绝，不会等到第一条消息才失败。
- **按网关管理模型。** 拉取网关的模型清单、添加它没有列出的模型、逐个改名称/上游映射/上下文/输出上限/输入能力/推理等级/协议，也能隐藏不想要的。
- **模型按厂商分组。** `devin/claude-opus-5` 和 `claude-opus-5-5` 会归到 Anthropic 一组，组头显示「已测 N · 可用 M」；分组可折叠，也可以整体关掉。
- **隐藏模型。** 单个模型或整组厂商都可以从对话选择器里隐藏，不删除；隐藏的模型留在列表原位、显示为置灰，再点一次即可取消隐藏。隐藏不会把自动模式的网关变成固定清单。
- **模型测试。** 单个或批量：每次一个极短请求，输出有上限，错误会分类（无可用渠道、令牌无效、限流、超时）。
- **有额度就显示，没有就不显示。** New API、LiteLLM、one-api 系会报告额度；其它网关直接不显示额度，而不是显示成错误。
- **网关自己的身份。** 渠道图标优先用站点自己的 favicon，名称用站点声明的名字（页面标题 → 后端自报名称），并显示版本、对话协议和公开信息；识别不出类型时用中性图标。

![模型能力](docs/screenshots/models.png)

## 支持的后端

插件并不需要认识厂商——识别只决定图标和用哪个额度接口。

| 后端 | 识别依据 | 额度 |
| --- | --- | --- |
| New API / one-api / done-hub / one-hub / Veloera / VoAPI | `GET /api/status`（`system_name`、`quota_per_unit`） | `GET /api/usage/token/` |
| LiteLLM | `GET /key/info` 有应答 | 密钥预算（`spend` / `max_budget`） |
| CLIProxyAPI | `GET /` 返回 `CLI Proxy API Server` | 无 |
| 其它任何 OpenAI 兼容网关 | `GET /v1/models` 有应答 | 无 |

每个模型的协议：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini。由网关的 `supported_endpoint_types` 决定，模型编辑器里可以覆盖。

## 添加网关

![添加网关](docs/screenshots/add.png)

1. 设置 → AI 网关 → **添加渠道**。
2. 填地址和令牌，点 **测试连接**。
3. 名称会自动填成网关自己声明的名字（只在你没填过时），地址栏显示它的 favicon，检查结果里给出模型数量。
4. 保存。这个网关的模型会出现在对话的模型选择器里，名字是 **AI Gateway**。

同一时间只激活一个网关，切换会影响所有使用此插件的会话。令牌只写进 DSH 凭据库——不进配置、不回显、不返回给页面。

## 隐私与安全

- 探测只发只读 `GET`，**不调用模型、不产生费用**。
- 不跟随重定向，令牌不会被转发到其它主机。
- 站点图标只从网关自己的域名取，有大小上限，磁盘缓存 24 小时。
- 识别只用公开接口，只存公开信息（类型、版本、标题、图标）——没有令牌，也没有用户数据。
- 没有额度接口的网关就报「没有」，不会显示成错误。

## 限制

- **不包含生图和视频工具**：`dsh-newapi-provider` 里的生成工具依赖 New API 自己的任务接口。这里会列出网关的生图模型，但不会驱动它们。
- 额度适配只覆盖上面三类。其它方式暴露额度的后端，在补适配器之前不显示额度。
- 网关识别是启发式的；把所有公开接口都藏起来的网关会被当作普通 OpenAI 兼容端点处理——这仍然足够使用。

## 开发

```sh
npm test                                    # 94 项测试，基于本地假网关
node scripts/probe.mjs --base <url>         # 命令行探测
GATEWAY_KEY=sk-... node scripts/probe.mjs --base <url>
```

## 许可证

MIT

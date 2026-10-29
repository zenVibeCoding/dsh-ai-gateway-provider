# 发布清单（维护者用）

## 当前状态（2026-10-29）

| 项目 | 状态 |
| --- | --- |
| 本地版本 / 待发布 | **0.7.1**（`package.json` 已就位，本地改动尚未发布） |
| npm 当前版本 | **0.7.0**；以 `npm view dsh-ai-gateway-provider dist-tags --json` 与 `npm view dsh-ai-gateway-provider version` 的实际结果为准 |
| 测试基线 | **158 项离线测试**通过（本地假网关）；每次发布前重新运行 |
| GitHub | https://github.com/zenVibeCoding/dsh-ai-gateway-provider |
| 插件市场 | `data/plugins/zenVibeCoding__dsh-ai-gateway-provider.yml` 已在 main；市场版本由 `probe-npm` 从 registry 读取，发版后自动跟进 |
| 封面 / 截图 | 保留 `assets/cover.png` 与现有截图链接；`screenshots.json` 中封面排第一。旧截图仅作说明，不保证当前编辑器与「获取信息」按钮已有截图 |

本清单记录可复现的发布步骤。只有 npm registry、Git 标签和市场检查的实际结果才表示对应阶段完成；离线检查不调用真实模型。

### 0.7.1 内容（Claude 推理档位适配）

- **修复：Claude 的推理档位被整体清空**。网关目录里 Claude 声明了五个档位（low / medium / high / xhigh / max）和默认档位，但 `supports_reasoning_effort_updates: false` 被当成「无档位」信号——该字段只表示进行中的回合不能改档位。现在只有显式空 `supported_reasoning_levels` 才算无档位，Claude 的档位选择器与默认档位恢复。（真实网关 CLIProxyAPI `/v1/models?client_version=dsh` 实测：修复前 `levels: []`、`supported: false`。）
- **修复：档位没有真正发成 effort**。`toPiModel()` 丢掉了 pi-ai 对该模型的 `compat`，于是 Claude 走 token 预算路径，`xhigh`/`max` 与 `high` 完全等价（都是 16384）。现在按 id 取 pi-ai 内置条目的 `compat`（剔除 `supportsMidConvo*`、`allowedFallbackModels`、路由与亲和性字段）并带进模型：Claude 走自适应思考，档位按 `output_config.effort` 逐个下发（实测 low/high/xhigh/max 各自生效）。
- 目录解析改为每个 id 只查一次 pi-ai 目录；同一条目同时提供档位表与 `compat`。

### 0.7.0（npm 当前版本）内容

- **多网关同时可用**：每个已保存网关各注册一条 provider 路由，模型选择器按网关分组（组名=网关名），同名模型互不冲突。首个网关保留旧路由 `ai-gateway`，后续网关派生 `ai-gateway-<slug>`，旧会话路由不失效；路由随列表持久化，增删改不挪动其它网关。
- **网关级隐藏**：卡片上的眼睛按钮把该网关从对话模型选择器隐藏；地址、令牌、逐模型设置与历史解析保留，隐藏期间不再请求额度。新增 `channel/visibility` 动作。
- **删除「激活」语义**：不再有 active 网关，配置里的旧 `activeChannel` 被忽略，`activate` 动作已移除。渠道列表任意一行只是「查看」选择，决定上方详情与「模型能力」页的对象，不影响对话可用性。
- **添加/编辑渠道可「获取信息」**：地址合法后出现的内联按钮，只读公开端点（`/api/status`、站点首页、favicon），不读令牌、不调用模型；返回网关类型/版本/站点标题/建议名称/图标；名称仅在为空时自动填入，不覆盖手填。新增 `channel/identify` 接口。新建时地址栏默认聚焦。
- **Gemini 协议模型测试**：与聊天完全相同的 `POST {网关}/v1beta/models/{模型}:streamGenerateContent?alt=sse` + `x-goog-api-key`，要求 `finishReason`；裸 `[DONE]` 或 OpenAI 形状的流不算成功。同时修复 Gemini 聊天基址缺少 `/v1beta`。
- **性能**：页面快照不再顺带读取模型目录，模型清单按所选网关按需加载（`models/list`），定时刷新不再触发目录请求。

### 0.6.0 内容

- 推理 / 速度行式编辑器：逐行添加、删除和修改 API 参数值；关闭推理会停用等级选择，关闭速度会隐藏会话按钮并省略 `service_tier`。
- GPT-only 速度选择，仅用于实际选中的 OpenAI Chat / Responses 协议；能力按具体网关与上游模型解析。
- 输入框「⚡ 速度」按会话、网关、模型保存选择；`allowedServiceTiers` / `serviceTierMap` 支持自定义本地档位及 wire 值。
- 区分网关声明、响应回显与手动配置；响应回显不独立证明上游实际加速。

历史：**0.5.2** 隐藏模型原位置灰、封面与截图配置；**0.5.1** 单个 / 整组隐藏模型；**0.5.0** 首次公开发布。

## 0.7.1 发布前核对

- [x] `package.json` / `index.js` VERSION / 客户端展示版本均为 `0.7.1`；依赖范围保持 DSH ≥ 0.2.1-rc.1, < 0.3.0。
- [x] 2026-10-29 重新运行：158 项离线测试通过，`node --check` 全部通过，中英 locale key 无差异。
- [x] `npm pack` 产物 23 个文件；已扫描无 `.npmrc`、本地缓存、规划文件，也无 GitHub/npm 令牌或 `sk-` 形态字符串。该清单自身也在包内，所以 shasum 以最后一次 `npm publish` 输出为准，不在此写死。
- [ ] 执行 npm 发布并核对 registry 版本、shasum 与文件清单；成功后再更新状态表。
- [ ] Git 提交 / 推送、`v0.7.1` 标签、市场条目（`docs/market-entry.yml` 与市场侧条目一致，无需改内容）。

### 离线 / 打包检查

```sh
npm test
npm pack --dry-run
```

以 dry-run 的实际清单为准，不固定旧版的文件数量。`package.json` 的 `files` 包含入口、`client.js`、`lib/*.js`、补丁、语言资源、图标和文档；`docs/`、`assets/`、`test/`、`scripts/`、`screenshots.json` 不随包发布（市场从 GitHub 读取截图）。

### 维护者发布步骤

```sh
# 在仓库根目录，完成上述检查后
npm test
npm pack --dry-run
npm publish
npm view dsh-ai-gateway-provider version
```

npm 的认证 / 2FA 提示按交互流程完成。**只有发布成功后**，registry 版本才应为 `0.7.1`；随后下载 tarball 核对文件完整性及无凭据，再按仓库流程提交 / 推送并创建 `v0.7.1` 标签。这里不重建已有远端仓库。

市场条目位于 `docs/market-entry.yml`，与市场 main 上的 `data/plugins/zenVibeCoding__dsh-ai-gateway-provider.yml` 保持一致；条目本身不含版本号，市场侧的版本与发布时间由 `scripts/probe-npm.mjs` 从 registry 读取，因此发版后无需改条目。收录要求包括 `dsh.bundle`、仓库满 24 小时及已有提交，门禁状态以市场实际检查为准。

## 版本与兼容

- 首个网关沿用路由 id `ai-gateway`，发布后保持稳定，否则 0.7.0 之前的会话会失效；后续网关的路由在保存时分配并持久化，不会随编辑或删除其它网关而改变。
- 配置结构为 `channels[]`，各项包含 `backend`、逐模型 `models` 覆盖、可选 `enabledModels` 清单和可选 `hidden` 标记；不设置清单时为自动模式。
- 配置里的 `activeChannel` 仅为兼容旧文件而存在，读取时忽略；页面 API 不再有 `activate` 动作。
- 页面 API 新增 `channel/visibility`、`channel/identify`、`models/list`；快照不再包含模型目录。
- 旧的 `dsh-gateway-provider`（npm 1.1.2）是另一个插件，与本插件无关。

## 已知限制

- 不含生图 / 视频工具（New API 专属工具未在此接入）。
- CLIProxy / Sub2API 管理接口额度未接。
- 识别只覆盖公开端点；全部隐藏的网关按普通 OpenAI 兼容端点处理。
- 不自动发付费探测；用户主动测试与聊天会调用模型，可能计费；响应回显不构成上游加速的独立证明。
- Claude / Gemini 的速度档位不在支持范围（协议本身支持对话与模型测试）。

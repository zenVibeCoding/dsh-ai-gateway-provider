# 发布清单（维护者用）

## 当前状态（2026-10-26）

| 项目 | 状态 |
| --- | --- |
| 本地版本 / 下次发布目标 | **0.6.0** |
| npm 版本验证 | 以 `npm view dsh-ai-gateway-provider dist-tags --json` 的实际结果为准 |
| 测试基线 | 已知 **141 项离线测试**通过（本地假网关）；发布前重新运行 |
| GitHub | https://github.com/zenVibeCoding/dsh-ai-gateway-provider |
| 插件市场 | 已有 PR awesome-dsh-plugin#9445；发布时另行核对合并状态 |
| 封面 / 截图 | 保留 `assets/cover.png` 与现有截图链接；`screenshots.json` 中封面排第一。旧截图仅作说明，不保证新增档位 UI 已截图 |

本清单记录可复现的发布步骤。只有 npm registry、Git 标签和市场检查的实际结果才表示对应阶段完成；离线检查不调用真实模型。

### 0.6.0 发布内容

- 推理 / 速度行式编辑器：逐行添加、删除和修改 API 参数值；关闭推理会停用等级选择，关闭速度会隐藏会话按钮并省略 `service_tier`，旧会话选择也停用，检测资料仍保留。
- GPT-only 速度选择，仅用于实际选中的 OpenAI Chat / Responses 协议。能力按具体网关与上游模型解析；CLIProxyAPI 可从 `/v1/models?client_version=` 提供逐模型声明，未知网关仍支持通用兼容路径。
- 输入框「⚡ 速度」按会话、网关、模型保存选择；编辑器没有默认速度下拉框。`allowedServiceTiers` / `serviceTierMap` 支持自定义本地档位及 wire 值，不承诺所有预设可用。
- 区分网关声明、响应回显与手动配置；响应回显不独立证明上游实际加速。推理 fallback 可来自 pi-ai 内置目录 / 模型系列资料，不等于网关声明。
- [Fast mode 官方说明](https://developers.openai.com/api/docs/guides/fast-mode) 支持 `fast` / `priority` 等价写法；[Ultrafast 官方说明](https://developers.openai.com/api/docs/guides/ultrafast-mode) 有支持模型及可用性限制。
- 不自动发付费模型探测；用户主动模型测试（含批量）和聊天可能计费。

历史：**0.5.2** 隐藏模型原位置灰、封面与截图配置；**0.5.1** 单个 / 整组隐藏模型；**0.5.0** 首次公开发布。

## 0.6.0 发布前核对

- [x] 核对 `package.json` 版本仍为 `0.6.0`，依赖范围与目标 DSH 兼容（≥ 0.2.1-rc.1，< 0.3.0）。
- [x] 2026-10-26 重新运行 141 项离线测试与 JavaScript 语法检查，全部通过；每次重新发布前仍需再检查。
- [x] 检查中英 README 对等、双语顶端链接、封面及截图链接有效；新 UI 若未补截图，保留说明。
- [ ] 检查包内文件与凭据泄漏；不要将真实令牌、凭据缓存或本地测试状态装包。
- [ ] 由维护者单独执行 npm 发布并核对 registry；成功后再更新状态。
- [ ] 由维护者单独处理 Git 提交 / 推送、`v0.6.0` 标签和市场条目更新。

### 离线 / 打包检查

```sh
npm test
npm pack --dry-run
```

以 dry-run 的实际清单为准，不固定旧版的文件数量。`package.json` 的 `files` 包含入口、`client.js`、`lib/*.js`、补丁、语言资源、图标和文档；`lib/` 应包括新增的 `levels.js`、`service-tiers.js`、`session-tiers.js` 及现有依赖。`docs/`、`assets/`、`test/`、`scripts/`、`screenshots.json` 不随包发布（市场从 GitHub 读取截图）。

### 维护者发布步骤

```sh
# 在仓库根目录，完成上述检查后
npm publish
npm view dsh-ai-gateway-provider version
```

按 npm 的认证 / 2FA 提示完成发布。**只有发布成功后**，registry 版本才应为 `0.6.0`；下载 tarball 核对文件完整性及无凭据。随后按仓库流程提交 / 推送并创建 `v0.6.0` 标签；这里不重建已有远端仓库。

市场条目位于 `docs/market-entry.yml`；核对已有 PR 后再更新，避免重复提单。收录要求包括 `dsh.bundle`、仓库满 24 小时及已有提交，门禁状态以市场实际检查为准。

## 版本与兼容

- 路由 id `ai-gateway` 发布后保持稳定，否则现有会话会失效。
- 配置结构为 `channels[]`，各项包含 `backend`、逐模型 `models` 覆盖和可选 `enabledModels` 清单；不设置清单时为自动模式。
- 旧的 `dsh-gateway-provider`（npm 1.1.2）是另一个插件，与本插件无关。

## 已知限制

- 不含生图 / 视频工具（New API 专属工具未在此接入）。
- CLIProxy / Sub2API 管理接口额度未接。
- 真实 Anthropic / Gemini 协议端点尚未验证；离线测试不代表真实上游互通或加速验证。

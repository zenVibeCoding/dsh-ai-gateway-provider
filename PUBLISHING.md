# 发布清单（维护者用）

本文件记录发布状态与步骤，随仓库一起提交。

## 当前状态（2026-10-26）

| 项目 | 状态 |
| --- | --- |
| 版本 | 0.6.0（未发 npm） |
| 测试 | 105 项通过（`npm test`） |
| npm | 0.5.0 已发布；0.5.2 发布中 |
| GitHub | https://github.com/zenVibeCoding/dsh-ai-gateway-provider |
| 插件市场 | PR awesome-dsh-plugin#9445，等仓库满 24 小时 + 维护者合并 |
| 封面 | `assets/cover.png`，在 `screenshots.json` 中排第一 |

### 版本记录

- **0.6.0**：GPT / OpenAI 速度档位（Standard / Fast / Ultrafast），按网关声明、实测回显、手动尝试三种证据区分；CLIProxyAPI 从 `/v1/models?client_version=` 读取档位声明；输入框「⚡ 速度」按钮按会话切换档位
- **0.5.2**：隐藏模型改为原地置灰，不再从列表移走；封面与 `screenshots.json`；README 标题改为「任意 AI 网关」
- **0.5.1**：隐藏模型（单个 / 整组），隐藏的模型不进对话选择器
- **0.5.0**：首次公开发布

## 发布前必须完成

- [x] `package.json`：移除 `private`，补 `repository` / `homepage` / `bugs` / `publishConfig`
- [x] README 中英双语 + 截图（`docs/screenshots/`）
- [x] 市场条目 `docs/market-entry.yml`，图标 `assets/icon-180.png`
- [x] 密钥扫描：仓库内无令牌
- [ ] `npm publish`（需维护者在浏览器完成授权）
- [ ] 建远端并推送、加 `dsh-plugin` topic
- [ ] 市场 PR

## 打包检查

```sh
npm test
npm pack --dry-run
```

预期：21 个文件；`docs/`、`assets/`、`test/`、`scripts/`、`screenshots.json` 不随包发布（市场从 GitHub 读截图）。
`lib/` 必须完整（`probe.js`、`channels.js`、`catalog.js`、`adapter.js`、`model-test.js`、`modelsdev.js`、`levels.js`、`util.js`、`site-cache.js`、`backend.js`），漏一个就会在安装后报模块找不到。

## 第一步：npm 发布

```sh
cd ~/dsh-ai-gateway-provider
npm publish          # 用伪终端跑，会给出 https://www.npmjs.com/auth/cli/<id> 授权链接
```

账号需 `auth-and-writes` 2FA：在浏览器完成授权后，命令行会自动继续。发布完成后：

- `npm view dsh-ai-gateway-provider version` 应为 `0.5.0`（registry 生效约 1 分钟）
- 下载 tarball 与仓库逐字节比对，确认 `lib/` 齐全、无凭据泄漏

## 第二步：GitHub

```sh
gh repo create zenVibeCoding/dsh-ai-gateway-provider --public --source=. --remote=origin --push
gh repo edit --add-topic dsh-plugin,dsh,deepseek-harness,ai-gateway,openai-compatible,llm-provider
git tag -a v0.5.0 -m "dsh-ai-gateway-provider 0.5.0" && git push origin v0.5.0
```

## 第三步：插件市场

`awesome-dsh-plugin` 收录方式：在 `data/plugins/` 加一个 `<owner>__<repo>.yml`，内容见 `docs/market-entry.yml`。

门禁要求：`dsh.bundle` 已声明、仓库满 24 小时、有提交。仓库刚建时会红，`regate.yml` 每 6 小时自动重跑；也可以在其后推一个空提交立即触发。

## 版本与兼容

- 路由 id `ai-gateway`：发布后不要改，改了会让使用该路由的会话失效
- 配置结构：`channels[]`，每项含 `backend`（探测结果）、`models`（逐模型覆盖）、`enabledModels`（模型清单，不设为自动）
- 旧的 `dsh-gateway-provider`（npm 上 1.1.2）是另一个插件，与本插件无关

## 已知未完成项（写进「限制」）

- 不含生图/视频工具（New API 专属）
- CLIProxy / Sub2API 管理接口额度未接
- 未在真实 Anthropic / Gemini 协议端点验证过（聊天走 openai 协议已验证）

# AdPilot

AdPilot 是一个可本地运行、可审批、可审计的原生广告优化 Agent。Pi 是唯一主运行时；UI-TARS 只负责“截图到单个视觉动作”的 grounding；广告策略、成熟度、测量可信度、预算/出价安全门和 UAC 实验闭环由确定性内核执行。

![AdPilot 控制台](docs/screenshots/adpilot-console.png)

## 当前能力

- 一个面向用户的 AdPilot Agent，按调查树调度 Account Operator、Performance Analyst、Media Buyer、Measurement Reviewer、Creative Strategist 和独立 Risk Reviewer。
- 客户隔离 Workspace，保存任务、证据、截图、审计链、审批、实验、报告和记忆。
- 自然语言对话是主入口：首次启动自动建立本地 Workspace，用户可以直接提问、追问或下达调查任务；对话、任务和结果都会持久化。
- 用户只需选择日常 / 深度代码模型；内置 Computer Use 会自动检测图像能力并组成定位、失败升级和独立复核链路。专用 UI-TARS / Verifier 端点只属于高级覆盖项。
- 持久 Pi Session 按客户和对话恢复；长对话执行真实 compaction 并保留未完成任务、审批、实验、证据引用、恢复点与最后已验证动作。
- 原生 Computer Use：产品为每个客户主动启动独立浏览器 Profile，并严格执行 `绑定 PID/窗口/Profile -> 截图 -> 单步 grounding -> 策略检查 -> 原生动作 -> 再截图 -> 独立结果验证`。窗口切换会立即返回 `BROWSER_SESSION_LOST`。
- 真实修改必须经过确定性 guardrail、Risk Reviewer、用户批准和五分钟一次性令牌；令牌指纹覆盖完整视觉计划、账户/Campaign、前后值、目标控件、允许区域、浏览器窗口和单次执行机会。执行前还需两次独立视觉身份判断一致。
- `VisualTableReader` 通过截图 ROI 读取表头、单元格和滚动重叠行，独立复核后才写入有截图与 Bounding Box 的 `SharedFact`；低置信度数值不会进入专家决策。
- 完整截图只保存在本地 Workspace；模型仅接收任务 ROI 和遮挡后的图像。`local-only` 隐私模式会阻止所有远程截图 Provider。
- Google App Campaign 的规范化、诊断、版本化数值策略、实验账本、doctor 和历史回放内核；保留 410 项上游契约测试。
- React + Fluent UI 控制台、SSE 实时状态、CLI、本地 mock 广告后台和失败关闭测试。

## 安装

需要 Node.js 22+、pnpm 10+、Git。若要运行 UAC Python 契约测试，还需要 Python 3.10+。

```bash
git clone --recurse-submodules https://github.com/taotao135791-bit/adpilot.git adpilot
cd adpilot
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm install --global .
```

`npm install --global .` 会把已经构建好的 `adpilot` 命令安装到当前 Node 的全局 bin。开发时如果希望源码目录中的每次构建立刻生效，也可以改用 `pnpm link --global`。验证安装：

```bash
which adpilot
adpilot doctor
```

首次运行会自动创建个人 Workspace，可以直接对话。需要隔离真实客户时再创建独立 Workspace：

```bash
adpilot init demo-client --name "Demo Client" --kpi CPA --target 20 --currency USD
```

启动后点右上角齿轮进入“设置”。“模型”页选择日常/深度代码模型并连接模型供应商；Computer Use 会自动复用支持图像输入的代码模型。GUI Endpoint、坐标协议和 Verifier 等实现细节只在高级开发者设置中出现，普通用户无需安装或拼接额外服务。保存后按提示重启即可生效，密钥不会由设置接口返回明文。

CLI 同样能查看 Pi 供应商并完成模型供应商自己的 OAuth 登录；这不是广告账户授权。CLI 和 DMG 共用各自活动 Workspace 内的安全凭据格式：

```bash
adpilot providers
adpilot login openai-codex
adpilot logout openai-codex
```

为客户启动产品管理的 Google Ads 浏览器窗口后，由用户在该窗口手动完成登录、OTP 或 CAPTCHA：

```bash
adpilot browser start --client demo-client --profile demo-client-google-ads
adpilot browser status --client demo-client
# 使用完毕后
adpilot browser close --client demo-client --profile demo-client-google-ads
```

浏览器的固定 Profile 目录、PID、Window ID 和客户绑定由 AdPilot 管理；产品不读取 Cookie、localStorage、密码或页面 DOM。

自动化部署仍可复制 `.env.example` 为 `.env` 或设置同名环境变量。设置页保存的值优先于启动时环境变量。

```bash
adpilot doctor
adpilot
```

默认服务仅监听 `127.0.0.1:4317` 并打开控制台。可用 `ADPILOT_HOST`、`ADPILOT_PORT`、`ADPILOT_WORKSPACE` 和 `ADPILOT_NO_OPEN=1` 调整。

## 原生 macOS 应用与 DMG

仓库包含独立 Electron 主进程。它在随机回环端口启动同一套 AdPilot API，使用隔离浏览器上下文，并把默认 Workspace 放在 `~/Library/Application Support/AdPilot/workspace`。开发启动：

```bash
pnpm desktop
```

先生成并验证未封装的 `.app`：

```bash
pnpm desktop:dir
open release/mac-arm64/AdPilot.app
```

生成可安装 DMG：

```bash
pnpm desktop:dmg
open release/AdPilot-0.1.1-arm64.dmg
```

DMG 会使用 `build/icon.icns` 和标准拖拽到 Applications 的安装窗口。`pnpm icon:mac` 可从 `build/icon.svg` 重建图标。签名和 notarization 不是构建要求：开源发布可以直接分发未签名 DMG，但 macOS Gatekeeper 可能要求用户右键选择“打开”；只有追求无提示安装时才需要 Developer ID。原生应用的设置和 OAuth 凭据分别保存在 `~/Library/Application Support/AdPilot/workspace/.adpilot/settings.json` 与 `pi-auth.json`，文件权限为 `0600`。

## macOS 权限

原生 Computer Use 需要给实际启动 `adpilot` 的 Terminal/运行器，或打包后的 `AdPilot.app`，授予“辅助功能”和“屏幕录制”权限。请只在产品启动的独立浏览器 Profile 中手动登录相应广告账户，并在客户 `accounts.yaml` 中限制域名。所选代码模型不支持图像时，产品仍可正常对话和分析，但不会执行视觉任务。

## 验证

```bash
pnpm test
python3 -m pip install -r packages/advertising-core/python/requirements-dev.txt
pnpm test:ads-core
pnpm check
```

先用设置页或 `adpilot browser start` 启动受管浏览器，再在其中手动登录 Google Ads。随后可运行显式的纯视觉验证；命令不会使用 DOM 自动化：

```bash
pnpm validate:google-ads:readonly -- --client <id> --browser-profile <profile> --campaign "Campaign name"
pnpm validate:google-ads:prepare -- --client <id> --browser-profile <profile> --campaign "Campaign name" --draft-budget 120
```

第二条命令要求用户先手动打开并聚焦预算输入框；运行时只允许一次 `type` 和一次只读确认，代码层禁止 Click、Hotkey、Enter、重试以及 Save / Apply / Publish。证据写入 `artifacts/visual-validation/`；没有已登录浏览器环境时不会声称真实浏览器验证通过。

本地视觉闭环使用 `apps/mock-ad-dashboard/index.html`，不会连接真实广告平台。架构边界见 [docs/architecture.md](docs/architecture.md)，模型配置见 [docs/model-configuration.md](docs/model-configuration.md)，Computer Use 权限见 [docs/computer-use-permissions.md](docs/computer-use-permissions.md)，安全模型见 [docs/security.md](docs/security.md)，上游升级流程见 [docs/upstream-sync.md](docs/upstream-sync.md)。测试结果和已知外部限制分别见 [docs/test-report.md](docs/test-report.md) 与 [docs/known-limitations.md](docs/known-limitations.md)。

第三方署名与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## English quick start

AdPilot is a local-first, approval-gated advertising optimization agent. Install with Node 22 and pnpm, run `pnpm install --frozen-lockfile && pnpm build && npm install --global .`, then launch with `adpilot` and start chatting. Choose Daily and Deep code models; the built-in Computer Use plugin automatically reuses their image capability. Start a managed browser with `adpilot browser start --client <id>`, then log in manually. No advertising API or advertising-account OAuth is used, and no live mutation can bypass deterministic policy, dual visual identity review, exact-plan user approval, and a one-attempt token.

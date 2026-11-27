# Assumption Lens Demo

一个可在本机运行并临时分享的交互式研究原型。输入编程需求后，可以用**文字计划、任务图、Assumption Lens** 三种方式审查同一份初始计划，再生成代码。Assumption Lens 展示模块与步骤两层图、待办决策、方案预期影响、节点追问和操作日志。

## 准备

- Windows 10/11；安装 [Node.js](https://nodejs.org/) 18 或更新版本。项目不需要 `npm install`。
- **Codex 版**：安装并登录 [Codex CLI](https://developers.openai.com/codex/cli)。模型调用消耗启动者的 Codex 额度。
- **DeepSeek 版**：准备自己的 DeepSeek API Key，并确保账户有可用余额。模型调用消耗该 Key 对应账户的余额。不要把 Key 提交到仓库或发给访问网页的人。

从 GitHub 下载或克隆此仓库后，进入项目目录，选择一个入口：

| 入口 | 模型来源 | 首次操作 |
| --- | --- | --- |
| `双击启动.cmd` | 本机已登录的 Codex CLI | 确认已登录 Codex |
| `双击启动API版.cmd` | DeepSeek API | 在启动窗口输入自己的 Key；输入不会显示 |

启动器会运行本地服务、打开浏览器，并尝试创建临时公网分享网址。首次分享时会从 Cloudflare 官方发布页下载 `cloudflared` 到本机 `tools/`。启动窗口显示并复制**包含访问码的完整网址**；将它发给需要体验的人。若隧道创建失败，可使用窗口显示的局域网网址供同一网络的人访问。

**关闭启动窗口后，服务和临时隧道会停止。** 旧网址随即失效，下一次启动会生成新的网址和访问码。持有有效网址的人在服务运行期间可以发起模型请求，因此仅分享给受信任的人。

DeepSeek Key 首次输入后会加密保存在本机 `.deepseek-key.dpapi`；仓库不会包含该文件。需要更换 Key 时双击 `重设API密钥.cmd`。若网页提示访问码无效，请从**本次启动窗口**重新复制完整链接，不要使用旧标签页。

## 使用

1. 在“描述你想完成的任务”中输入编程需求，点击“分析需求”。
2. 切换文字计划、任务图和 Assumption Lens。三种方式从同一初始计划分别开始，修改互不覆盖。
3. 任务图中可拖动节点；从方框两侧的圆点拖动连线，点击连线可编辑或删除。
4. Assumption Lens 左侧是模块图，点击模块可在右侧查看步骤图、实现决策与节点对话。两层方块均可拖动；从连接点增加线，点击线删除。关键结构发生删除或调整前会提示可能的影响，是否继续由用户决定。黄色节点表示还有待办决策；每个预设方案可“反馈 · 追问”或直接采用，自定义方案提交后由 AI 评估。操作日志按时间倒序显示。
5. 完成待办决策后点击“确认并生成代码”。代码只显示在网页中，服务端不会自动运行它。

每次分析、生成和节点追问都会调用所选模型。Assumption Lens 的结构变更与自定义方案评估也会调用模型；连续请求会排队执行。

## 手动运行与检查

在项目目录运行 `node server.js` 会启动本地服务并在终端打印访问链接。默认使用 Codex。可设置 `HOST`、`PORT`、`CODEX_MODEL`；DeepSeek 手动运行时设置 `DEMO_PROVIDER=deepseek`、`DEEPSEEK_API_KEY`，可选 `DEEPSEEK_MODEL`。例如 PowerShell：

```powershell
$env:DEMO_PROVIDER = 'deepseek'
$env:DEEPSEEK_API_KEY = '在此填入自己的Key'
node server.js
```

测试路由和 DeepSeek 请求格式：

```powershell
node tests/graph-routing.test.js
node --test tests/deepseek-client.test.mjs
```

如需单独查询 DeepSeek 余额，先设置 `DEEPSEEK_API_KEY`，再运行 `python Check_api_remain.py`。此辅助脚本使用 Python 标准库，不会保存 Key。

## 项目与研究边界

- `web/` 是前端；`server.js`、`deepseek-client.js` 是本地服务与模型调用；`start-demo.ps1` 和三个 `.cmd` 文件是 Windows 启动入口；`tests/` 是轻量测试。
- [Group1.pptx](Group1.pptx) 是项目演示文稿。PPT 中标注为模拟的研究数字不能当作真实实验结果。
- 原始论文：[NeuroSync: Intent-Aware Code-Based Problem Solving via Direct LLM Understanding Modification](https://doi.org/10.1145/3746059.3747668)。仓库不再分发论文 PDF。
- 原型实现的是交互流程，并未复制 NeuroSync 的知识蒸馏管线。模型生成的计划、影响解释和代码需要人工核查。

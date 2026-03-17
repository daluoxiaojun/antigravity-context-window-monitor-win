# Antigravity Context Window Monitor (Windows)

Windows 原生的 Antigravity 扩展，用于实时监控 Antigravity 对话的上下文窗口使用量。  
A Windows-native VS Code extension for monitoring Antigravity conversation context usage in real time.

它会在状态栏显示当前对话的 token 使用量、上下文窗口上限和占用比例，并支持模型识别、模型切换后的窗口容量更新、双语悬浮提示与历史记录查看。  
It shows token usage, context limit, and usage percentage in the status bar, with model-aware limits, model-switch updates, bilingual hover details, and snapshot history.

## Features / 功能特性

- 实时状态栏显示已用 token、窗口上限和使用率  
  Real-time status bar display for used tokens, limit, and usage percentage
- 正确显示 Antigravity 当前使用模型，包括 Claude Opus 4.6、Claude Sonnet 4.6、Gemini 系列等  
  Correct model display for supported Antigravity models, including Claude Opus 4.6, Claude Sonnet 4.6, and Gemini variants
- 对话中途切换模型后，可自动更新对应的上下文窗口容量  
  Automatically updates the context window limit when the conversation model changes
- 在检测到新消息、步骤变化或模型线索变化后，会触发隐式重检  
  Performs implicit re-detection after new activity, step changes, or model-hint changes
- 提供状态栏刷新按钮，可手动强制重新检测当前模型与上下文窗口  
  Includes a status bar refresh button for forced re-detection of the current model and context window
- 按工作区隔离会话，不同窗口尽量只跟踪各自对应的对话  
  Uses workspace-aware session selection so each window tracks its own conversation
- 状态栏和悬浮提示均提供中英双语文案  
  Status text and tooltips are bilingual in Chinese and English
- 支持 QuickPick 历史记录查看最近的上下文快照  
  Includes a QuickPick history view for recent context snapshots

## Supported Context Limits / 支持的上下文窗口映射

内置默认映射包括：  
Built-in defaults include:

- `gemini 3 flash` -> `1,000,000`
- `gemini 3.1 pro（high）` -> `1,000,000`
- `gemini 3.1 pro（low）` -> `1,000,000`
- `Claude opus 4.6` -> `200,000`
- `Claude sonnet 4.6` -> `200,000`
- `GPT OSS 120B` -> `128,000`

同时还内置了 Claude、Gemini、GPT、O 系列常见别名的兜底映射。  
Additional alias-based fallbacks are also included for common Claude, Gemini, GPT, and O-series model names.

## How It Works / 工作原理

扩展会在 Windows 上发现本地 Antigravity language server，读取 conversation trajectory 和 step/checkpoint 数据，估算或提取上下文使用量，并把结果展示在 VS Code 状态栏中。  
The extension discovers the local Antigravity language server on Windows, reads conversation trajectory and step/checkpoint data, estimates or extracts token usage, and renders the result in the VS Code status bar.

当语言服务器提供了模型元数据时，扩展会自动把显示的上下文窗口上限更新为对应模型的容量。  
When model metadata is available, the displayed context window limit automatically updates to match the active model.

## Install / 安装

### From VSIX / 从 VSIX 安装

1. 构建或下载 `.vsix` 安装包  
   Build or download a `.vsix` package
2. 在 VS Code 中打开扩展面板  
   Open Extensions in VS Code
3. 选择 `Install from VSIX...`  
   Choose `Install from VSIX...`
4. 选择生成好的包，例如：  
   Select the generated package, for example:
   - `antigravity-context-window-monitor-win-0.1.7.vsix`

## Usage / 使用方式

- 状态栏左侧会显示当前上下文使用情况  
  The left side of the status bar shows current context usage
- 将鼠标悬停到状态栏项上可以看到详细双语信息  
  Hover the status item to view detailed bilingual information
- 点击历史项可以查看最近快照  
  Click the history item to inspect recent snapshots
- 点击刷新图标可以强制重新检测当前模型和上下文窗口  
  Click the refresh icon to force model and context re-detection

推荐的模型切换流程：  
Recommended flow when switching models mid-conversation:

1. 在 Antigravity 里切换模型  
   Switch model in Antigravity
2. 发送一条新消息，或点击刷新按钮  
   Send a new message, or click the refresh button
3. 扩展会重新检测当前模型，并更新对应的上下文窗口容量  
   The extension re-detects the active model and updates the context limit

## Commands / 命令

- `Antigravity Context Monitor: Show History`
- `Antigravity Context Monitor: Refresh`

## Settings / 配置项

可在 `settings.json` 中配置：  
Available in `settings.json`:

- `antigravityContextMonitor.pollIntervalSeconds`
- `antigravityContextMonitor.requestTimeoutMs`
- `antigravityContextMonitor.historySize`
- `antigravityContextMonitor.defaultContextLimit`
- `antigravityContextMonitor.modelContextOverrides`
- `antigravityContextMonitor.enableVerboseLogs`

示例配置：  
Example override:

```json
{
  "antigravityContextMonitor.modelContextOverrides": {
    "claude-opus-4-6": 200000,
    "gemini-3-1-pro": 1000000
  }
}
```

## Development / 开发

安装依赖 / Install dependencies:

```bash
npm install
```

编译 / Compile:

```bash
npm run compile
```

打包 / Package:

```bash
npx -y @vscode/vsce package --no-dependencies
```

## Current Limitations / 当前限制

- 目前实现以 Windows 环境为主  
  Currently focused on Windows
- 模型切换是否能立即识别，取决于 Antigravity 何时把新模型信息写入 trajectory 或 step 数据  
  Model-switch detection depends on when Antigravity writes new model metadata into trajectory or step data
- 部分模型名称依赖本地 language server 元数据和别名兜底匹配  
  Some model names depend on local language-server metadata and alias-based fallback matching

## Acknowledgements / 特别鸣谢

特别鸣谢原作者项目提供的设计思路与实现参考：  
Special thanks to the original project for the design inspiration and implementation reference:

- `https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor`

## License / 许可证

MIT

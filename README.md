# 聊天模式 Chat Mode — DSH Agent Preset

[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue)](https://github.com/deepseek-ai/deepseek-harness)[![npm](https://img.shields.io/npm/v/@wssdll/dsh-chat-preset)](https://www.npmjs.com/package/@wssdll/dsh-chat-preset)[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[DeepSeek Harness（DSH）](https://www.deepseek.com/en/harness/) 的 Agent 预设：一个只用来聊天的会话。

装好之后，模型只会拿到三个工具：联网搜索、打开网页、读取你拖进来的文档和图片。系统提示只有一段简短的人设，不注入运行上下文、工作目录、Harness 检出路径之类的杂项。

在「设置」→「Agent 预设」→「聊天模式」启用，或者新建对话时把「标准模式」切换为「聊天模式」。

## 截图

![聊天模式效果预览 1](screenshot-1.png)

![聊天模式效果预览 2](screenshot-2.png)

## 为什么需要这个

DSH 默认的预设包含：几十个工具、几千 token 的工具说明、一整套「你是编码代理」的提示。在纯聊天中，不仅极度消耗 Token，并且大量注入的说明和工具链会严重挤压人设，会让模型自动切换到工作模式。

目前市场的大部分插件要么未屏蔽工具链，要么不支持搜索和附件。因此我在此做了特殊处理，专门开发了此插件，尽可能还原网页版。

工具链的影响是可量化的。在一个实际的聊天会话中：

| | 工具数 | 工具 schema |
|---|---|---|
| 未处理 | 27 | ~9 458 tok |
| 加上本插件 | **3** | **~376 tok** |

降低约 **25 倍**。也就是说，语气不单由人设决定，同样会被海量工具目录淹没。多轮对话下人设会朝严肃、简短、直白的方向收敛。

## 它做什么

`cordis.patch.yml` 是核心预设文件：

- `dsh-persona`，`complete: true`：整段人设即全部系统提示，其他身份、后缀、工具引导段落一律不注入
- `includeRuntimeContext: false`：关闭运行环境上下文，聊天模式用不上
- `dsh-tool-web`：`web_search` + `web_fetch`
- `read_attachment`：读本对话的附件，Host 端强制校验，其他路径一律拒绝。工具实现自带在本插件内，不依赖任何第三方插件
- 长对话照常压缩

`guard-tools.js` 是屏蔽工具的脚本，自动生效，不需要任何配置。它只对 `chatmode` 预设的会话有效，其他预设完全不受影响。

注意：此脚本只能屏蔽非「agent 作用域」的工具，详情见下。

## 和其他插件共存

**判定方式是白名单。** `guard-tools.js` 的 `ALLOWED` 只有三个名字，其余无论从哪来，全部进 deny 列表。所以装了新插件，它的工具默认就被排除，不需要改这里。

具体到一个工具的流向：

| 新插件把工具注册为 | 结果 |
|---|---|
| 全局工具 | 照常被屏蔽 |
| agent 作用域工具 | **屏蔽不了**（见下面的说明） |

### 关于「agent 作用域」这个例外

DSH 的工具分两层注册：

- **全局**：`ctx.tools.register(def)`，所有 agent 都看得到，`restrict()` 能挡。
- **agent 作用域**：注册在某个 agent 自己的上下文里，`restrict()` **挡不住**。这是 `dsh-tools` 的明文约定：`scoped registrations remain visible`。

也就是说，**任何在 agent 作用域里注册工具的插件，它的工具都会出现在聊天模式里**，预设和本插件都无能为力。已知的例子是 `dsh-gitbash-shell`，它会把 `bash`、`gitbash_native`、`gitbash_to_native_path` 注册进 agent 作用域。

遇到这种情况只有两个选择：关掉那个插件，或者接受它的工具出现在聊天模式里。

验证方法很简单：在聊天模式里问一句「你现在有哪些工具」，多出来的就是这类工具。

### 工具在会话中途出现怎么办

装插件或热加载时，新工具是在会话**已经跑起来之后**才注册的，早先算出的 deny 列表里没有它。

本插件监听 `tools/change`，任何工具变动都会对已加护的会话重新计算掩码，所以新出现的工具会在同一轮被压掉，不会漏到下一轮。

不过最稳妥的做法仍是：**装完插件重启 DSH，再开聊天会话。**

## 启用

插件市场安装，或：

```sh
dsh plugin --profile desktop add github:wssdll/dsh-chat-preset
```

如果你用的是其他 profile，把 `desktop` 换成对应的 profile 名。装完**重启 DSH**，新建会话时选「聊天模式」。

## 人设

`cordis.patch.yml` 里的 `prefix` 就是全部人设，可以直接改，改完热重载生效。

它沿四个方向约束说话方式：

- **语气**：友善、温暖，允许有情绪，不端客服腔
- **风格**：反格式堆砌（清单、标题、粗体），允许口语和表情，结尾自然收住不反问
- **诚实**：不确定就说，不编造；需要最新信息先搜索，引用附链接
- **语言**：思维链全中文

具体措辞以 `cordis.patch.yml` 为准。

注意：改完**已存在的会话不会更新**。DSH 的预设修订在会话创建时绑定，要新开会话。

## 已知限制

- 只能屏蔽**全局**工具；agent 作用域注册的工具需要关掉对应插件（见「和其他插件共存」）
- 只覆盖 `chatmode`（想覆盖别的预设，改 `guard-tools.js` 的 `PRESETS`）
- 会话中途切换预设不保证重新计算

## 兼容性

| 项目 | 值 |
|---|---|
| DSH 版本 | `>=0.2.2-rc.1 <0.3.0-0` |
| 实际测试 | `0.2.2-rc.1` |

依赖（均为 DeepSeek Harness 官方包）：`@deepseek-ai/dsh-persona`、`@deepseek-ai/dsh-tool-web`、`@deepseek-ai/dsh-compaction-basic`。**不依赖任何第三方插件**，附件读取工具已内置在本包中。

### DSH-Go

在 [DSH-Go](https://github.com/ccch1mneyyy/dsh-Go) 的本机引擎里，用它的「终端」执行（App 启动引擎用的 profile 是 `web`）：

```sh
dsh plugin --profile web add github:wssdll/dsh-chat-preset
```

装完即可在「Agent 预设」里看到「聊天模式」。如果显示「加载失败/不可用」，通常是内置引擎版本低于 `0.2.2-rc.1` 导致 `engines.dsh` 不满足；可查看引擎日志确认 DSH 版本。

工具限制用到的 `agent-preset/selected`、`tools.restrict()`、`tools/change` 三个接口在整个 0.2.x 期间没有出现在任何升级指南里，但它们属于工具层。`v0.2.1-rc.2` 引入了 `ResolvedToolSet` 并重构了工具声明时序，所以更早的 0.2.0 版本不保证可用，版本下限就定在这里。

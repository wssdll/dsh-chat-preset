# 聊天模式 Chat Mode — DSH Agent Preset

[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue)](https://github.com/deepseek-ai/deepseek-harness)[![npm](https://img.shields.io/npm/v/@wssdll/dsh-chat-preset)](https://www.npmjs.com/package/@wssdll/dsh-chat-preset)[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[DeepSeek Harness（DSH）](https://www.deepseek.com/en/harness/) 的聊天专用预设，目标是把网页版那种聊天体验搬进 DSH。

**省 Token**。工具从几十个压到四个，工具 Schema 从约 7 589 tok 降到约 350 tok，降低约 22 倍。系统提示只剩一段简短人设，不注入运行上下文、工作目录、Harness 检出路径这类杂项。

**保留搜索、支持读文件**。保留联网搜索、打开网页、读取文档和图片。读文件用官方 `dsh-tool-fs`，只开 `read` 与 `read_image`，写入、编辑、打补丁全部关闭。

**时间戳**。单独实现的时间注入插件，仅一行，降低工具链影响。

**中文思维链**。内部推理固定用简体中文，回答语言跟随提问。

安装后在「设置」→「Agent 预设」→「聊天模式」启用，或新建对话时把「标准模式」切换为「聊天模式」。

## 截图

![聊天模式效果预览 1](screenshot-1.png)

![聊天模式效果预览 2](screenshot-2.png)

## 安装

**插件市场**：在 DSH 的「插件市场（dsh-market）」搜索 `dsh-chat-preset`。

**命令行**：

```sh
# 桌面端
dsh plugin --profile desktop add @wssdll/dsh-chat-preset
# DSH-Go / 网页端
dsh plugin --profile web add @wssdll/dsh-chat-preset
```

## 免费使用

配合`dsh-connect-workbuddy`和`dsh-free-search`可实现免费使用。

**命令行**：

```sh
dsh plugin --profile desktop add dsh-connect-workbuddy
dsh plugin --profile desktop add dsh-free-search
```
插件`dsh-connect-workbuddy`配置完成后可以选择WorkBuddy提供的模型，目前每天可以领取免费积分，纯聊天基本上用不完。

但是这样仍然不是完全免费，因为搜索调用的工具`web_search`会走付费API，`dsh-free-search`就是为了解决这一点，它可以将`web_search`替换成免费搜索。

两个插件都启用后，即可完全免费。

DSH-Go也测试通过，相同方案完全可用。具体配置可以直接让 Agent 帮你改。

## 为什么需要这个

DSH 默认的预设是给干活设计的：几十个工具、几千 Token 的工具说明、一整套「你是编码代理」的提示。这些内容在写代码时有用，但在纯聊天里会持续消耗 Token，并且把人设挤到边缘。

实际聊天会话的测量：

| | 工具数 | 工具 Schema |
|---|---|---|
| 未处理 | 27 | ~7 589 tok |
| 加上本插件 | **4** | **~350 tok** |

实际上语气不仅仅由人设决定，同样会受到工具链的影响。

工具链越多，多轮对话下人设越容易朝严肃、简短、直白的方向收敛。

目前市场上的类似插件，要么没有屏蔽工具链，要么不支持搜索和附件。

## 它做了什么

`cordis.patch.yml` 是核心预设文件：

- `dsh-persona`，`complete: true`：整段人设即全部系统提示，其他身份、后缀、工具引导段落一律不注入
- `includeRuntimeContext: false`：关闭运行环境上下文，聊天模式用不上
- `dsh-tool-web`：`web_search` + `web_fetch`：官方自带的搜索工具和网页解析工具
- `dsh-tool-fs`：只开 `read` 与 `read_image`，`write`、`edit`、`apply_patch` 全部关闭。读文件走 `ctx.fs`，和标准模式同一个 seam，路径由 Host 解析，不受工作区限制
- `compaction-basic`：`thresholdRatio: 0.16` + `retainRatio: 0.08`：压缩阈值由 `0.8` 调整为 `0.16`，压缩后保留的原文比例由 `0.16` 调整为 `0.08`。即 16% 上下文触发压缩，压缩后保留 8% 上下文。

***关于压缩机制的说明**

`thresholdRatio: 0.16` 和 `retainRatio: 0.08` 是仔细计算的，用于平衡消耗和聊天体验。
- 注意力机制：模型天生就会逐渐「失忆」。模型对上下文开头和结尾的信息利用得最好，中间位置最容易被忽略，这被称为 lost in the middle。它不会察觉自己漏看了什么，也不会主动提起。并且上下文越长，模型注意力被整体分散得越多，中段损失越严重。因此短上下文反而可以提升模型表现，让他对于近期话题的注意力更为集中。
- Token 消耗：短上下文还可以显著减少消耗，通常越早压缩效果越好。实测只调 `thresholdRatio`：0.32 时 token 消耗增加约 60%，0.08 时减少约 30%。0.16 是平衡点。
- 如果有个人需要，也可以让 Agent 直接修改此参数。

本插件自带的补丁：

- `plugins/clock.js`：每小时注入一行 `当前时间：2026/11/21 23:41（周六）`。官方的 `dsh-time-context` 每次注入三行技术描述（turn/step 编号、时区策略、距上条消息的耗时），实测会让模型把注意力放在时间戳上，所以换成了这一行纯事实。
- `plugins/no-cwd.js`：去掉工作目录的 system-reminder。`dsh-working-directory` 把这条注册成 `required: true`，`complete: true` 和 `includeRuntimeContext: false` 都拦不住它，只能在预设作用域里注册一个同名空条目把它遮掉。工作目录服务本身照常运行，其他模式不受影响。
- `plugins/guard-tools.js` 屏蔽工具的脚本，自动生效，不需要任何配置。它只对 `chatmode` 预设的会话有效，其他预设完全不受影响。注意：此脚本只能屏蔽全局工具，对「作用域内注册」的工具无效，详情见下面的「和其他插件共存」。

## 和其他插件共存

**判定方式是白名单。** `plugins/guard-tools.js` 的 `ALLOWED` 只有四个名字（`web_search`、`web_fetch`、`read`、`read_image`），其余无论从哪来，全部进 deny 列表。所以装了新插件，它的工具默认就被排除，不需要改这里。

具体到一个工具的流向：

| 插件工具类型 | 结果 |
|---|---|
| 全局工具 | 照常被屏蔽 |
| 作用域内注册 | **屏蔽不了**（见下面的说明） |

### 关于「作用域内注册」的例外

DSH 的工具分两层注册：

- **全局**：`ctx.tools.register(def)`，公共工具，`restrict()` 能挡。
- **作用域内注册**：直接注册在 Agent 预设上下文中的工具，`restrict()` **挡不住**。这是 `dsh-tools` 的明文约定：`scoped registrations remain visible`。

也就是说，**任何在作用域内注册工具的插件，它的工具都会出现在聊天模式里**，预设和本插件都无能为力。已知的例子是 `dsh-gitbash-shell`，它会把 `bash`、`gitbash_native`、`gitbash_to_native_path` 注册进作用域。

遇到这种情况只有两个选择：关掉那个插件，或者接受它的工具出现在聊天模式里。

验证方法很简单：在聊天模式里问一句「你现在有哪些工具」，多出来的就是这类工具。

### 会话中途装了新插件

本插件监听 `tools/change`，工具一有变动就对已加护的会话重新计算掩码，所以新出现的工具会在同一轮被压掉。实测生效，不需要重开会话，也不需要重启。

万一发现某个工具漏了，重启 DSH 再开聊天会话是最保险的。

## 人设

`cordis.patch.yml` 里的 `prefix` 就是全部人设。

它沿四个方向约束说话方式：

- **语气**：友善、温暖，允许有情绪
- **风格**：允许口语和表情，减少刻板用语
- **诚实**：允许说不知道，不随意编造，需要最新信息会搜索。
- **语言**：思维链全中文

具体措辞以 `cordis.patch.yml` 为准。

人设可以直接让 Agent 修改，理论上修改会即时生效，范围是使用该预设的所有会话，但保险起见最好重启。

## 兼容性

| 项目 | 值 |
|---|---|
| DSH 版本 | `>=0.2.2-rc.1 <0.3.0-0` |
| 实际测试 | `0.2.2-rc.1` |

依赖（均为 DeepSeek Harness 官方包）：`@deepseek-ai/dsh-persona`、`@deepseek-ai/dsh-tool-web`、`@deepseek-ai/dsh-tool-fs`、`@deepseek-ai/dsh-compaction-basic`。**不依赖任何第三方插件**，时间注入和工作目录屏蔽由本包自带。

`plugins/no-cwd.js` 通过 `ctx.systemPrompt.context()` 遮蔽工作目录那一节，需要 Host 提供 `systemPrompt` 服务；缺少它时这个补丁会加载失败，去掉预设里的 `chatmode-no-cwd` 那一行即可。

工具限制用到的 `agent-preset/selected`、`tools.restrict()`、`tools/change` 三个接口属于工具层，不在应用层的升级指南覆盖范围内。`v0.2.1-rc.2` 引入了 `ResolvedToolSet` 并重构了工具声明时序，所以更早的 0.2.0 版本不保证可用，版本下限就定在这里。

### DSH-Go 支持

在 [DSH-Go](https://github.com/ccch1mneyyy/dsh-Go) 的本机引擎里，用它的「终端」执行（App 启动引擎用的 profile 是 `web`）：

```sh
dsh plugin --profile web add @wssdll/dsh-chat-preset
```

装完点「新对话」-「预设」即可看到「聊天模式」。如果显示「加载失败/不可用」，通常是内置引擎版本低于 `0.2.2-rc.1` 导致 `engines.dsh` 不满足；可查看引擎日志确认 DSH 版本。

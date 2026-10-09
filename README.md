# dsh-session-path

[![npm](https://img.shields.io/npm/v/dsh-session-path)](https://www.npmjs.com/package/dsh-session-path)
[![ci](https://github.com/439436269-ctrl/dsh-session-path/actions/workflows/ci.yml/badge.svg)](https://github.com/439436269-ctrl/dsh-session-path/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-session-path)](./LICENSE)

给 DSH 的**会话**加一条「路径」：复制当前会话的日志路径（或一段可直接粘贴的接续指令），
让另一个会话能读到这段对话并接着往下干。

```
会话 header 里的 ⧉ 按钮  ──►  剪贴板里的接续块（标题 / 会话 ID / 工作目录 / 日志路径）
                                        │
另一个会话  ──►  session_handoff({ sessionId })  ──►  解压后的可读文件  ──►  read 它，继续
```

## 它解决什么问题

DSH 每个会话的原始记录在 `$DSH_HOME/sessions/<工作区>/<会话目录>/session[.vN].jsonl[.zstd]`。
这个文件有两个麻烦：

1. 路径不好拿 —— GUI 里没有「复制会话路径」的入口；
2. 拿到了也不好读 —— `.zstd` 是**多帧** Zstandard 容器（每次追加一个独立 frame），
   `zcat` 之类只解第一帧，直接 `read` 会失败。

这个插件把两件事都补上：一个按钮复制路径/接续块，一个工具把日志转成可读文件。

## 装法

从 npm 装进某个 profile：

```sh
dsh plugin --profile desktop add dsh-session-path
```

本地开发时也可以直接装插件目录（见下面的「开发循环」，注意 `link:` 装法对本插件不可用）：

```sh
dsh plugin --profile desktop add ./dsh-session-path
```

或者手工两步（可热载入、不必重启 DSH）：

1. 在 profile 的 `package.json` 里加依赖
   `"dsh-session-path": "file:<tgz 或目录>"`，然后在 profile 目录跑一次 `pnpm install`；
2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一行挂载：

```yaml
- insert:
    - id: dsh-session-path
      name: dsh-session-path
```

> 注意：`insert` 不去重。走用户补丁层就别再往 `dsh.profile.bundles` 里加同一个包，
> 否则同一 id 插两行、槽位重复注册。

## 用法

### 1. GUI：会话 header 上的 ⧉ 按钮（当前会话）

会话标题栏右侧多一个 ⧉ 按钮，点一下把下面这段放进剪贴板（复制成功变 ✓，失败变 ⚠）：

```
【接续会话】<标题>
会话 ID：session-xxxxxxxx-…
工作目录：/Users/you/project
会话日志：/Users/you/.dsh/sessions/…/session.v4.jsonl.zstd

提示：日志是 zstd 多帧压缩的 JSONL。在任意 DSH 会话里调用工具
session_handoff({ sessionId: "session-xxxxxxxx-…" }) 可直接得到解压后的可读记录路径，再 read 它即可接续。
```

配置 `copyFormat: path` 时只复制裸路径一行。

### 2. GUI：侧栏会话行右键菜单里的「复制会话路径」（任意会话）

侧栏任何一条会话的 `⋯` 菜单 / 右键菜单里，最后一项是**「复制会话路径」**（在「归档会话」下面，
带一条分隔线）——**不用先打开那个会话**。点击后菜单关闭，顶部弹一条「会话路径已复制」提示。

注册用的是宿主自己的 `list` 槽位 `sidebar.workspaces.session.menu.item`（和「置顶/重命名/分叉/归档」
同一套机制），`order: 500` 排在归档（400）之后，`separatorBefore` 让本项自成一组。

### 3. 工具：`session_path`

拿路径和会话信息，只读、不落盘。

| 参数 | 说明 |
|---|---|
| `sessionId` | 目标会话；省略＝当前会话 |
| `format` | `path`（裸路径）或 `block`（接续块，默认取插件配置） |

### 4. 工具：`session_handoff`

把会话渲染成**解压后的可读文件**，返回绝对路径 —— 这是「其他会话读取并接续」的正路。

| 参数 | 说明 |
|---|---|
| `sessionId` | 目标会话；省略＝当前会话 |
| `format` | `md`（默认，转录：用户/助手文本 + 工具调用一行摘要）或 `jsonl`（解压后的原始事件流） |
| `maxChars` | 字符预算；**超出时保留最近的部分**（接续只需要最近上下文），默认取插件配置 |

输出示例：

```
会话记录已写出：/Users/you/.dsh/session-handoff/session-xxxxxxxx-….md
格式 md · 18432 字符 · 46 条（仅最近部分，前文已截断）
工作目录：/Users/you/project
原始日志：/Users/you/.dsh/sessions/…/session.v4.jsonl.zstd
下一步：用 read 读取 … 即可接续该会话。
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则不注册任何工具与路由 |
| `copyFormat` | `block` | 按钮复制的内容：`block` 接续块 / `path` 裸路径 |
| `handoffFormat` | `md` | `session_handoff` 的默认格式 |
| `handoffDir` | `""` | 交接文件目录；空＝`$DSH_HOME/session-handoff` |
| `maxHandoffChars` | `200000` | 单个交接文件的字符预算 |
| `titleScanBytes` | `2097152` | 从日志里读标题时的压缩字节预算 |
| `promptEnabled` | `true` | 是否往 system prompt 里加那段引导 |
| `promptOrder` | `64` | 该段的排序 |

注意：profile 的 `cordis.patch.yml` 对 `config` 是**整块替换**，只想改一个键也要把想保留的键写全。

## 结构

```
lib/index.js         入口：装配 settings / systemPrompt / 路由 / 工具
lib/config.js        schemastery Config + 代码侧默认值
lib/paths.js         $DSH_HOME、sessions 根、会话目录与日志代际
lib/zstd.js          多帧 Zstandard 边界扫描 + 逐帧读取
lib/session-info.js  会话 id → 路径 / cwd / 标题
lib/handoff.js       转录渲染与交接文件写出
lib/copy-text.js     剪贴板载荷
lib/route.js         /api/dsh-session-path/resolve（只读，带信任围栏）
lib/trust.js         Host / Origin / sec-fetch-site 判定
lib/tools.js         session_path、session_handoff
lib/client.js        浏览器半：header ⧉ 按钮 + 侧栏会话行菜单项
test/selftest.mjs    23 项自检（含真实多帧日志）
```

## 开发循环（本机实测的坑）

插件的**服务端半边要 import 宿主包**（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`），
这决定了它不能用 `link:` 目录依赖 —— `link:` 之后包的真实路径在 profile 之外，
Node 从真实路径往上找 `node_modules` 找不到宿主包，插件会 `ERR_MODULE_NOT_FOUND`：

```
$ node -e "import('@deepseek-ai/dsh-tools')"   # 在插件目录里
dsh-tools FAIL ERR_MODULE_NOT_FOUND
```

本机其它 `link:` 插件（dsh-piano / dsh-scroll-piano）之所以没事，是因为它们服务端**不 import 任何宿主包**。

所以改代码后要**打包 + 重装**：

```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.mjs"
cd <本目录> && "$NODE" "$PNPM" pack --pack-destination dist
cd ~/.dsh/profiles/desktop && "$NODE" "$PNPM" install
# 再 touch 一下 cordis.patch.yml 触发热载入；客户端半需要刷新页面
```

> pnpm 对**同路径同版本**的 `file:` 包会跳过重装：改了版本号或 `remove` + `add` 才能确保装进去的是新代码。

## 边界

- 只读：`session_path` 与 HTTP 路由都不写盘；只有 `session_handoff` 写文件，且只写进
  `handoffDir`（默认 `$DSH_HOME/session-handoff`）。
- 不解压全文到内存：按 frame 扫描，一次只持有单帧 + 尾部残帧。
- 路由带信任围栏（仅 loopback / 显式 trusted host，拒绝 cross-site 与跨源 Origin）。
- 交接文件按字符预算**保留最近部分**：接续场景里尾部上下文才有用。

## License

MIT

# DSH 自定义工具工作室（dsh-custom-tool-studio）

在 DeepSeek Harness（DSH）里**用 Python 写工具，保存即生效**。

两条入口都能用：

- **网页**：左侧导航「自定义工具」→ 新建 / 编辑 / 测试 / 删除 / 启停；
- **对话**：直接让模型调用内置的 `custom_tool_manage` 工具。

保存后的工具会立刻注册成真正的 DSH 工具（不需要重启 DSH），模型下一轮就能调用。所有数据只存在本机 `%DSH_HOME%\custom-tools`，不会上传。

> 仓库（公开）：<https://github.com/xtt-xt/dsh-custom-tool-studio> · MIT · 当前版本 1.1.0

---

## 目录

1. [这个插件做什么](#1-这个插件做什么)
2. [界面入口](#2-界面入口)
3. [Python 工具约定](#3-python-工具约定)
4. [危险工具与内置审批 / 自动审查](#4-危险工具与内置审批--自动审查)
5. [工具包（把几个工具放在一起）](#5-工具包把几个工具放在一起)
6. [AI 侧工具 `custom_tool_manage`](#6-ai-侧工具-custom_tool_manage)
7. [数据存放位置](#7-数据存放位置)
8. [安装 / 验证 / 卸载](#8-安装--验证--卸载)
9. [一键恢复脚本](#9-一键恢复脚本)
10. [故障排查](#10-故障排查)
11. [文件清单](#11-文件清单)

---

## 1. 这个插件做什么

| 能力 | 说明 |
|---|---|
| 创建工具 | 起一个**模型可见的工具名**，写描述、参数 JSON Schema、Python 代码 |
| 即时注册 | 保存/启用/改名/删除后，host 立即对账并注册或注销，无需重启 DSH |
| 试运行 | 页面「测试」或 AI 的 `custom_tool_manage` → `action="test"`，直接传参数跑一次 |
| 危险工具 | 标记后**每次执行前**都走 DSH 内置审批，和内置的自动审查兼容 |
| 工具包 | 把几个工具归到一个有名称、有描述的分组里，一键启停整包；工具仍各自注册 |
| AI 主动解锁 | 开启后每个对话只看到管理/解锁两个工具，AI 解锁工具包后才出现包内工具；支持「始终解锁」与未分组工具单独解锁 |
| 统一存储 | 所有工具存在一个 `tools.json`，可整体备份、迁移、删除 |
| 一键恢复 | `restore.ps1` 把插件从 profile 里干净卸载，可选清空工具数据 |

不是 Skill、不是 MCP：工具是**同进程注册的真正 DSH 工具**，执行时由 host 启动本机 Python 进程运行你的脚本。

---

## 2. 界面入口

安装并重启 DSH 后，左侧导航栏会出现「自定义工具」（与「插件」「插件市场」「自动化任务」「技能中心」同一排）。点进去是工具列表页：

- 每行显示工具名（等宽字体）、标题、一句话描述，以及 `Python`、`危险`、`已禁用` 徽标；
- 列表按**工具包分组**：每个包一张卡片，卡片头是包名、包描述、`N 个工具 · 启用 M`，右侧是整包开关和 `编辑`/`删除`；没有归包的工具放在最后一张「未分组工具」卡片里；
- 每行右侧：`测试`、`编辑`、`删除`，以及该工具自己的启用/停用开关；
- 顶部按钮：`设置`、`刷新`、`新建工具包`、`新建工具`。`新建工具` 打开编辑对话框：名称、标题、描述、所属工具包、参数 JSON Schema、Python 代码、危险工具开关、启用开关；
- 没有工具也没有工具包时显示空状态和 `def run(args): ...` 约定；
- 如果 host 探测不到 Python，页面顶部会显示「未检测到 Python，创建的工具无法执行」的警告条，并带上具体原因。

「测试」对话框里填 `args` JSON（就是传给 `run(args)` 的对象），点「运行」后显示成功/失败、结果、stdout、stderr 和耗时。**测试失败不会弄坏已保存的工具**。

---

## 3. Python 工具约定

### 3.1 最小例子

```python
def run(args):
    text = args["text"]
    return {
        "chars": len(text),
        "upper": text.upper(),
    }
```

- 脚本必须定义 **`def run(args):`**（页面和 AI 侧都会校验代码里有没有这个入口）；
- `args` 是模型按**参数 JSON Schema** 传进来的参数对象（普通 Python `dict`）；
- **返回值**必须是可 JSON 序列化的值（`dict` / `list` / `str` / 数字 / `bool` / `None`）。host 会把它 `json.dumps(..., ensure_ascii=False)` 后作为工具结果给模型看；
- 返回值是**结果通道**，`print()` 是**日志通道**，两者互不干扰：
  - `print()` / `sys.stdout` 的内容作为 `stdout` 展示（最多保留末尾 8,000 字符）；
  - 脚本写到 `sys.stderr` 的内容进 `stderr`；抛出的异常被抓成 `error`（含 traceback），不会混进 `stderr`；
  - 结果 JSON 超过 20,000 字符会被截断。
- 脚本在独立 Python 进程里执行，工作目录是 DSH 进程的当前目录；可以用 Python 标准库，第三方库需要装在那个解释器里；
- 默认超时 **60 秒**，超时或取消会终止进程。可用环境变量 `DSH_CUSTOM_TOOL_TIMEOUT_MS` 调整（毫秒），改完重启 DSH；
- 每次执行都会在 `runs\` 下建一个临时目录（`tool.py`、`args.json`、`result.json`、`stdout.txt`、`stderr.txt`），只保留最新 **30** 个；
- 解释器探测顺序：`DSH_CUSTOM_TOOL_PYTHON`（可指定完整路径）→ `python` → `python3` → `py -3`。

### 3.2 参数 JSON Schema 怎么填

参数根节点必须是 JSON **对象**。常用写法：

```json
{
  "type": "object",
  "properties": {
    "text": { "type": "string", "description": "要统计的文本" },
    "limit": { "type": "integer", "description": "最多返回几行" }
  },
  "required": ["text"]
}
```

- `description` 写给模型看，说明每个参数的含义；
- `required` 里列出必填参数；
- 没有参数就填 `{"type": "object", "properties": {}}`；
- 非法 JSON 或非对象会被 host 容忍并退化成「无参数」，但那样模型就传不进参数了——以页面「测试」的结果为准。

### 3.3 名称与描述

- 工具名规则：`^[a-z][a-z0-9_]{1,47}$`（小写字母开头，只含小写字母/数字/下划线，长度 2–48）；
- `run_code` 是 DSH 保留名，不能使用；
- 不能和内置工具、其它插件已经注册的工具重名（例如 `read_file`），冲突时保存会报「已被现有工具占用」；
- `description` 是**模型选工具的主要依据**，写清「做什么 / 什么时候用 / 返回什么」；
- 标题（`title`）只给人看，可以写中文；不填时默认等于工具名。

---

## 4. 危险工具与内置审批 / 自动审查

- 编辑对话框里的「危险工具」开关，或 AI 侧 `dangerous: true`，会把工具标记为危险；
- 标为危险后，模型**每一次调用**它都会先产生一个 `ask` 审批决定，由 DSH 内置审批界面问你「是否运行危险自定义工具 xxx？」，点拒绝就不会执行；AI 通过 `custom_tool_manage` 的 `action="test"` 试跑危险工具同样要审批；
- 页面上的「测试」按钮是你本人直接点的一次运行，直接执行、不弹审批（否则等于自己审批自己）；
- 这与 desktop profile 默认加载的内置**自动审查**（`@deepseek-ai/dsh-experimental-auto-review`）兼容：自动审查策略接管 `ask` 的时候同样按它的判断走，不需要额外配置；
- 非危险工具**不会**弹审批；
- 建议把会写文件、删文件、执行系统命令、访问网络、读取敏感目录的工具都标成危险。

### 4.1 管理操作审批（顶部「设置」）

除「危险工具执行」之外，还可以让 AI 的**管理操作**也要你确认：

| 开关 | 默认 | 作用 |
|---|---|---|
| 创建工具需要审批 | 关 | AI 用 `custom_tool_manage` 的 `create` 新建工具时先弹审批 |
| 修改工具需要审批 | 关 | AI 用 `update` 改名称/描述/参数/代码/危险与启用状态时先弹审批 |
| 删除工具需要审批 | **开** | AI 用 `delete` 删除工具时先弹审批（删除不可恢复，所以默认开） |

工具包的操作复用同样三个开关：

| AI action | 走哪个开关 |
|---|---|
| `pack_create` | 创建工具需要审批 |
| `pack_update`（改描述/改成员/改名） | 修改工具需要审批 |
| `pack_delete` | 删除工具需要审批 |
| `pack_set_enabled` | 不拦（和 `set_enabled` 一样，只是批量改启用状态） |

- 三个开关存在 `%DSH_HOME%\custom-tools\settings.json`，点「保存设置」写入；
- 只拦截 **AI 侧** 的 `custom_tool_manage`；你在页面上点按钮 / 用表单操作不会被自己拦；
- `test`（试跑）不在三个开关里：它按「危险工具」规则单独判定；
- 「危险工具执行审批」不受这里影响，始终生效。

> 危险开关只是「每次都问」，不是沙箱。脚本仍以当前用户权限运行，写代码时要自己注意边界。

---

## 5. 工具包（把几个工具放在一起）

工具包（pack）是**分组**，不是新的工具类型：

- 一个包有**名称**（1–48 字符，可写中文）和**描述**；
- 包里的工具仍然是**各自独立的 DSH 工具**，注册方式、工具名、参数、代码、危险标记全部不变；
- 包只做两件事：把工具在页面里归到一起、以及**一键启停**（等价于逐个改它们的启用标记）。

### 5.1 在页面里用

1. 点顶部 `新建工具包`，填名称和描述，在「包里的工具」里勾选要放进去的工具；
2. 保存后列表里出现这个工具包的卡片，勾选的工具显示在它下面；
3. 卡片头的开关**一键启用/停用整包**：全部启用时开、全部停用时空、部分启用时显示「部分启用」并可一键全部打开；
4. 工具要换包：编辑工具 → 「所属工具包」下拉选另一个包（或选「不放入工具包」）；
5. 删除工具包只是取消分组：包里的工具**全部保留**，变回「未分组工具」。

> 包和工具是「一个工具最多属于一个包」的关系（成员关系记在工具记录上），所以改包名不会影响任何工具。

### 5.2 什么时候用

- 工具多起来以后按用途分类：`文本处理`、`数据处理`、`运维脚本`……；
- 调试某批工具时整包停掉，避免它们出现在模型的工具列表里；需要时整包打开。

### 5.3 AI 主动解锁模式（deferred tool loading）

通用叫法是 **deferred tool loading（工具延迟加载）/ progressive tool disclosure（渐进式工具披露）**；Anthropic 侧叫 Tool Search / `defer_loading`，OpenAI Responses 侧叫 deferred tools。插件用的是 DSH 内核自带的「会话中途增加工具」通道：**解锁只改变当前 agent 的可见性，不重新注册工具**。

开启方式：页面顶部「设置」→ 打开「AI 主动解锁模式」。

开启后：

1. 每个对话初始只看到两个自定义工具：
   - `custom_tool_manage`（管理工具/工具包）
   - `custom_tool_unlock`（解锁工具包）
2. 包里的工具默认**不可见、不可调用**；AI 调 `custom_tool_unlock` 的 `action="unlock"`、`pack="包名"` 后，包内启用的工具在**下一轮请求**出现。
3. **不同对话单独解锁**：解锁状态按 session id 记在 `unlocks.json`；新对话 / 子代理不会继承。DSH 重启或插件重挂载后会按文件恢复。
4. **始终解锁**：编辑工具包 → 打开「始终解锁（所有对话可见）」。这个包在任何对话里都无需解锁，适合常用工具。也可以让 AI 用 `custom_tool_manage` 的 `pack_update` 传 `alwaysUnlocked=true`。
5. **未分组工具**：编辑工具 → 把它放进某个工具包是推荐做法。若确实要保留未分组，可在「设置」里打开「允许单独解锁未分组工具」，然后 AI 用 `custom_tool_unlock` 的 `tool="工具名"` 单独解锁；关闭这个开关时，未分组工具不能单独解锁，只能放进工具包。
6. 关闭解锁模式：所有启用工具立即恢复可见；`unlocks.json` 里的记录保留，下次开启继续生效。
7. **工具包清单会注入上下文**：插件注册了一段动态运行上下文（`ctx.systemPrompt.context`），把当前工具包、成员名与未分组工具写进每个模型步骤的提示里，AI 不用先调 `action="list"` 就知道有什么可解锁。文本每次组装时重建，改包/改开关下一轮即生效；解锁模式关闭时不注入，避免无意义 token。

注意：

- 这是**可见性/上下文管理**，不是权限边界。危险工具即使被解锁，每次执行仍然走 DSH 内置审批。
- 解锁/锁定不会改变工具的启用状态；要停用整包请用工具包开关或 `pack_set_enabled`。
- 可见工具集变化会让该对话的提示前缀缓存失效一次，这是解锁的固有成本。
- 插件重挂载（bundle 禁用→启用）时，旧掩码会先释放、再按 `unlocks.json` 重建，不会出现「解锁了却仍不可见」的叠加。

---

## 6. AI 侧工具 `custom_tool_manage`

模型可以直接调用 `custom_tool_manage` 完成全部管理操作，和网页共用同一套逻辑。

### 6.1 action 列表

| action | 作用 | 必填参数 |
|---|---|---|
| `list` | 列出所有自定义工具（含启用/危险状态，以及工具包名） | – |
| `get` | 查看某个工具的完整定义（含 Python 代码、所属工具包） | `name` |
| `create` | 新建并注册一个工具 | `name`、`description`、`code` |
| `update` | 修改已有工具（只改传入的字段） | `name` + 至少一个字段 |
| `delete` | 删除工具（同时从 DSH 注销） | `name` |
| `set_enabled` | 启用 / 停用 | `name`、`enabled` |
| `test` | 用给定参数试运行一次 | `name`（`args` 可选） |
| `pack_list` | 列出工具包及各自成员 | – |
| `pack_get` | 查看一个工具包的成员与描述 | `pack`（或 `name`） |
| `pack_create` | 新建工具包，可同时指定成员 | `name`（`description`/`tools`/`alwaysUnlocked` 可选） |
| `pack_update` | 改包描述 / 改成员 / 改名 / 改始终解锁 | `pack` + 至少一项（`description`/`tools`/`alwaysUnlocked`/`name`） |
| `pack_delete` | 删除工具包（**工具保留**，变未分组） | `pack` |
| `pack_set_enabled` | 一键启停整包 | `pack`、`enabled` |

### 6.2 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | 上面 13 个之一（必填） |
| `name` | string | 工具名；`create` 必填，其余工具类 action 用它定位工具。`pack_create` 时是包名，`pack_update` 时是包的**新名字** |
| `title` | string | 给人看的标题，可空 |
| `description` | string | 给模型看的说明；`create` 必填。工具包类 action 里是包的描述 |
| `parameters` | object | 参数 JSON Schema 对象；省略则无参数 |
| `code` | string | Python 源码，必须含 `def run(args):`；`create` 必填 |
| `dangerous` | boolean | 是否危险（每次执行需审批），默认 `false` |
| `enabled` | boolean | 是否启用，默认 `true`；停用的工具不注册 |
| `pack` | string | 包名或包 id：`pack_get/update/delete/set_enabled` 用它定位包；`create`/`update` 用它把**这个工具**放进该包，传空字符串表示移出 |
| `tools` | string[] | 包成员（工具名数组）：`pack_create` 可选；`pack_update` 给了就整体替换成员（没列出的工具移出该包但保留） |
| `alwaysUnlocked` | boolean | 工具包是否「始终解锁」：`true` 时任何对话都无需 `custom_tool_unlock` 即可见。仅在解锁模式开启时有意义 |
| `args` | object | 仅 `test` 使用：传给 `run(args)` 的参数对象 |

### 6.3 对话示例

```text
帮我新建一个自定义工具 python_word_count，统计文本字符数。
参数：text（字符串，必填）。代码用 def run(args): return {"chars": len(args["text"])}
```

模型会调用 `custom_tool_manage`：`action="create"`，然后建议 `action="test"` 验证。

也可以直接说：

```text
列出我现在所有的自定义工具，并测试 python_word_count，参数 text="hello"
```

工具包相关：

```text
把 python_word_count 和 python_clean_text 放进一个叫「文本处理」的工具包，
描述写「处理文本统计与清洗」。然后把整个包停用。
```

模型会依次调用 `pack_create`（`name="文本处理"`, `description=...`, `tools=["python_word_count","python_clean_text"]`）和 `pack_set_enabled`（`pack="文本处理"`, `enabled=false`）。

### 6.4 解锁工具 `custom_tool_unlock`

只在开启「AI 主动解锁模式」后有意义。参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | `list` / `unlock` / `lock`（必填） |
| `pack` | string | 工具包名称或 id；与 `tool` 二选一 |
| `tool` | string | 未分组工具名；与 `pack` 二选一，需要设置开启「允许单独解锁未分组工具」 |

`action` 行为：

| action | 作用 |
|---|---|
| `list` | 列出所有工具包、未分组工具及各自状态（未解锁 / 当前对话已解锁 / 始终解锁 / 已停用），并说明当前设置 |
| `unlock` | 解锁整个包（`pack=...`）或一个未分组工具（`tool=...`）；下一轮请求生效 |
| `lock` | 反向收起；`alwaysUnlocked` 的包不能单独锁定，要去页面关闭「始终解锁」 |

示例：

```text
我需要用 mcdev-docs 里的工具查文档。
```

模型会先 `custom_tool_unlock` `action="list"`，再 `action="unlock"`、`pack="mcdev-docs"`；包内工具在下一轮出现。属于某个包的工具不能用 `tool=...` 绕过包，必须整包解锁。

---

## 7. 数据存放位置

所有数据都在：

```text
%DSH_HOME%\custom-tools
```

本机默认是：

```text
C:\Users\acer\.dsh\custom-tools
```

> 如果设置过 `DSH_HOME`，以它为准；插件也支持用 `DSH_CUSTOM_TOOLS_DIR` 指向别的目录（需重启 DSH）。

| 路径 | 内容 | 说明 |
|---|---|---|
| `tools.json` | 工具记录（唯一真源） | 名称、标题、描述、参数、代码、dangerous、enabled、`packId`（所属工具包，空=未分组）、时间戳 |
| `packs.json` | 工具包记录 | `id`、`name`、`description`、`alwaysUnlocked`（是否始终解锁）、时间戳；成员关系不在这个文件里，而在各工具的 `packId` 上 |
| `settings.json` | 全局开关 | `unlockMode`（AI 主动解锁模式）、`allowUngroupedUnlock`（允许单独解锁未分组工具）、`approveCreate` / `approveUpdate` / `approveDelete`；文件不存在时用默认值（解锁模式关、删除审批开） |
| `unlocks.json` | 按对话的解锁状态 | `sessions.<sessionId>.packs`（已解锁的工具包 id）+ `.tools`（已单独解锁的未分组工具 id）；最多保留最近 200 个对话 |
| `scripts\<工具名>.py` | 每个工具的代码副本 | 方便直接阅读/备份；**直接改这里不会生效**，执行用的是 `tools.json` 里的 code |
| `runs\r_<...>\` | 每次执行的临时目录 | 含 `tool.py`、`args.json`、`result.json`、`stdout.txt`、`stderr.txt`；自动只留最新 30 个 |
| `runner.py` | 自动生成的 Python 执行器 | 不要手改，会被覆盖 |

备份/迁移：直接复制整个 `custom-tools` 目录即可（`tools.json` + `packs.json` + `settings.json` + `unlocks.json` 一起复制才算完整）。恢复时把目录放回原位（或设 `DSH_CUSTOM_TOOLS_DIR`），重启 DSH。

> 只把 `packs.json` 删掉不会丢工具：每个工具的 `packId` 找不到对应的包时，它会作为「未分组工具」照常列出来。

---

## 8. 安装 / 验证 / 卸载

> 下面命令都在 PowerShell 里执行。**用 `dsh.cmd`，不要直接敲 `dsh`**（PowerShell 执行策略常禁止执行 `.ps1` 垫片）；本地开发用 `link:` 绝对路径，避免相对路径被锚定到当前目录。

### 8.1 安装

```powershell
dsh.cmd plugin --profile desktop add link:F:\xtt\workspace\dsh-custom-tool-studio
```

`dsh plugin` 内部会跑一次 pnpm，并在成功后把声明了 `dsh.bundle.patch` 的本包自动写进 profile 的 `dsh.profile.bundles`。

如果 PATH 上没有 `dsh.cmd`，用 node 直接调启动器：

```powershell
node "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile desktop add link:F:\xtt\workspace\dsh-custom-tool-studio
```

### 8.2 从 Git 仓库安装（本仓库）

本仓库本身就是一个可直接安装的 DSH bundle 包：根目录 `package.json` 声明了 `dsh.bundle.patch`（指向 `cordis.patch.yml`）和 `dsh.client`（Web 面板），纯 ESM + 纯脚本，**没有构建步骤**。安装后 profile 的 `dsh.profile.bundles` 会自动增加 `dsh-custom-tool-studio`。

```powershell
dsh.cmd plugin --profile desktop add git+https://github.com/xtt-xt/dsh-custom-tool-studio.git
```

仓库是**公开**的，直接装即可，不需要 token：

```powershell
dsh.cmd plugin --profile desktop add git+https://github.com/xtt-xt/dsh-custom-tool-studio.git
```

也可以装 Release 上的预构建包（`dsh-custom-tool-studio.tgz`，免源码构建）：

```powershell
dsh.cmd plugin --profile desktop add https://github.com/xtt-xt/dsh-custom-tool-studio/releases/latest/download/dsh-custom-tool-studio.tgz
```

装完同样要**完全退出 DSH 再启动**。在本机做开发时继续用 8.1 的 `link:` 方式（改代码不用重装）。

### 8.3 验证

```powershell
# 1) 确认 profile 清单里有这个 bundle（desktop 版的实验 bundle 在 app.asar 里，
#    所以 `dsh --dump-config` 在 desktop 上会因解析不到实验 bundle 而报错，别用它验证本插件）
node -e "const p=require('C:/Users/acer/.dsh/profiles/desktop/package.json');console.log(p.dsh.profile.bundles.includes('dsh-custom-tool-studio')?'bundle 已登记':'未登记')"

# 2) 完全退出 DSH 再启动（host 只在启动时读取 profile 清单）
```

重启后：

- 左侧导航出现「自定义工具」；
- 页面能打开且不提示缺少 Python；
- 新会话里模型可以调用 `custom_tool_manage`。

不启动 DSH 的离线自检（检查记录校验、工具定义构建、工具包生命周期）：

```powershell
node F:\xtt\workspace\dsh-custom-tool-studio\selfcheck.mjs
```

期望最后一行是 `SELF-CHECK OK`（退出码 0）。它会检查：工具名校验、参数 schema 归一化、输入校验、`buildToolDefinition` 的输出结构 / render 文本块 / execute 返回键与声明 schema 一致、`custom_tool_manage` 名称与 `pack_*` 动作、工具包的分组 / 整包开关 / 删除后保留工具、`alwaysUnlocked`、`custom_tool_unlock` 的 list/unlock/lock、`computeDeny` 的基线/包/单工具规则，以及 `unlocks.json` 往返。

完整离线套件（8 个）：

```powershell
node F:\xtt\workspace\dsh-custom-tool-studio\test\run.mjs
```

期望 `ALL SUITES PASS (8)`。

线上验收解锁模式（建议按顺序）：

1. 页面「设置」打开「AI 主动解锁模式」和「允许单独解锁未分组工具」，保存；
2. 新对话里模型只应看到 `custom_tool_manage` + `custom_tool_unlock`；内置工具不受影响；
3. 让 AI 执行 `custom_tool_unlock` `action="list"`，再 `action="unlock"`、`pack="<包名>"`；下一轮包内工具应出现；
4. 另开一个对话 / 子代理：它应显示「当前对话 0 个已解锁」，看不到上一个对话解锁的工具；
5. 给某个包打开「始终解锁」后，新对话无需解锁即可看到它的成员；
6. 关闭解锁模式：所有启用工具立即恢复可见；再打开，`unlocks.json` 里的记录继续生效。
7. 打开解锁模式时，模型上下文里应出现一段「自定义工具包（解锁模式已开启）」并列出包名与成员；关掉后该段消失。

完整离线测试（宿主 store / HTTP 路由 / 审批门 / 页面字典 / 页面渲染）：

```powershell
node F:\xtt\workspace\dsh-custom-tool-studio\test\run.mjs   # 或 npm test
```

期望最后一行是 `ALL SUITES PASS (8)`。

### 8.4 卸载

```powershell
dsh.cmd plugin --profile desktop remove dsh-custom-tool-studio
```

重启 DSH 后条目和工具都会消失。**工具数据会保留**在 `%DSH_HOME%\custom-tools`，需要一并清空时用下面的 `restore.ps1 -PurgeData`。

---

## 9. 一键恢复脚本

位置：

```text
F:\xtt\workspace\dsh-custom-tool-studio\restore.ps1
```

用途：把本插件从 profile 里**干净卸载**；自动卸载失败时也能靠备份完成回退。它只处理 `dsh-custom-tool-studio` 这一个 bundle，**不会碰其它插件或其它 profile 文件**。

### 9.1 基本用法

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\xtt\workspace\dsh-custom-tool-studio\restore.ps1"
```

装了 PowerShell 7 也可以：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "F:\xtt\workspace\dsh-custom-tool-studio\restore.ps1"
```

### 9.2 同时清空工具数据（不可恢复）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\xtt\workspace\dsh-custom-tool-studio\restore.ps1" -PurgeData
```

`-PurgeData` 会删除 `%DSH_HOME%\custom-tools`（本机 `C:\Users\acer\.dsh\custom-tools`），包括 `tools.json`、`scripts\`、`runs\`。脚本会校验目标必须是 `%DSH_HOME%\custom-tools` 这一确切路径，否则拒绝删除。

### 9.3 可选参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-Profile` | `desktop` | DSH profile 名 |
| `-BundleName` | `dsh-custom-tool-studio` | 要卸载的 bundle 包名 |
| `-PurgeData` | 关 | 同时删除工具数据目录 |

### 9.4 脚本每一步做什么

1. **备份**：把 `<profile>\package.json` 和 `<profile>\cordis.patch.yml`（如果存在）复制到
   `C:\Users\acer\.dsh\profiles\desktop\.restore-backup-<时间戳>\`；
2. **官方卸载**：执行
   `dsh.cmd plugin --profile desktop remove dsh-custom-tool-studio`，
   并打印退出码；PATH 上找不到 `dsh.cmd` 时自动回退到
   `node "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile desktop remove ...`；
3. **独立校验**（不信 CLI 的返回值，自己查）：
   - `package.json` 的 `dsh.profile.bundles` 里不再有 `dsh-custom-tool-studio`；
   - `<profile>\node_modules\dsh-custom-tool-studio` 不存在。

   校验失败时进入**手动回退**：以备份为底重建 `package.json`（只摘掉本插件一条，其它 bundle 原样保留）、用备份恢复 `cordis.patch.yml`、删除 `node_modules` 里的链接（只删链接，不删它指向的 `F:\xtt\workspace\dsh-custom-tool-studio` 源码目录），然后再校验一次；
4. **可选清理数据**：仅当传入 `-PurgeData` 时删除 `%DSH_HOME%\custom-tools`。

最后打印汇总，并提示：**重启 DSH 使更改生效**。脚本是幂等的，重复运行不会报错（第二次会提示「bundle 已不在 profile 中，跳过卸载」）。

退出码：`0` = 校验通过且（如要求）数据已清理；`1` = 有失败项，按输出里的 `[restore] x` 行排查。

脚本不会删除备份目录；需要彻底清理时手动删除 `.restore-backup-*` 即可。

---

## 10. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 页面顶部提示「未检测到 Python」 | 安装 Python 3 并勾选 “Add python.exe to PATH”，在 PowerShell 里确认 `python --version` 可用；或设置环境变量 `DSH_CUSTOM_TOOL_PYTHON=完整路径\python.exe`。**探测结果在 DSH 进程内缓存，改完要重启 DSH。** |
| 保存时报「工具名已被占用 / 已存在」 | 自定义工具名不能和内置工具、其它插件工具重名；只能用 `^[a-z][a-z0-9_]{1,47}$`；`run_code` 是保留名。换一个名字。 |
| 保存后模型看不到新工具 | 检查「启用」开关；停用的工具不注册。新建的工具在**下一轮请求**可见（不需要重启 DSH）。 |
| 左侧没有「自定义工具」入口 | 插件没装成功或装完没重启。先确认 profile 的 `dsh.profile.bundles` 含包名（见 8.3），再完全退出 DSH 重新启动。 |
| 工具包里的工具没变灰/没停用 | 包开关改的是**每个成员自己的启用标记**；如果某个工具是后来才加进包的，重开一次页面即可看到最新状态。包本身没有独立开关。 |
| 开启解锁模式后工具突然消失 | 预期行为：每个对话初始只保留 `custom_tool_manage` + `custom_tool_unlock`。让 AI 解锁对应工具包，或在页面把该包设为「始终解锁」；也可以在「设置」里关掉解锁模式立即恢复。 |
| AI 说未分组工具不能单独解锁 | 「设置」里的「允许单独解锁未分组工具」没开。开启后 AI 可用 `custom_tool_unlock` 的 `tool=...`；或者直接把工具放进某个工具包。 |
| 解锁成功但模型还是看不到工具 | 解锁在**下一轮请求**生效；同一轮不会立刻变。若重启过 DSH 仍不可见，检查 `unlocks.json` 里的 session id 是否是当前对话，以及 `[custom-tool-studio]` 日志里有没有 `install unlock mask ... failed`。 |
| 子代理看不到父对话解锁的工具 | 预期行为：每个 agent / 对话单独解锁。子代理自己调用 `custom_tool_unlock`，或把包设为始终解锁。 |
| 插件重挂载后解锁状态错乱 | 正常流程会先释放旧掩码、再按 `unlocks.json` 重建；若仍异常，查看日志里的 `install unlock mask` / `dispose`，必要时删除 `unlocks.json` 让该对话重新解锁。 |
| 页面能开但一操作就报错 | 看 DSH 启动日志里的 `[custom-tool-studio]` 警告（host 挂载失败会被记录）；也看页面上的错误文字。 |
| 改了 `scripts\*.py` 不生效 | 正常：`tools.json` 才是真源，`scripts\` 只是代码副本。请在页面/让 AI 改，或改完用 `custom_tool_manage` 的 `update` 写回。 |
| 执行超时 | 默认 60 秒；设 `DSH_CUSTOM_TOOL_TIMEOUT_MS`（毫秒）后重启 DSH，或让脚本更快返回。 |
| 危险工具没弹审批 | 确认保存时「危险工具」是开着的；确认 profile 里审批/自动审查插件正常；改完重启 DSH。 |
| 中文输出乱码 | 执行器已设置 `PYTHONUTF8=1`；仍乱码时把脚本文件存成 UTF-8（无 BOM），并在脚本里显式 `encoding="utf-8"` 读写文件。 |
| `dsh` 命令找不到 / 报执行策略错误 | 用 `dsh.cmd`；或 `node "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" ...`。 |
| 卸载后数据还在 | 属于预期：`custom-tools` 独立于插件。要清空用 `restore.ps1 -PurgeData`。 |
| 插件卸载/安装后行为异常 | 装、卸插件都必须**完全重启 DSH**；GUI 当前进程不会热加载新 bundle。 |

---

## 11. 文件清单

```text
F:\xtt\workspace\dsh-custom-tool-studio\
├─ package.json          # bundle 声明（dsh.bundle.patch / dsh.client）、入口
├─ cordis.patch.yml      # bundle 层：往 loader 树插入 custom-tool-studio
├─ index.js              # host 入口：存储、注册、HTTP 路由、dangerous 审批门
├─ lib\
│  ├─ store.js           # tools.json / packs.json / settings.json / unlocks.json 读写 + 输入校验
│  ├─ access.js          # 按 agent 计算 deny 掩码；会话解锁状态与 bundle 重挂清理
│  ├─ python.js          # Python 探测与执行（stdout/stderr/超时/取消）
│  ├─ tools.js           # 每个记录 → ToolDefinition；custom_tool_manage + custom_tool_unlock
│  ├─ prompt.js          # 解锁模式下把工具包清单写进模型上下文
│  └─ routes.js          # /api/custom-tool-studio/* 路由
├─ client.js             # Web 页面（侧边栏 + 分组列表/编辑/测试/设置/始终解锁）
├─ test\                 # 离线测试（node test/run.mjs）
│  ├─ run.mjs            # 汇总入口
│  ├─ store.test.mjs     # 记录校验 / 持久化 / 工具包 / 解锁状态
│  ├─ access.test.mjs    # deny 掩码、每对话隔离、模式开关、持久化
│  ├─ unlock-tool.test.mjs # custom_tool_unlock 的 list/unlock/lock
│  ├─ prompt.test.mjs    # 上下文里的工具包清单（模式开关、成员、始终解锁）
│  ├─ routes.test.mjs    # HTTP 路由与错误码
│  ├─ gate.test.mjs      # 危险工具与审批开关
│  ├─ client-dict.test.mjs   # 字典 zh/en 对齐、用到的 key 都存在
│  └─ client-render.test.mjs # 纯组件渲染（对话框/分组/编辑器/开关）
├─ .github\workflows\ci.yml  # 推送后自动跑 selfcheck + 测试
├─ scripts\push-api.mjs  # 本机 git push 走不通时，用 GitHub API 提交
├─ locale\               # zh / en 文案
├─ icon.svg
├─ restore.ps1           # 一键恢复（本文件第 9 节）
├─ selfcheck.mjs         # 离线自检
└─ README.md             # 本文件
```

开发循环：

```text
改 index.js / lib\*.js / client.js
  → node F:\xtt\workspace\dsh-custom-tool-studio\selfcheck.mjs
  → node F:\xtt\workspace\dsh-custom-tool-studio\test\run.mjs
  → 重启 DSH（link: 安装后改代码不需要重新 add）
```

### 11.1 推送到 GitHub

仓库地址（**公开**）：<https://github.com/xtt-xt/dsh-custom-tool-studio>

`origin` 走 **SSH**（`git@github.com:xtt-xt/dsh-custom-tool-studio.git`）：本机 `github.com:22` 可通、`github.com:443` 被拦，所以 SSH 是这台机器上可用的 git 传输方式。公钥 `~/.ssh/id_ed25519` 已加到 GitHub 账号 `xtt-xt`。

```powershell
git add -A
git commit -m "feat: ..."
git push               # 已设置 upstream = origin/main
```

如果换到只有 `api.github.com` 可通、22/443 都不通的环境，用仓库里的 API 脚本提交同样的树（不需要 git 协议）：

```powershell
$env:GH_TOKEN = '<GitHub PAT>'          # 需要 Contents: write
"feat: ..." | Set-Content -Path "$env:TEMP\msg.txt" -Encoding utf8
node scripts\push-api.mjs xtt-xt/dsh-custom-tool-studio main "$env:TEMP\msg.txt"
```

脚本会为每个已跟踪文件建 blob → 建 tree → 建 commit → 移动 `refs/heads/main`，输出的最后一行是 commit 链接。用它推送后，本机执行 `git fetch origin && git reset --hard origin/main` 把本地历史对齐到远端。

---

_适用：DSH desktop profile，Node.js 20+，Windows。最后更新：2026-10-18。_

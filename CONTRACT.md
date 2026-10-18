# dsh-custom-tool-studio — build contract (shared by host and client halves)

Bundle directory: `F:\xtt\workspace\dsh-custom-tool-studio`
Package name: `dsh-custom-tool-studio`
Installed into the `desktop` profile as a local-link bundle.

## File ownership (avoid overlap)

| Path | Owner |
|---|---|
| `package.json`, `cordis.patch.yml`, `icon.svg`, `locale/*.json` | lead (already written, do not edit) |
| `index.js`, `lib/*.js` | lead |
| `client.js` | client-ui teammate ONLY |
| `restore.ps1`, `README.md`, `selfcheck.mjs` | packaging teammate ONLY |
| `CONTRACT.md` | lead |

No build step. Everything is plain ESM JavaScript for the host and a plain
`window.__ModuleLoader__` factory for the client. Do not add dependencies.

---

## 1. Record shape (`ToolRecord`)

```jsonc
{
  "id": "t_1a2b3c4d5e6f",       // stable, host-generated
  "name": "python_word_count",  // model-facing tool name: ^[a-z][a-z0-9_]{1,47}$
  "title": "字数统计",           // display title (may be Chinese)
  "description": "统计一段文本的字符数…", // model-facing; tells the model WHEN to use it
  "parameters": {               // RAW JSON Schema, root object
    "type": "object",
    "properties": { "text": { "type": "string", "description": "要统计的文本" } },
    "required": ["text"]
  },
  "code": "def run(args):\n    return {'chars': len(args['text'])}\n",
  "dangerous": false,           // true → every execution needs built-in approval
  "enabled": true,              // false → not registered as a tool
  "packId": "",                 // "" = ungrouped; otherwise a ToolPack.id
  "createdAt": "2026-10-17T13:00:00.000Z",
  "updatedAt": "2026-10-17T13:00:00.000Z",
  "registered": true            // READ-ONLY runtime status from the host, never sent back
}
```

## 1.1 Pack shape (`ToolPack`, `packs.json`)

```jsonc
{
  "id": "p_1a2b3c4d5e6f",       // host-generated
  "name": "文本处理",            // display label, 1–48 chars, unique (case-insensitive)
  "description": "处理文本统计与清洗的工具",  // optional, ≤500 chars
  "alwaysUnlocked": false,      // true → visible in every conversation, no unlock needed
  "createdAt": "2026-10-18T13:00:00.000Z",
  "updatedAt": "2026-10-18T13:00:00.000Z"
}
```

### 1.2 Settings shape (`settings.json`)

```jsonc
{
  "unlockMode": false,            // expose only the two studio tools until unlocked
  "allowUngroupedUnlock": false,  // allow unlocking one ungrouped tool by name
  "approveCreate": false,
  "approveUpdate": false,
  "approveDelete": true
}
```

Missing keys fall back to these defaults. `unlockMode` and
`allowUngroupedUnlock` are policy gates: turning the latter off hides
remembered single-tool unlocks but does not erase them from `unlocks.json`.

### 1.3 Per-session unlock shape (`unlocks.json`)

```jsonc
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "packs": ["p_1a2b3c4d5e6f"],  // unlocked pack ids
      "tools": ["t_1a2b3c4d5e6f"],  // individually unlocked ungrouped tool ids
      "updatedAt": "2026-10-18T13:00:00.000Z"
    }
  }
}
```

At most the 200 most recently updated sessions are kept. Deleting a pack or a
tool leaves stale ids behind; they are ignored when computing visibility.

Membership lives on the **tool** (`packId`), never on the pack: one tool belongs
to at most one pack, renaming a pack cannot break membership, and deleting a
pack only clears the members' `packId`. A pack is a grouping + a bulk switch
over each member's own `enabled` flag — it must never change how tools are
registered (each tool stays an independent `ToolDefinition`).

Python convention (host executes it): the script must define `def run(args): ...`
where `args` is the parsed tool-arguments object, and return any
JSON-serializable value. `print()` output is captured as `stdout`.

---

## 2. HTTP API (host ⇄ client)

Client fetch base is **document-relative** (no leading slash):
`api/custom-tool-studio/<route>`. Host registers exact paths
`/api/custom-tool-studio/<route>`.

All responses are JSON. Success: HTTP 200. Failure: HTTP 4xx/5xx with
`{ "error": "human readable message" }`.

| Route | Method | Request body | Response |
|---|---|---|---|
| `list` | GET | – | `{ tools: ToolRecord[], packs: PackView[], settings, python: PythonInfo, paths: { store, packs, unlocks, scripts }, pythonReady: boolean }` |
| `create` | POST | `{ name, title, description, parameters, code, dangerous, enabled }` | `{ tool: ToolRecord }` |
| `update` | POST | `{ id, name?, title?, description?, parameters?, code?, dangerous?, enabled? }` | `{ tool: ToolRecord }` |
| `delete` | POST | `{ id }` | `{ deleted: true }` |
| `set-enabled` | POST | `{ id, enabled }` | `{ tool: ToolRecord }` |
| `test` | POST | `{ id, args }` (`args` = object passed to `run`) | `{ ok, result, content, stdout, stderr, durationMs, error }` |
| `settings` | GET/POST | GET – / POST `{ unlockMode?, allowUngroupedUnlock?, approveCreate?, approveUpdate?, approveDelete? }` | `{ settings, defaults? }` |
| `packs` | GET | – | `{ packs: PackView[] }` |
| `pack-create` | POST | `{ name, description?, tools?: string[], alwaysUnlocked? }` | `{ pack: PackView }` |
| `pack-update` | POST | `{ id, name?, description?, tools?: string[], alwaysUnlocked? }` | `{ pack: PackView }` |
| `pack-delete` | POST | `{ id }` | `{ deleted: true, pack, tools: ToolRecord[] }` |
| `pack-set-enabled` | POST | `{ id, enabled }` | `{ pack: PackView, tools: ToolRecord[] }` |
| `health` | GET | – | `{ ok: true, python: PythonInfo, paths: {...} }` |

`list` also returns `packs: PackView[]` and `settings`. `PackView` = the pack
record plus `{ tools: string[], toolCount, enabledCount, allEnabled }`, where
`tools` are member names. `alwaysUnlocked` is part of the pack record and is
returned unchanged.

`PythonInfo` = `{ ok: boolean, command?: string, version?: string, error?: string }`.

`test` never throws for a failing script: it returns
`{ ok: false, error: "<traceback>", stdout, stderr, durationMs }` with HTTP 200.
Only "unknown id" / bad body are HTTP 4xx.

Every call is same-origin `fetch(...)`, `headers: { 'content-type': 'application/json' }`
for POST bodies. Non-2xx: throw an `Error` carrying `body.error`.

---

## 3. Client module rules

`client.js` must be exactly this shape (a plain script, no `import`/`export`):

```js
window.__ModuleLoader__.load({
  id: 'dsh-custom-tool-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // …everything…
    return { inject: ['slots', 'locale', 'layout'], apply(ctx) { /* … */ } };
  },
});
```

Hard rules:

- **No JSX** (there is no build step): use `React.createElement` via `h`.
- No imports of `@deepseek-ai/dsh-client-ui-primitives` or any other Harness
  client package. Only `react` (and `react-dom` if truly needed).
- No DOM writes outside your own components, no `document.body` appends.
- Colors only through the theme CSS variables listed in §5. No literal colors
  except inside the sidebar SVG icon mark.
- All visible strings live in the inline `zh`/`en` dictionaries; render through
  `t('key')`. `t = ctx.locale.bind('dsh-custom-tool-studio')` reads the active
  locale on every call; register dictionaries once with
  `ctx.locale.register('dsh-custom-tool-studio', { zh, en })` inside
  `ctx.effect(...)`.
- Re-render on locale switch: subscribe with `ctx.locale.subscribe` and force a
  render (a `useSyncExternalStore` over `ctx.locale.getSnapshot().revision` is
  the intended mechanism).
- Every registration goes through `ctx.slots.inject(slotName, () => ctx.slots.register(...))`
  and every disposer returned is collected and released in `ctx.effect`.

### 3.1 Registrations (exact)

```js
const PANEL_ID = 'custom-tool-studio';
const NS = 'dsh-custom-tool-studio';

// Sidebar nav row (left rail, next to 插件 / 插件市场 / 自动化任务 / 技能中心).
slots.inject('sidebar.panellist', () => slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: 20,                       // 0 plugins, 1 market, 10 schedules, 30 skill-explorer
  label: () => t('panel.label'),   // thunk → follows the active locale
}, SidebarIconMark));

// Central page, keyed by the same id as the sidebar row.
slots.inject('main', () => slots.register({
  name: 'main',
  key: PANEL_ID,
  inject: () => ({ api, locale: ctx.get('locale') }),
}, StudioPage));
```

- Sidebar icon component props: `{ size, active }` — render an `<svg>` of
  `size` × `size`, `aria-hidden`, `style={{ display: 'block' }}`; use `active`
  to pick `--dsw-alias-brand-primary` vs `--dsw-alias-label-secondary` as
  `currentColor`/stroke.
- Main page props: the framework share plus whatever `inject` returns. The page
  owns its own data fetching through the API client, so it must render
  sensibly while `loading` and on `error` (retry button).

---

## 4. Page requirements (custom tools)

Full-height page in the central column, same visual language as the Plugins
page: a header (title + one-line subtitle + primary “新建工具” button) and a
list of rows/cards. Behaviors:

1. **List** — each row shows: icon/badge, `name` in monospace, `title`,
   one-line description, badges `Python`, `危险` (when dangerous), `已禁用`
   (when disabled), and controls `测试`, `编辑`, `删除`, plus an enable/disable
   switch (`role="switch"`, `aria-checked`).
2. **Create / Edit** — one dialog form with: 名称, 标题, 描述 (model-facing),
   所属工具包 (`<select>`: “不放入工具包” + every pack), 参数 JSON Schema
   (monospace textarea, prefilled template), Python 代码
   (monospace textarea, taller, prefilled template), 危险工具 switch
   (label explains it needs built-in approval before every run), 启用 switch.
   Validate client-side: name regex, `parameters` must parse as a JSON object,
   `code` must contain a `def run(`. Show the host's `error` text on failure.
   Submitting state disables the save button. Escape closes; focus moves into
   the dialog on open.
3. **Test** — dialog with an `args` JSON textarea and a 运行 button; shows
   `ok`/`error`, the pretty-printed `result`, `stdout`, `stderr`, `durationMs`.
4. **Delete** — confirm, then delete.
5. Empty state when there are no tools: short explanation of the Python
   convention (`def run(args): return ...`) plus the create button.
6. Show a small warning strip when the host reports `pythonReady: false`
   (“未检测到 Python，创建的工具无法执行”), with the host's `python.error`.
7. **Grouping** — render one card per pack (header: name, description,
   `N 个工具 · 启用 M`, mixed-state badge, bulk switch, `编辑`, `删除`), then
   the ungrouped remainder. Membership is derived from `tool.packId`, not from
   the pack's own `tools` field, so a stale pack count cannot hide a tool.
   A pack's switch sends `pack-set-enabled` (never a per-tool loop from the
   client) and applies the returned `tools` to the list.
8. **Pack dialogs** — 新建/编辑工具包 (name, description, member checkboxes) and
   删除工具包 (explains the tools are kept). Pack create/update reloads the
   list because membership is written onto the tool records.

The page must not crash if a field is missing from a record — treat records as
untrusted JSON.

---

## 5. Theme tokens available (use only these)

`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
`--dsw-alias-bg-layer-3`, `--dsw-alias-bg-overlay`, `--dsw-alias-border-l1`,
`--dsw-alias-border-l2`, `--dsw-alias-border-l3`,
`--dsw-alias-brand-primary`, `--dsw-alias-brand-primary-soft`,
`--dsw-alias-brand-text`, `--dsw-alias-button-primary-fill`,
`--dsw-alias-button-primary-hover`, `--dsw-alias-button-tool-bar-fill`,
`--dsw-alias-button-tool-bar-hover`, `--dsw-alias-label-primary`,
`--dsw-alias-label-secondary`, `--dsw-alias-label-tertiary`,
`--dsw-alias-interactive-bg-hover`, `--dsw-alias-interactive-bg-active`,
`--dsw-alias-interactive-bg-hover-danger`, `--dsw-alias-state-error-primary`,
`--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`,
`--dsw-alias-state-idle-primary`, `--dsw-alias-markdown-code-block`,
`--dsw-alias-markdown-inline-code`, `--dsw-alias-scrollbar-bg-l1`,
`--dsw-alias-scrollbar-hover-l1`, `--dsw-specific-menu`,
`--dsw-specific-selector`, `--dsw-specific-input-major`, `--dsw-focus-ring-color`

Style with a `<style>` element rendered by your own component
(`h('style', null, css)`) so unmounting removes it; prefix every class with
`cts-`.

---

## 6. Host module export surface (stable — other files import these)

```js
// lib/store.js
export const TOOL_NAME_RE;                       // RegExp
export function validateToolName(name);          // → string | undefined  (error text)
export function normalizeParameters(parameters); // → JSON-Schema object node (never throws)
export function normalizeInput(input, opts);     // → { record fields }  (throws Error on invalid)
export function validatePackName(name);          // → string | undefined  (error text)
export function normalizePackInput(input);       // → { name, description, alwaysUnlocked }  (throws Error on invalid)
export function createStore(rootDir);            // → Store (tools + packs + settings + unlocks)
// Store also exposes unlocks(sessionId), setUnlocks(sessionId, {packs,tools}), clearUnlocks(sessionId)

// lib/python.js
export function detectPython();                  // → { ok, command?, version?, error? }   (cached)
export async function runPython(record, args, options); // → { ok, result, content, stdout, stderr, durationMs, error? }

// lib/access.js
export const BASELINE_TOOL_NAMES;                // [custom_tool_manage, custom_tool_unlock]
export function computeDeny(input);              // → string[]  (pure deny-list computation)
export function createAccessController(options); // → { start, dispose, reconcileAll, enabled, statusFor, unlockPack, lockPack, unlockTool, lockTool }

// lib/tools.js
export const MANAGE_TOOL_NAME;                   // 'custom_tool_manage'
export const UNLOCK_TOOL_NAME;                   // 'custom_tool_unlock'
export function buildToolDefinition(record, run); // → plain ToolDefinition (no dsh imports)
export function buildManageTool(engine);         // → the agent-facing management tool
export function buildUnlockTool(access, resolveAgent); // → the per-conversation unlock tool

// lib/prompt.js
export function buildPackContextText(state);     // → the unlock-mode prompt context block ('' when the mode is off)
```

`index.js` registers `buildPackContextText` as a dynamic runtime context on
`ctx.systemPrompt.context({ name: 'custom-tool-studio.packs', order: 1000 })`,
so every model step sees the current pack list; the text is rebuilt per
assembly, and turning unlock mode off makes it empty.

`buildToolDefinition` returns a plain object acceptable to `ctx.tools.register`:
`{ name, description, parameters, output: { schema, render }, execute }` where
`output.schema` is an object-rooted JSON Schema declaring `ok` / `content`.

## 7. Acceptance for the client half

- `node --check client.js` passes.
- `grep` the file: no `import `, no `export `, no `jsx`, no literal color
  outside the icon component, no `document.` writes.
- `id: 'dsh-custom-tool-studio'` appears exactly once, in the loader call.
- After install the sidebar gains a 4th/fifth row and the page opens from it.
- `node selfcheck.mjs` reports `SELF-CHECK OK`, including the pack lifecycle
  (group → bulk switch → delete-keeps-tools), the manage tool's pack actions,
  `alwaysUnlocked` (store + pack view), `custom_tool_unlock` list/unlock/lock,
  `computeDeny` baseline/pack/single-tool behavior, and `unlocks.json` round-trip.
- `node test/run.mjs` reports `ALL SUITES PASS (8)`.
- Unlock mode: enabling it leaves exactly `custom_tool_manage` and
  `custom_tool_unlock` visible; a pack unlock reveals its members on the next
  request; another session/subagent stays locked; `alwaysUnlocked` packs are
  visible everywhere; the single-tool switch gates ungrouped unlocks; disabling
  the mode lifts every mask.

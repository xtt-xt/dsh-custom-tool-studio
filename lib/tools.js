/**
 * Tool definitions for the custom tool studio.
 *
 * Three kinds live here:
 *  - `buildToolDefinition()` — one plain `ToolDefinition` per stored record,
 *    handed straight to `ctx.tools.register()` (no `@deepseek-ai/dsh-tools`
 *    import: the registry accepts raw JSON Schema definitions).
 *  - `buildManageTool()` — the single agent-facing management tool that
 *    creates / lists / updates / deletes / tests custom tools. It shares every
 *    operation with the Web page, so both callers exercise one code path.
 *  - `buildUnlockTool()` — the per-conversation unlock tool that reveals one
 *    pack (or one ungrouped tool) by name. It only changes the agent's visible
 *    tool set; the tools themselves stay globally registered.
 */

/** Name of the agent-facing management tool. */
export const MANAGE_TOOL_NAME = 'custom_tool_manage'

/** Name of the per-conversation unlock tool. */
export const UNLOCK_TOOL_NAME = 'custom_tool_unlock'

/** Output schema shared by every generated custom tool. */
const CUSTOM_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'content', 'stdout', 'stderr', 'durationMs', 'error'],
  properties: {
    ok: { type: 'boolean', description: '脚本是否成功返回结果' },
    content: { type: 'string', description: '结果 JSON（成功）或错误信息（失败）' },
    stdout: { type: 'string', description: '脚本执行期间的标准输出' },
    stderr: { type: 'string', description: '脚本执行期间的标准错误' },
    durationMs: { type: 'number', description: '耗时（毫秒）' },
    error: { type: 'string', description: '失败原因；成功时为空字符串' },
  },
}

/** Output schema of the management tool. */
const MANAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean', description: '操作是否成功' },
    summary: { type: 'string', description: '给人看的结果摘要（含工具清单或错误原因）' },
  },
}

/** Parameters of the management tool. */
const MANAGE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [
        'list',
        'get',
        'create',
        'update',
        'delete',
        'set_enabled',
        'test',
        'pack_list',
        'pack_get',
        'pack_create',
        'pack_update',
        'pack_delete',
        'pack_set_enabled',
      ],
      description:
        'list=列出全部自定义工具；get=看某个工具的完整定义；create=新建；update=修改；delete=删除；set_enabled=启用/停用；test=用给定参数试运行一次。'
        + 'pack_list=列出工具包；pack_get=看某个工具包的成员；pack_create=新建工具包；pack_update=改工具包名称/描述/成员/始终解锁；pack_delete=删除工具包（工具保留）；pack_set_enabled=一键启停整个工具包。',
    },
    name: {
      type: 'string',
      description: '工具名（小写字母/数字/下划线，2–48 字符）。create 必填；其余工具类 action 用来定位工具。pack_create 时是工具包名称；pack_update 时是工具包的新名称（配合 pack 使用）。',
    },
    title: { type: 'string', description: '给人看的标题（可选，默认同 name）。' },
    description: {
      type: 'string',
      description: '给模型看的说明：这个工具做什么、什么时候该用它。create 必填。工具包 action 里是工具包的描述。',
    },
    parameters: {
      type: 'object',
      additionalProperties: true,
      description: '参数 JSON Schema 对象，例如 {"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}。省略则无参数。',
    },
    code: {
      type: 'string',
      description: 'Python 源码，必须定义 def run(args): ... 并返回可 JSON 序列化的值。create 必填。',
    },
    dangerous: {
      type: 'boolean',
      description: '标记为危险工具：每次执行前都要走 DSH 内置审批（与内置自动审查兼容）。',
    },
    enabled: {
      type: 'boolean',
      description: '是否启用。停用的工具不会出现在工具列表里。默认 true。',
    },
    pack: {
      type: 'string',
      description: '工具包名称或 id。定位：pack_get / pack_update / pack_delete / pack_set_enabled 用它指定工具包；归属：create / update 用它把该工具放进这个工具包，传空字符串表示移出工具包。',
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: '工具包成员（工具名数组）。pack_create 可选；pack_update 给了就整体替换成员（没列出的工具会移出该包，但工具本身保留）。',
    },
    alwaysUnlocked: {
      type: 'boolean',
      description: '工具包是否始终解锁：true 表示任何对话都无需 custom_tool_unlock 即可见；仅在解锁模式开启时有意义。pack_create / pack_update 可用。',
    },
    args: {
      type: 'object',
      additionalProperties: true,
      description: '仅 test 使用：传给 run(args) 的参数对象。',
    },
  },
}

/** Short one-line summary of one record. */
function describeRecord(record, packName, unlockHint) {
  const flags = []
  flags.push(record.enabled === false ? '已停用' : '已启用')
  if (record.dangerous === true) flags.push('危险·执行需审批')
  if (typeof packName === 'string' && packName !== '') flags.push(`工具包 ${packName}`)
  if (typeof unlockHint === 'string' && unlockHint !== '') flags.push(unlockHint)
  return `- ${record.name}${record.title && record.title !== record.name ? `（${record.title}）` : ''} [${flags.join(' / ')}]
  ${record.description}`
}

/** Detail block for one record. */
function detailRecord(record, packName) {
  const lines = [
    `name: ${record.name}`,
    `title: ${record.title}`,
    `enabled: ${record.enabled !== false}`,
    `dangerous: ${record.dangerous === true}`,
    `pack: ${typeof packName === 'string' && packName !== '' ? packName : '（未分组）'}`,
    `description: ${record.description}`,
    `parameters: ${JSON.stringify(record.parameters ?? {})}`,
    'code:',
    '```python',
    record.code ?? '',
    '```',
  ]
  return lines.join('\n')
}

/** Detail block for one pack. */
function detailPack(pack) {
  const members = Array.isArray(pack.tools) ? pack.tools : []
  const lines = [
    `name: ${pack.name}`,
    `id: ${pack.id}`,
    `description: ${pack.description === '' ? '（无描述）' : pack.description}`,
    `alwaysUnlocked: ${pack.alwaysUnlocked === true}`,
    `tools: ${pack.toolCount ?? members.length} 个（启用 ${pack.enabledCount ?? 0} 个）`,
    members.length > 0 ? members.map((member) => `  - ${member}`).join('\n') : '  （空工具包）',
    '注意：工具包只做分组与批量开关，工具仍然各自独立注册到 DSH。',
    pack.alwaysUnlocked === true
      ? '始终解锁：任何对话都无需 custom_tool_unlock 即可看到包内工具。'
      : '未始终解锁：解锁模式下需要 AI 用 custom_tool_unlock 解锁，或把本包设为始终解锁。',
  ]
  return lines.join('\n')
}

/** One-line summary of one pack. */
function describePack(pack) {
  const members = Array.isArray(pack.tools) ? pack.tools : []
  const head = `- ${pack.name} [${pack.toolCount ?? members.length} 个工具 / 启用 ${pack.enabledCount ?? 0}${pack.alwaysUnlocked === true ? ' / 始终解锁' : ''}]`
  const body = pack.description === '' || pack.description === undefined ? '' : `\n  ${pack.description}`
  const list = members.length > 0 ? `\n  成员：${members.join(', ')}` : '\n  （空）'
  return `${head}${body}${list}`
}

/**
 * Build the plain tool definition for one stored record.
 * @param {object} record stored tool record.
 * @param {(record: object, args: unknown, options: object) => Promise<object>} run executor.
 * @returns {object} a `ToolDefinition` accepted by `ctx.tools.register()`.
 */
export function buildToolDefinition(record, run) {
  const toolName = record.name
  return {
    name: toolName,
    description: record.description,
    parameters: record.parameters,
    output: {
      schema: CUSTOM_OUTPUT_SCHEMA,
      render(_args, value) {
        const blocks = [{ type: 'text', text: typeof value?.content === 'string' ? value.content : '' }]
        if (typeof value?.stdout === 'string' && value.stdout.trim() !== '') {
          blocks.push({ type: 'text', text: `stdout:\n${value.stdout.trim()}` })
        }
        if (typeof value?.stderr === 'string' && value.stderr.trim() !== '') {
          blocks.push({ type: 'text', text: `stderr:\n${value.stderr.trim()}` })
        }
        return blocks
      },
    },
    presentCall() {
      return {
        card: 'terminal',
        title: `运行自定义工具 ${toolName}`,
        description: record.title && record.title !== toolName ? record.title : undefined,
      }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const outcome = await run(record, args ?? {}, { signal: exec?.signal })
      return {
        ok: outcome?.ok === true,
        content: typeof outcome?.content === 'string' ? outcome.content : '',
        stdout: typeof outcome?.stdout === 'string' ? outcome.stdout : '',
        stderr: typeof outcome?.stderr === 'string' ? outcome.stderr : '',
        durationMs: Number.isFinite(outcome?.durationMs) ? outcome.durationMs : 0,
        error: typeof outcome?.error === 'string' ? outcome.error : '',
      }
    },
  }
}

/**
 * Build the agent-facing management tool.
 * @param {{
 *   list: () => object[],
 *   findByName: (name: string) => object | undefined,
 *   create: (input: unknown) => object,
 *   update: (id: string, patch: unknown) => object,
 *   removeRecord: (id: string) => object,
 *   setEnabled: (id: string, enabled: boolean) => object,
 *   runRecord: (record: object, args: unknown, options: object) => Promise<object>,
 * }} engine shared operations (the same ones the Web page calls).
 * @returns {object} a `ToolDefinition` accepted by `ctx.tools.register()`.
 */
export function buildManageTool(engine) {
  const fail = (message) => ({ ok: false, summary: `❌ ${message}` })

  const resolve = (args) => {
    const name = typeof args?.name === 'string' ? args.name.trim() : ''
    if (name === '') throw new Error('缺少 name：请给出要操作的工具名')
    const record = engine.findByName(name)
    if (record === undefined) throw new Error(`找不到工具 "${name}"。先用 action="list" 看看现有的工具名`)
    return record
  }

  /** Display name of the pack a record belongs to ('' when ungrouped). */
  const packOf = (record) => {
    const packId = typeof record?.packId === 'string' ? record.packId : ''
    if (packId === '') return ''
    const packs = typeof engine.listPacks === 'function' ? engine.listPacks() : []
    const pack = packs.find((entry) => entry.id === packId)
    return pack === undefined ? '' : pack.name
  }

  /** Resolve the `pack` locator (falling back to `name` for pack repairs). */
  const resolvePack = (args) => {
    const explicit = typeof args?.pack === 'string' ? args.pack.trim() : ''
    const fallback = typeof args?.name === 'string' ? args.name.trim() : ''
    const locator = explicit !== '' ? explicit : fallback
    if (locator === '') throw new Error('缺少 pack：请给出工具包名称（先用 action="pack_list" 看看有哪些工具包）')
    const pack = engine.getPack(locator)
    if (pack === undefined) throw new Error(`找不到工具包 "${locator}"。先用 action="pack_list" 看看现有的工具包名`)
    return pack
  }

  /** Current unlock view for the calling agent (null when unavailable). */
  const viewFor = (exec) => {
    if (typeof engine.unlockView !== 'function') return null
    try {
      return engine.unlockView(exec?.agent) ?? null
    } catch {
      return null
    }
  }

  /** Short ungrouped-status flag for the list. */
  const ungroupedHint = (record, view) => {
    if (view === null || view?.enabled !== true) return ''
    const packId = typeof record?.packId === 'string' ? record.packId : ''
    if (packId !== '') return ''
    const entry = Array.isArray(view?.ungrouped?.tools)
      ? view.ungrouped.tools.find((tool) => tool.id === record.id)
      : undefined
    if (entry?.unlocked === true) return '未分组·已单独解锁'
    return view?.allowUngroupedUnlock === true ? '未分组·可单独解锁' : '未分组·需放入工具包'
  }

  /** One sentence about whether the record is visible in this conversation. */
  const visibilityNote = (record, view) => {
    if (view === null || view?.enabled !== true) return ''
    const hidden = Array.isArray(view.hiddenTools) ? view.hiddenTools : []
    if (!hidden.includes(record.name)) return '当前对话可见。'
    const packId = typeof record.packId === 'string' ? record.packId : ''
    if (packId === '') {
      return view.allowUngroupedUnlock === true
        ? '当前对话不可见：用 custom_tool_unlock 的 tool 参数单独解锁它。'
        : '当前对话不可见：它未分组且单独解锁未开启，请放进工具包或开启设置。'
    }
    const pack = Array.isArray(view.packs) ? view.packs.find((entry) => entry.id === packId) : undefined
    return pack === undefined
      ? '当前对话不可见：请先解锁它所属的工具包。'
      : `当前对话不可见：需要解锁工具包 "${pack.name}"。`
  }

  /** Names of packs visible for this view (always-unlocked or session-unlocked). */
  const unlockedPackNames = (view) => {
    const packs = Array.isArray(view?.packs) ? view.packs : []
    return packs
      .filter((pack) => pack.alwaysUnlocked === true || pack.unlocked === true)
      .map((pack) => pack.name)
  }

  return {
    name: MANAGE_TOOL_NAME,
    description: [
      '创建、查看、修改、删除、启停或试运行 DSH 的「自定义工具」。自定义工具是用户 Python 脚本，保存后会立刻注册成真正的 DSH 工具，模型随后可以直接调用它。',
      '也管理「工具包」：把若干工具归到同一个有名称、有描述的分组里，方便一键启停；工具包只是分组，包里的工具仍然各自独立注册，不改变工具本身的定义。',
      'Use when the user asks to create a custom tool, list custom tools, edit their Python code or parameters, delete one, mark one dangerous, or group tools into a pack / toggle a pack.',
      'Python 约定：脚本必须定义 def run(args): ...，args 是参数对象，返回值必须可 JSON 序列化；脚本的 print() 会作为 stdout 展示。参数由 parameters（JSON Schema 对象）描述。',
      'dangerous=true 的工具每次执行前都会走 DSH 内置审批（用户在当前会话里看到审批提示）；这与内置的自动审查兼容，不需要额外配置。',
      '用户还可以在页面的「设置」里对 create / update / delete 分别开启审批（对工具和工具包同样生效）；被拦下时你会收到拒绝结果，不要绕过它，把结果如实告诉用户。',
      '工具包的一键启停只改工具的启用标记（等价于逐个 set_enabled），不改代码、不改注册方式。',
      '解锁模式开启时，每个对话初始只看到本工具和 custom_tool_unlock；包里的工具需要先解锁才可见。未分组工具能否用 tool 参数单独解锁，取决于页面「设置」里的「允许单独解锁未分组工具」。',
      '新建后无需重启：工具在下一轮请求即可见。建议创建后立即用 action="test" 传一组参数验证脚本。',
    ].join('\n'),
    parameters: MANAGE_PARAMETERS,
    output: {
      schema: MANAGE_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.summary === 'string' ? value.summary : '' }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : ''
      try {
        switch (action) {
          case 'list': {
            const view = viewFor(exec)
            const records = engine.list()
            const modeLine = view?.enabled === true
              ? `\n\n解锁模式：已开启（每个对话单独解锁）。当前对话可见的工具包：${unlockedPackNames(view).join('、') || '无'}；未分组单独解锁：${view.allowUngroupedUnlock === true ? '开启' : '关闭'}。未解锁工具对模型不可见，用 custom_tool_unlock 解锁。`
              : ''
            if (records.length === 0) {
              return { ok: true, summary: `当前还没有自定义工具。用 action="create" 建一个，name/description/code 是必填。${modeLine}` }
            }
            const packs = typeof engine.listPacks === 'function' ? engine.listPacks() : []
            const packLine = packs.length > 0 ? `\n\n工具包（${packs.length}）：${packs.map((pack) => pack.name).join('、')}` : ''
            return {
              ok: true,
              summary: `共 ${records.length} 个自定义工具：\n\n${records.map((record) => describeRecord(record, packOf(record), ungroupedHint(record, view))).join('\n')}${packLine}${modeLine}`,
            }
          }
          case 'get': {
            const record = resolve(args)
            const view = viewFor(exec)
            return { ok: true, summary: `${detailRecord(record, packOf(record))}${view?.enabled === true ? `\n\n${visibilityNote(record, view)}` : ''}` }
          }
          case 'create': {
            const record = engine.create({
              name: args?.name,
              title: args?.title,
              description: args?.description,
              parameters: args?.parameters,
              code: args?.code,
              dangerous: args?.dangerous,
              enabled: args?.enabled,
              pack: args?.pack,
            })
            const note = visibilityNote(record, viewFor(exec))
            return {
              ok: true,
              summary: `已创建工具 "${record.name}" 并注册进 DSH${record.dangerous ? '（危险工具，执行需审批）' : ''}。${note === '' ? '' : `\n\n${note}`}\n\n${detailRecord(record, packOf(record))}`,
            }
          }
          case 'update': {
            const record = resolve(args)
            const patch = {}
            for (const key of ['name', 'title', 'description', 'parameters', 'code', 'dangerous', 'enabled']) {
              if (args?.[key] !== undefined) patch[key] = args[key]
            }
            if (args?.pack !== undefined) patch.pack = args.pack
            if (Object.keys(patch).length === 0) return fail('没有要修改的字段（title/description/parameters/code/dangerous/enabled/pack 至少给一个）')
            const updated = engine.update(record.id, patch)
            const note = visibilityNote(updated, viewFor(exec))
            return { ok: true, summary: `已更新工具 "${updated.name}"。${note === '' ? '' : `\n\n${note}`}\n\n${detailRecord(updated, packOf(updated))}` }
          }
          case 'delete': {
            const record = resolve(args)
            engine.removeRecord(record.id)
            return { ok: true, summary: `已删除工具 "${record.name}"，它已从 DSH 工具列表中移除。` }
          }
          case 'set_enabled': {
            const record = resolve(args)
            if (typeof args?.enabled !== 'boolean') return fail('set_enabled 需要 enabled=true 或 false')
            const updated = engine.setEnabled(record.id, args.enabled)
            const note = updated.enabled === false ? '' : visibilityNote(updated, viewFor(exec))
            return {
              ok: true,
              summary: `工具 "${updated.name}" 现在${updated.enabled ? '已启用（下一轮请求可见）' : '已停用（已从工具列表移除）'}。${note === '' ? '' : `\n\n${note}`}`,
            }
          }
          case 'test': {
            const record = resolve(args)
            const payload = args?.args !== null && typeof args?.args === 'object' ? args.args : {}
            const outcome = await engine.runRecord(record, payload, {})
            const lines = [
              `${outcome.ok ? '✅ 运行成功' : '❌ 运行失败'}：${record.name}（${outcome.durationMs} ms）`,
              '',
              outcome.ok ? outcome.content : outcome.error || outcome.content,
            ]
            if (outcome.stdout && outcome.stdout.trim() !== '') lines.push('', `stdout:\n${outcome.stdout.trim()}`)
            if (!outcome.ok && outcome.stderr && outcome.stderr.trim() !== '') lines.push('', `stderr:\n${outcome.stderr.trim()}`)
            return { ok: outcome.ok === true, summary: lines.join('\n') }
          }
          case 'pack_list': {
            const packs = engine.listPacks()
            if (packs.length === 0) {
              return {
                ok: true,
                summary: '当前还没有工具包。用 action="pack_create" 建一个：name 必填（工具包名称），description 是它的描述，tools 是要放进去的工具名数组（可省略，之后用 pack_update 加）。',
              }
            }
            return { ok: true, summary: `共 ${packs.length} 个工具包：\n\n${packs.map(describePack).join('\n')}` }
          }
          case 'pack_get': {
            return { ok: true, summary: detailPack(resolvePack(args)) }
          }
          case 'pack_create': {
            const pack = engine.createPack({
              name: args?.name,
              description: args?.description,
              tools: args?.tools,
              alwaysUnlocked: args?.alwaysUnlocked,
            })
            return {
              ok: true,
              summary: `已创建工具包 "${pack.name}"（${pack.toolCount} 个工具${pack.alwaysUnlocked === true ? '，始终解锁' : ''}）。工具仍然各自独立注册。\n\n${detailPack(pack)}`,
            }
          }
          case 'pack_update': {
            const pack = resolvePack(args)
            const patch = {}
            // `name` renames only when `pack` located the pack; otherwise `name`
            // is merely the locator and the name stays as it is.
            if (args?.pack !== undefined && args.name !== undefined) patch.name = args.name
            if (args?.description !== undefined) patch.description = args.description
            if (args?.tools !== undefined) patch.tools = args.tools
            if (args?.alwaysUnlocked !== undefined) patch.alwaysUnlocked = args.alwaysUnlocked === true
            if (Object.keys(patch).length === 0) {
              return fail('没有要修改的内容（description / tools / alwaysUnlocked 至少给一个；改名要同时给 pack 和 name）')
            }
            const updated = engine.updatePack(pack.id, patch)
            return { ok: true, summary: `已更新工具包 "${updated.name}"。\n\n${detailPack(updated)}` }
          }
          case 'pack_delete': {
            const pack = resolvePack(args)
            const outcome = engine.removePack(pack.id)
            const names = Array.isArray(outcome.tools) ? outcome.tools.map((record) => record.name) : []
            const kept = names.length > 0
              ? `包里的 ${names.length} 个工具（${names.join('、')}）被保留，变为未分组。`
              : '包里没有工具。'
            return { ok: true, summary: `已删除工具包 "${pack.name}"。${kept}工具本身没有被删除，注册方式与启用状态都没变。` }
          }
          case 'pack_set_enabled': {
            if (typeof args?.enabled !== 'boolean') return fail('pack_set_enabled 需要 enabled=true 或 false')
            const pack = resolvePack(args)
            const outcome = engine.setPackEnabled(pack.id, args.enabled)
            const count = Array.isArray(outcome.tools) ? outcome.tools.length : 0
            const state = args.enabled ? '已启用（下一轮请求可见）' : '已停用（已从工具列表移除）'
            return {
              ok: true,
              summary: `工具包 "${outcome.pack.name}" 已${args.enabled ? '整体启用' : '整体停用'}：${count} 个工具现在${state}。每个工具仍然是独立注册的。`,
            }
          }
          default:
            return fail(
              `未知 action "${action}"，可用：list / get / create / update / delete / set_enabled / test / pack_list / pack_get / pack_create / pack_update / pack_delete / pack_set_enabled`,
            )
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** Parameters of the unlock tool. */
const UNLOCK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'unlock', 'lock'],
      description: 'list=查看所有工具包/未分组工具及解锁状态；unlock=解锁；lock=重新锁定。',
    },
    pack: {
      type: 'string',
      description: '工具包名称或 id（与 tool 二选一）。unlock/lock 时用来指定整个工具包。',
    },
    tool: {
      type: 'string',
      description: '未分组工具名（与 pack 二选一）。只有在设置开启「允许单独解锁未分组工具」时才能用；属于某个包的工具必须按包解锁。',
    },
  },
}

/** One readable status block for `action="list"`. */
function describeUnlockList(view) {
  const lines = []
  if (view.enabled !== true) {
    lines.push('解锁模式：未开启（所有已启用的自定义工具都直接可见；下面的解锁状态暂不生效）。')
  } else {
    lines.push('解锁模式：已开启（每个对话单独解锁，解锁只影响当前对话）。')
  }
  lines.push(`基线工具：${Array.isArray(view.baseline) ? view.baseline.join('、') : ''}`)

  lines.push('')
  const packs = Array.isArray(view.packs) ? view.packs : []
  if (packs.length === 0) {
    lines.push('工具包：无。')
  } else {
    lines.push(`工具包（${packs.length}）：`)
    for (const pack of packs) {
      const status = pack.alwaysUnlocked === true
        ? '始终解锁'
        : pack.unlocked === true ? '当前对话已解锁' : '未解锁'
      const members = Array.isArray(pack.tools) ? pack.tools : []
      lines.push(`- ${pack.name} [${pack.toolCount} 个工具 / 启用 ${pack.enabledCount}] · ${status}`)
      lines.push(members.length > 0 ? `  成员：${members.join(', ')}` : '  （空工具包）')
    }
  }

  lines.push('')
  const ungrouped = view.ungrouped ?? { count: 0, names: [], tools: [], allowUnlock: false }
  if (ungrouped.count === 0) {
    lines.push('未分组工具：无。')
  } else {
    lines.push(`未分组工具（${ungrouped.count}）· ${ungrouped.allowUnlock === true ? '可单独解锁' : '不可单独解锁（设置已关闭）'}：`)
    for (const tool of Array.isArray(ungrouped.tools) ? ungrouped.tools : []) {
      const status = tool.enabled === false
        ? '已停用'
        : tool.unlocked === true ? '当前对话已解锁' : '未解锁'
      lines.push(`- ${tool.name} · ${status}`)
    }
    if (ungrouped.allowUnlock !== true) {
      lines.push('提示：把工具放进工具包后按包解锁，或在页面「设置」里开启「允许单独解锁未分组工具」。')
    }
  }

  if (view.enabled === true) {
    lines.push('', '用法：action="unlock" + pack=... 解锁整个包；action="unlock" + tool=... 单独解锁未分组工具；action="lock" 反向收起。')
  }
  return lines.join('\n')
}

/**
 * Build the per-conversation unlock tool.
 * @param {object} access access controller.
 * @param {(exec: object) => object | undefined} resolveAgent caller-agent resolver.
 * @returns {object} a `ToolDefinition` accepted by `ctx.tools.register()`.
 */
export function buildUnlockTool(access, resolveAgent) {
  const fail = (message) => ({ ok: false, summary: `❌ ${message}` })
  const warningText = (warning) => (typeof warning === 'string' && warning !== ''
    ? `\n\n⚠️ 解锁状态未能写入 unlocks.json（${warning}），本次会话内仍然生效，重启后会丢失。`
    : '')

  /** Resolve `pack` / `tool` as exactly one explicit target. */
  const targetOf = (args) => {
    const pack = typeof args?.pack === 'string' ? args.pack.trim() : ''
    const tool = typeof args?.tool === 'string' ? args.tool.trim() : ''
    if (pack !== '' && tool !== '') {
      throw new Error('pack 与 tool 只能给一个：解锁整个工具包用 pack，单独解锁未分组工具用 tool')
    }
    if (pack === '' && tool === '') {
      throw new Error('缺少目标：请给 pack（工具包）或 tool（未分组工具名）')
    }
    return pack !== '' ? { kind: 'pack', ref: pack } : { kind: 'tool', ref: tool }
  }

  return {
    name: UNLOCK_TOOL_NAME,
    description: [
      '按对话解锁「自定义工具包」或单个未分组工具，让包里的工具对当前对话可见、可调用。',
      '解锁模式开启时，每个对话初始只看到 custom_tool_manage 和本工具；不同对话互不影响，解锁只影响当前对话。',
      'action="list" 查看所有工具包与未分组工具及其解锁状态；action="unlock" 解锁；action="lock" 重新锁定。',
      'unlock/lock 只接受 pack 或 tool 其中一个：pack=工具包名称或 id；tool=未分组工具名（需要页面「设置」开启「允许单独解锁未分组工具」；属于某个包的工具必须按包解锁）。',
      '「始终解锁」的工具包无需解锁；危险工具执行仍逐次走 DSH 内置审批。',
      'Use when the current conversation needs tools from a custom tool pack that are not visible yet.',
    ].join('\n'),
    parameters: UNLOCK_PARAMETERS,
    output: {
      schema: MANAGE_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.summary === 'string' ? value.summary : '' }]
      },
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      const action = typeof args?.action === 'string' ? args.action : ''
      if (action === 'list') return { card: 'generic', title: '查看可解锁的工具包' }
      const pack = typeof args?.pack === 'string' ? args.pack.trim() : ''
      const tool = typeof args?.tool === 'string' ? args.tool.trim() : ''
      const subject = pack !== '' ? `工具包 ${pack}` : tool !== '' ? `工具 ${tool}` : ''
      return { card: 'generic', title: `${action === 'lock' ? '锁定' : '解锁'}${subject === '' ? '' : ` ${subject}`}` }
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : ''
      try {
        if (access === null || typeof access !== 'object' || typeof access.statusFor !== 'function') {
          return fail('解锁功能不可用：宿主没有加载 agent 服务或可见性控制初始化失败，请查看 DSH 日志')
        }
        const agent = typeof resolveAgent === 'function' ? resolveAgent(exec) : exec?.agent
        const view = access.statusFor(agent)

        switch (action) {
          case 'list':
            return { ok: true, summary: describeUnlockList(view) }
          case 'unlock': {
            const goal = targetOf(args)
            if (goal.kind === 'pack') {
              const outcome = access.unlockPack(agent, goal.ref)
              if (outcome.always === true) {
                return { ok: true, summary: `工具包 "${outcome.pack.name}" 已设为始终解锁，任何对话都无需解锁。` }
              }
              if (outcome.already === true) {
                return { ok: true, summary: `工具包 "${outcome.pack.name}" 在当前对话已经是解锁状态。` }
              }
              const names = Array.isArray(outcome.names) ? outcome.names : []
              const shown = names.length > 0 ? `现在可见：${names.join('、')}` : '（包内没有启用的工具；解锁状态已记录。）'
              return {
                ok: true,
                summary: `已解锁工具包 "${outcome.pack.name}"：${names.length} 个启用工具现在对当前对话可见（下一轮请求生效）。\n\n${shown}${warningText(outcome.warning)}`,
              }
            }
            const outcome = access.unlockTool(agent, goal.ref)
            if (outcome.already === true) {
              return { ok: true, summary: `未分组工具 "${outcome.record.name}" 在当前对话已经单独解锁。` }
            }
            return {
              ok: true,
              summary: `已单独解锁未分组工具 "${outcome.record.name}"（当前对话，下一轮请求生效）。${warningText(outcome.warning)}`,
            }
          }
          case 'lock': {
            const goal = targetOf(args)
            if (goal.kind === 'pack') {
              const outcome = access.lockPack(agent, goal.ref)
              if (outcome.already === true) {
                return { ok: true, summary: `工具包 "${outcome.pack.name}" 在当前对话本来就没有解锁。` }
              }
              return {
                ok: true,
                summary: `已重新锁定工具包 "${outcome.pack.name}"：其工具从当前对话隐藏（下一轮请求生效）。${warningText(outcome.warning)}`,
              }
            }
            const outcome = access.lockTool(agent, goal.ref)
            if (outcome.already === true) {
              return { ok: true, summary: `未分组工具 "${outcome.record.name}" 在当前对话本来就没有单独解锁。` }
            }
            return {
              ok: true,
              summary: `已锁定未分组工具 "${outcome.record.name}"（当前对话，下一轮请求生效）。${warningText(outcome.warning)}`,
            }
          }
          default:
            return fail(`未知 action "${action}"，可用：list / unlock / lock`)
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

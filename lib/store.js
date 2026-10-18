/**
 * Persistent store for custom tool records and tool packs.
 *
 * Layout under `<DSH_HOME>/custom-tools`:
 *   tools.json          — one record per tool; a record's `packId` names its pack
 *   packs.json          — tool packs: a display name, a description, no code
 *   settings.json       — approval switches for the management operations
 *   scripts/<name>.py   — a mirror of each record's code, for direct editing
 *   runs/<id>/          — per-execution scratch directory (pruned)
 *
 * A pack is only a grouping: membership lives on the tool (`packId`), so
 * renaming or deleting a pack never touches a tool's code, parameters, or
 * registration. Tools keep registering one by one, exactly as before.
 *
 * Everything here is synchronous on purpose: the files are tiny and the host
 * reads them on every list/registration pass, so an async API would only add
 * races between the UI and the registry sync.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Model-facing tool-name shape: lowercase, starts with a letter, 2–48 chars. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/

/** Names the tool registry keeps for itself. */
const RESERVED_NAMES = new Set(['run_code'])

const MAX_CODE = 200_000
const MAX_DESCRIPTION = 4_000
const MAX_TITLE = 200

/**
 * Approval switches for the management operations.
 * Deleting is destructive, so it asks by default; creating and editing do not.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  approveCreate: false,
  approveUpdate: false,
  approveDelete: true,
})

/** Settings keys that may be written, in display order. */
const SETTINGS_KEYS = ['approveCreate', 'approveUpdate', 'approveDelete']

/** Coerce an arbitrary value into the settings shape (defaults for anything odd). */
export function normalizeSettings(value) {
  const source = isPlainObject(value) ? value : {}
  const out = {}
  for (const key of SETTINGS_KEYS) {
    out[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key]
  }
  return out
}

/** Tool-pack limits (a pack is a label, not a tool: no code, no parameters). */
const MAX_PACK_NAME = 48
const MAX_PACK_DESCRIPTION = 500

/**
 * Validate a pack display name. Packs are human labels, so any non-control
 * text is fine — only emptiness, length, and control characters are rejected.
 * @param {unknown} name candidate name.
 * @returns {string | undefined} a Chinese error message, or undefined when valid.
 */
export function validatePackName(name) {
  if (typeof name !== 'string' || name.trim() === '') return '工具包名称不能为空'
  const trimmed = name.trim()
  if (trimmed.length > MAX_PACK_NAME) return `工具包名称过长（上限 ${MAX_PACK_NAME} 字符）`
  // Control characters would break the one-line list header.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '工具包名称不能包含换行或控制字符'
  return undefined
}

/**
 * Validate and normalize pack author input.
 * @param {unknown} input raw input (UI body or agent-tool arguments).
 * @returns {{ name: string, description: string }} stored pack fields.
 * @throws {Error} with a Chinese, user-displayable message.
 */
export function normalizePackInput(input) {
  const src = isPlainObject(input) ? input : {}
  const name = typeof src.name === 'string' ? src.name.trim() : ''
  const nameError = validatePackName(name)
  if (nameError !== undefined) throw new Error(nameError)
  const description = typeof src.description === 'string' ? src.description.trim() : ''
  if (description.length > MAX_PACK_DESCRIPTION) throw new Error(`工具包描述过长（上限 ${MAX_PACK_DESCRIPTION} 字符）`)
  return { name, description }
}

/** Plain-object predicate (JSON objects only, never arrays). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep clone through JSON (records are lossless JSON by construction). */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Validate a model-facing tool name.
 * @param {unknown} name candidate name.
 * @returns {string | undefined} a Chinese error message, or undefined when valid.
 */
export function validateToolName(name) {
  if (typeof name !== 'string' || name.trim() === '') return '工具名不能为空'
  if (!TOOL_NAME_RE.test(name)) {
    return '工具名必须以小写字母开头，只含小写字母、数字、下划线，长度 2–48'
  }
  if (RESERVED_NAMES.has(name)) return `"${name}" 是 DSH 保留名，不能用作工具名`
  return undefined
}

/**
 * Coerce any author-supplied value into a root-object JSON Schema node.
 * Garbage never throws: the caller always gets a usable schema.
 * @param {unknown} parameters raw parameters (object, JSON text, or nothing).
 * @returns {Record<string, unknown>} object-rooted JSON Schema.
 */
export function normalizeParameters(parameters) {
  let value = parameters
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return { type: 'object', properties: {}, additionalProperties: true }
    try {
      value = JSON.parse(text)
    } catch {
      return { type: 'object', properties: {}, additionalProperties: true }
    }
  }
  if (!isPlainObject(value)) return { type: 'object', properties: {}, additionalProperties: true }
  // A composition or reference is already a complete schema.
  if (value.$ref !== undefined || value.oneOf !== undefined || value.anyOf !== undefined || value.allOf !== undefined) {
    return value
  }
  if (value.type === 'object' || value.properties !== undefined) {
    const node = { ...value, type: 'object' }
    if (!isPlainObject(node.properties)) node.properties = {}
    if (Array.isArray(node.required)) node.required = node.required.filter((key) => typeof key === 'string')
    else delete node.required
    return node
  }
  // A bare non-object schema: accept it as one positional argument instead of
  // rejecting the author's work.
  return {
    type: 'object',
    properties: { value },
    required: ['value'],
    additionalProperties: false,
  }
}

/** Whether the python source looks like it defines the `run` entry point. */
function definesRun(code) {
  return /(^|[\r\n])\s*(def\s+run\s*\(|run\s*=)/.test(code)
}

/**
 * Validate and normalize author input into stored record fields.
 * @param {unknown} input raw input (UI body or agent-tool arguments).
 * @param {{ requireCode?: boolean }} [opts] `requireCode: false` keeps an
 *   existing code string when the caller patches metadata only.
 * @returns {object} `{ name, title, description, parameters, code, dangerous, enabled }`
 * @throws {Error} with a Chinese, user-displayable message.
 */
export function normalizeInput(input, opts = {}) {
  const src = isPlainObject(input) ? input : {}

  const rawName = typeof src.name === 'string' ? src.name.trim() : ''
  const name = rawName.toLowerCase()
  const nameError = validateToolName(name)
  if (nameError !== undefined) throw new Error(nameError)

  const description = typeof src.description === 'string' ? src.description.trim() : ''
  if (description === '') throw new Error('描述不能为空：它决定模型在什么时候选择这个工具')
  if (description.length > MAX_DESCRIPTION) throw new Error(`描述过长（上限 ${MAX_DESCRIPTION} 字符）`)

  let title = typeof src.title === 'string' ? src.title.trim() : ''
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE)
  if (title === '') title = name

  const code = typeof src.code === 'string' ? src.code : ''
  if (opts.requireCode !== false) {
    if (code.trim() === '') throw new Error('Python 代码不能为空')
    if (code.length > MAX_CODE) throw new Error(`Python 代码过长（上限 ${MAX_CODE} 字符）`)
    if (!definesRun(code)) throw new Error('Python 代码必须定义入口 run(args)，例如：def run(args): return {...}')
  }

  return {
    name,
    title,
    description,
    parameters: normalizeParameters(src.parameters),
    code,
    dangerous: src.dangerous === true,
    enabled: src.enabled !== false,
  }
}

/**
 * Open (or create) the custom-tool store rooted at `rootDir`.
 * @param {string} rootDir absolute directory that owns tools.json.
 * @returns {{
 *   paths: { root: string, store: string, packs: string, scripts: string, runs: string },
 *   list: () => object[],
 *   get: (id: string) => object | undefined,
 *   findByName: (name: string) => object | undefined,
 *   create: (input: unknown) => object,
 *   update: (id: string, patch: unknown) => object,
 *   remove: (id: string) => object,
 *   setEnabled: (id: string, enabled: boolean) => object,
 *   listPacks: () => object[],
 *   getPack: (id: string) => object | undefined,
 *   findPackByName: (ref: string) => object | undefined,
 *   createPack: (input: unknown) => object,
 *   updatePack: (id: string, patch: unknown) => object,
 *   removePack: (id: string) => object,
 *   setPackEnabled: (id: string, enabled: boolean) => { pack: object, tools: object[] },
 *   settings: () => object,
 *   saveSettings: (patch: unknown) => object,
 * }}
 */
export function createStore(rootDir) {
  const storeFile = join(rootDir, 'tools.json')
  const packsFile = join(rootDir, 'packs.json')
  const settingsFile = join(rootDir, 'settings.json')
  const scriptsDir = join(rootDir, 'scripts')
  const runsDir = join(rootDir, 'runs')

  const ensureDirs = () => {
    mkdirSync(scriptsDir, { recursive: true })
    mkdirSync(runsDir, { recursive: true })
  }

  const readState = () => {
    ensureDirs()
    if (!existsSync(storeFile)) return { version: 1, tools: [] }
    try {
      const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
      const tools = (Array.isArray(parsed?.tools) ? parsed.tools : [])
        .filter(isPlainObject)
        // Records written before packs existed simply belong to no pack.
        .map((tool) => ({ ...tool, packId: typeof tool.packId === 'string' ? tool.packId : '' }))
      return { version: 1, tools }
    } catch {
      // Keep the damaged file for the user instead of silently losing it.
      try {
        renameSync(storeFile, `${storeFile}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return { version: 1, tools: [] }
    }
  }

  /** Read the pack list; a damaged file is preserved next to the original. */
  const readPacks = () => {
    ensureDirs()
    if (!existsSync(packsFile)) return { version: 1, packs: [] }
    try {
      const parsed = JSON.parse(readFileSync(packsFile, 'utf8'))
      const packs = (Array.isArray(parsed?.packs) ? parsed.packs : []).filter(isPlainObject)
      return { version: 1, packs }
    } catch {
      try {
        renameSync(packsFile, `${packsFile}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return { version: 1, packs: [] }
    }
  }

  /** Atomic-ish JSON write shared by every file in the store. */
  const writeJsonFile = (file, value) => {
    ensureDirs()
    const text = `${JSON.stringify(value, null, 2)}\n`
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, text, 'utf8')
    try {
      renameSync(temp, file)
    } catch {
      writeFileSync(file, text, 'utf8')
      try {
        rmSync(temp, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  const writeState = (state) => writeJsonFile(storeFile, { version: 1, tools: state.tools })
  const writePacks = (state) => writeJsonFile(packsFile, { version: 1, packs: state.packs })

  const scriptPath = (name) => join(scriptsDir, `${name}.py`)

  const writeScriptMirror = (record) => {
    try {
      ensureDirs()
      writeFileSync(scriptPath(record.name), record.code, 'utf8')
    } catch {
      /* a read-only data directory must not break tool management */
    }
  }

  const removeScriptMirror = (name) => {
    try {
      rmSync(scriptPath(name), { force: true })
    } catch {
      /* ignore */
    }
  }

  const newId = () => `t_${randomBytes(6).toString('hex')}`

  /** Read the approval switches (defaults when the file is missing or damaged). */
  const readSettings = () => {
    if (!existsSync(settingsFile)) return { ...DEFAULT_SETTINGS }
    try {
      return normalizeSettings(JSON.parse(readFileSync(settingsFile, 'utf8')))
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  /** Merge a patch into the approval switches and persist the result. */
  const saveSettings = (patch) => {
    const current = readSettings()
    const source = isPlainObject(patch) ? patch : {}
    const next = { ...current }
    for (const key of SETTINGS_KEYS) {
      if (typeof source[key] === 'boolean') next[key] = source[key]
    }
    writeJsonFile(settingsFile, next)
    return { ...next }
  }

  const requireRecord = (state, id) => {
    const index = state.tools.findIndex((tool) => tool?.id === id)
    if (index < 0) throw new Error('工具不存在（可能已被删除）')
    return index
  }

  const newPackId = () => `p_${randomBytes(6).toString('hex')}`

  /**
   * Resolve an author-supplied pack reference (id or display name) to a pack id.
   * `undefined` means "not mentioned", `''`/`null` means "no pack".
   * @param {unknown} ref pack id, pack name, '' or null.
   * @returns {string | undefined} resolved pack id ('' = ungrouped).
   */
  const resolvePackId = (ref) => {
    if (ref === undefined) return undefined
    if (ref === null) return ''
    const text = typeof ref === 'string' ? ref.trim() : ''
    if (text === '') return ''
    const packs = readPacks().packs
    const wanted = text.toLowerCase()
    const match = packs.find((pack) => pack.id === text)
      ?? packs.find((pack) => typeof pack.name === 'string' && pack.name.trim().toLowerCase() === wanted)
    if (match === undefined) throw new Error(`工具包 "${text}" 不存在，请先创建或换一个名字`)
    return match.id
  }

  const list = () => clone(readState().tools)
  const listPacks = () => clone(readPacks().packs)

  /**
   * Resolve a membership list (tool names or ids) to tool ids.
   * Unknown names fail loudly: a silently-partial pack would be worse.
   * @param {unknown} refs array of tool names / ids.
   * @returns {string[]} deduplicated tool ids.
   */
  const resolveMemberIds = (refs) => {
    if (refs === null) return []
    if (!Array.isArray(refs)) throw new Error('工具包成员必须是工具名数组（tools: ["tool_a", "tool_b"]）')
    const state = readState()
    const ids = []
    for (const raw of refs) {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text === '') continue
      const wanted = text.toLowerCase()
      const match = state.tools.find((tool) => tool.id === text)
        ?? state.tools.find((tool) => String(tool.name).toLowerCase() === wanted)
      if (match === undefined) throw new Error(`工具 "${text}" 还没有创建，请先建好它再加入工具包`)
      if (!ids.includes(match.id)) ids.push(match.id)
    }
    return ids
  }

  /**
   * Replace a pack's membership with exactly `ids` (tools not listed leave the
   * pack). Only `packId` changes; code, parameters, danger, and enabled stay.
   */
  const applyMembership = (packId, ids) => {
    const state = readState()
    const wanted = new Set(ids)
    const now = new Date().toISOString()
    let changed = false
    state.tools = state.tools.map((tool) => {
      const shouldBeMember = wanted.has(tool.id)
      const isMember = tool.packId === packId
      if (shouldBeMember === isMember) return tool
      changed = true
      return { ...tool, packId: shouldBeMember ? packId : '', updatedAt: now }
    })
    if (changed) writeState(state)
  }

  return {
    paths: { root: rootDir, store: storeFile, packs: packsFile, scripts: scriptsDir, runs: runsDir },

    list,

    listPacks,

    get(id) {
      return list().find((tool) => tool.id === id)
    },

    findByName(name) {
      if (typeof name !== 'string') return undefined
      const wanted = name.trim().toLowerCase()
      return list().find((tool) => tool.name === wanted)
    },

    create(input) {
      const fields = normalizeInput(input)
      const source = isPlainObject(input) ? input : {}
      // `pack` accepts a pack id or a pack display name; omit it for no pack.
      const packId = resolvePackId(source.pack !== undefined ? source.pack : source.packId) ?? ''
      const state = readState()
      if (state.tools.some((tool) => tool.name === fields.name)) {
        throw new Error(`工具名 "${fields.name}" 已存在，请换一个名字`)
      }
      const now = new Date().toISOString()
      const record = { id: newId(), ...fields, packId, createdAt: now, updatedAt: now }
      state.tools.push(record)
      writeState(state)
      writeScriptMirror(record)
      return clone(record)
    },

    update(id, patch) {
      const state = readState()
      const index = requireRecord(state, id)
      const current = state.tools[index]
      const source = isPlainObject(patch) ? patch : {}
      const merged = { ...current }
      for (const key of ['name', 'title', 'description', 'parameters', 'code', 'dangerous', 'enabled']) {
        if (source[key] !== undefined) merged[key] = source[key]
      }
      const fields = normalizeInput(merged)
      const requestedPack = source.pack !== undefined ? source.pack : source.packId
      const packId = requestedPack === undefined ? (current.packId ?? '') : (resolvePackId(requestedPack) ?? '')
      if (fields.name !== current.name && state.tools.some((tool) => tool.id !== id && tool.name === fields.name)) {
        throw new Error(`工具名 "${fields.name}" 已存在，请换一个名字`)
      }
      const record = {
        ...current,
        ...fields,
        packId,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      }
      state.tools[index] = record
      writeState(state)
      if (fields.name !== current.name) removeScriptMirror(current.name)
      writeScriptMirror(record)
      return clone(record)
    },

    remove(id) {
      const state = readState()
      const index = requireRecord(state, id)
      const [removed] = state.tools.splice(index, 1)
      writeState(state)
      removeScriptMirror(removed.name)
      return clone(removed)
    },

    setEnabled(id, enabled) {
      const state = readState()
      const index = requireRecord(state, id)
      const record = { ...state.tools[index], enabled: enabled !== false, updatedAt: new Date().toISOString() }
      state.tools[index] = record
      writeState(state)
      return clone(record)
    },

    // #region packs

    getPack(id) {
      if (typeof id !== 'string' || id === '') return undefined
      return listPacks().find((pack) => pack.id === id)
    },

    /** Locate a pack by id or by (case-insensitive) display name. */
    findPackByName(ref) {
      if (typeof ref !== 'string' || ref.trim() === '') return undefined
      const text = ref.trim()
      const wanted = text.toLowerCase()
      const packs = listPacks()
      return packs.find((pack) => pack.id === text)
        ?? packs.find((pack) => typeof pack.name === 'string' && pack.name.trim().toLowerCase() === wanted)
    },

    /**
     * Create a pack. `tools` optionally seeds the membership with tool names.
     * A pack only groups tools: it never registers, enables, or rewrites them.
     */
    createPack(input) {
      const source = isPlainObject(input) ? input : {}
      const fields = normalizePackInput(source)
      const packs = readPacks()
      if (packs.packs.some((pack) => String(pack.name).trim().toLowerCase() === fields.name.toLowerCase())) {
        throw new Error(`工具包 "${fields.name}" 已存在，请换一个名字`)
      }
      // Validate membership before writing, so a bad name cannot leave a
      // half-built pack behind.
      const memberIds = source.tools !== undefined ? resolveMemberIds(source.tools) : null
      const now = new Date().toISOString()
      const pack = { id: newPackId(), ...fields, createdAt: now, updatedAt: now }
      packs.packs.push(pack)
      writePacks(packs)
      if (memberIds !== null) applyMembership(pack.id, memberIds)
      return clone(pack)
    },

    /** Rename / re-describe a pack; membership is replaced only when `tools` is given. */
    updatePack(id, patch) {
      const packs = readPacks()
      const index = packs.packs.findIndex((pack) => pack?.id === id)
      if (index < 0) throw new Error('工具包不存在（可能已被删除）')
      const current = packs.packs[index]
      const source = isPlainObject(patch) ? patch : {}
      const merged = { name: current.name, description: current.description }
      if (source.name !== undefined) merged.name = source.name
      if (source.description !== undefined) merged.description = source.description
      const fields = normalizePackInput(merged)
      if (packs.packs.some((pack) => pack.id !== id && String(pack.name).trim().toLowerCase() === fields.name.toLowerCase())) {
        throw new Error(`工具包 "${fields.name}" 已存在，请换一个名字`)
      }
      const memberIds = source.tools !== undefined ? resolveMemberIds(source.tools) : null
      const pack = { ...current, ...fields, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() }
      packs.packs[index] = pack
      writePacks(packs)
      if (memberIds !== null) applyMembership(pack.id, memberIds)
      return clone(pack)
    },

    /**
     * Delete a pack. Its tools are kept and become ungrouped — only the label
     * disappears. Returns the removed pack plus the tools that were detached.
     */
    removePack(id) {
      const packs = readPacks()
      const index = packs.packs.findIndex((pack) => pack?.id === id)
      if (index < 0) throw new Error('工具包不存在（可能已被删除）')
      const [removed] = packs.packs.splice(index, 1)
      writePacks(packs)

      const state = readState()
      const detached = []
      let changed = false
      const now = new Date().toISOString()
      state.tools = state.tools.map((tool) => {
        if (tool.packId !== id) return tool
        changed = true
        const next = { ...tool, packId: '', updatedAt: now }
        detached.push(clone(next))
        return next
      })
      if (changed) writeState(state)
      return { pack: clone(removed), tools: detached }
    },

    /**
     * One-click switch for a pack: flip every member's own `enabled` flag.
     * Registration still happens per tool, so a pack never becomes a single
     * registry entry.
     */
    setPackEnabled(id, enabled) {
      const packs = readPacks()
      if (!packs.packs.some((pack) => pack?.id === id)) throw new Error('工具包不存在（可能已被删除）')
      const state = readState()
      const now = new Date().toISOString()
      const nextEnabled = enabled !== false
      const updated = []
      state.tools = state.tools.map((tool) => {
        if (tool.packId !== id) return tool
        if (tool.enabled === nextEnabled) {
          updated.push(clone(tool))
          return tool
        }
        const next = { ...tool, enabled: nextEnabled, updatedAt: now }
        updated.push(clone(next))
        return next
      })
      writeState(state)
      const pack = packs.packs.find((entry) => entry.id === id)
      return { pack: clone(pack), tools: updated }
    },

    // #endregion

    settings() {
      return readSettings()
    },

    saveSettings(patch) {
      return saveSettings(patch)
    },
  }
}

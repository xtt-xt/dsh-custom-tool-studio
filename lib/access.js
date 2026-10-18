/**
 * Per-agent tool visibility for the unlock mode ("deferred tool loading").
 *
 * The registry keeps every enabled custom tool registered globally. This module
 * only computes, for one live agent, the set of custom tools that must be
 * denied, and installs that mask through `agent.ctx.tools.restrict({ deny })`.
 * Restrictions are owned by the agent scope, so an agent that goes away takes
 * its mask with it; the plugin additionally disposes them on unload so a
 * bundle reload never leaves a stale mask intersecting the new one.
 *
 * Why not `deferLoading` on the definitions: that flag is static per definition,
 * while unlock state is per conversation and per pack. Why not scoped
 * registration: registration is the single source of truth today and packs are
 * only groups; re-registering on every unlock would duplicate definitions and
 * break name-collision checks. Changing the visible set is enough — the agent
 * loop turns it into a `tool-addition` / `tool-removal` developer message, and
 * the provider activates it on the next request.
 */
import { MANAGE_TOOL_NAME, UNLOCK_TOOL_NAME } from './tools.js'

/** The two tools that stay visible in every conversation. */
export const BASELINE_TOOL_NAMES = Object.freeze([MANAGE_TOOL_NAME, UNLOCK_TOOL_NAME])

/** Plain-object predicate (JSON objects only, never arrays). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Readable message from anything thrown. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Compute the deny list for one agent view. Pure and synchronous so it can be
 * unit-tested without a live registry.
 *
 * @param {object} input
 * @param {object[]} input.records every stored tool record.
 * @param {object[]} input.packs every stored pack.
 * @param {string[]} input.liveNames names currently registered as global tools.
 * @param {string[]} [input.baseNames] always-visible tool names.
 * @param {Iterable<string>} [input.unlockedPackIds] packs unlocked by this session.
 * @param {Iterable<string>} [input.unlockedToolIds] ungrouped tool ids unlocked by this session.
 * @param {boolean} [input.allowUngroupedUnlock] global switch for single-tool unlocks.
 * @returns {string[]} tool names to hide, in input order.
 */
export function computeDeny(input) {
  const source = isPlainObject(input) ? input : {}
  const records = Array.isArray(source.records) ? source.records.filter(isPlainObject) : []
  const packs = Array.isArray(source.packs) ? source.packs.filter(isPlainObject) : []
  const liveNames = Array.isArray(source.liveNames) ? source.liveNames : []
  const baseNames = new Set(Array.isArray(source.baseNames) ? source.baseNames : BASELINE_TOOL_NAMES)
  const unlockedPacks = new Set(source.unlockedPackIds ?? [])
  const unlockedTools = new Set(source.unlockedToolIds ?? [])
  const allowUngroupedUnlock = source.allowUngroupedUnlock === true

  const packById = new Map(packs.map((pack) => [pack.id, pack]))
  const recordByName = new Map(records.map((record) => [record.name, record]))
  const deny = []

  for (const name of liveNames) {
    if (typeof name !== 'string' || name === '' || baseNames.has(name)) continue
    const record = recordByName.get(name)
    // A registered name without a stored record is not ours to explain; hide it
    // rather than leaking a stale registration into a locked conversation.
    if (record === undefined) {
      deny.push(name)
      continue
    }
    const packId = typeof record.packId === 'string' ? record.packId : ''
    if (packId !== '') {
      const pack = packById.get(packId)
      if (pack !== undefined && (pack.alwaysUnlocked === true || unlockedPacks.has(packId))) continue
      deny.push(name)
      continue
    }
    if (allowUngroupedUnlock && unlockedTools.has(record.id)) continue
    deny.push(name)
  }
  return deny
}

/**
 * Create the access controller for one plugin generation.
 *
 * @param {object} options
 * @param {object} options.ctx host plugin context.
 * @param {object} options.store custom-tool store.
 * @param {Map<string, { name: string }>} options.registered live registrations by record id.
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @returns {{
 *   start: () => void,
 *   dispose: () => void,
 *   reconcileAll: () => void,
 *   enabled: () => boolean,
 *   statusFor: (agent: object | undefined) => object,
 *   unlockPack: (agent: object, ref: string) => object,
 *   lockPack: (agent: object, ref: string) => object,
 *   unlockTool: (agent: object, name: string) => object,
 *   lockTool: (agent: object, name: string) => object,
 * }}
 */
export function createAccessController(options = {}) {
  const ctx = options.ctx ?? {}
  const store = options.store
  const registered = options.registered instanceof Map ? options.registered : new Map()
  const logger = options.logger ?? {}

  /** sessionId -> { agent, dispose } for the mask currently installed. */
  const applied = new Map()
  /** sessionId -> { packs: Set<string>, tools: Set<string> } cached unlock state. */
  const unlocked = new Map()
  let started = false
  let listeners = []

  const warn = (message) => {
    try {
      logger?.warn?.(`[custom-tool-studio] ${message}`)
    } catch {
      /* a logging sink must never break the controller */
    }
  }

  const settings = () => {
    try {
      return store.settings()
    } catch (error) {
      warn(`read settings failed: ${errorText(error)}`)
      return {}
    }
  }

  const enabled = () => settings().unlockMode === true
  const allowUngroupedUnlock = () => settings().allowUngroupedUnlock === true

  /** Load (and cache) one session's unlock state from disk. */
  const loadFor = (sessionId) => {
    const cached = unlocked.get(sessionId)
    if (cached !== undefined) return cached
    let raw = { packs: [], tools: [] }
    try {
      raw = store.unlocks(sessionId)
    } catch (error) {
      warn(`read unlocks for "${sessionId}" failed: ${errorText(error)}`)
    }
    const state = {
      packs: new Set(Array.isArray(raw?.packs) ? raw.packs : []),
      tools: new Set(Array.isArray(raw?.tools) ? raw.tools : []),
    }
    unlocked.set(sessionId, state)
    return state
  }

  /** Names currently registered by this plugin. */
  const liveNames = () => [...registered.values()].map((entry) => entry.name)

  /** Persist one session's state; returns a warning string on failure. */
  const persist = (sessionId, state) => {
    try {
      store.setUnlocks(sessionId, { packs: [...state.packs], tools: [...state.tools] })
      return ''
    } catch (error) {
      const message = errorText(error)
      warn(`write unlocks for "${sessionId}" failed: ${message}`)
      return message
    }
  }

  /** Remove the installed mask for one agent, if any. */
  const clearMask = (sessionId) => {
    const previous = applied.get(sessionId)
    if (previous === undefined) return
    applied.delete(sessionId)
    try {
      previous.dispose()
    } catch {
      /* a disposer may already be gone with the agent scope */
    }
  }

  /**
   * Recompute and install one agent's mask. Never throws: this runs from the
   * synchronous `agent/created` listener, where an exception would veto agent
   * publication. A failure is logged and fails open for that conversation.
   */
  const apply = (agent) => {
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') return
    const sessionId = agent.id
    clearMask(sessionId)

    if (!started || !enabled()) return

    let deny = []
    try {
      const state = loadFor(sessionId)
      deny = computeDeny({
        records: store.list(),
        packs: store.listPacks(),
        liveNames: liveNames(),
        unlockedPackIds: state.packs,
        unlockedToolIds: state.tools,
        allowUngroupedUnlock: allowUngroupedUnlock(),
      })
    } catch (error) {
      warn(`compute unlock mask for "${sessionId}" failed: ${errorText(error)}`)
      return
    }
    if (deny.length === 0) return

    try {
      const dispose = agent.ctx.tools.restrict({ deny })
      if (typeof dispose === 'function') applied.set(sessionId, { agent, dispose })
    } catch (error) {
      warn(`install unlock mask for "${sessionId}" failed: ${errorText(error)}`)
    }
  }

  /** Resolve the agent registry lazily (the service may arrive after mount). */
  const agentService = () => {
    // The plugin does not hard-inject `agents`; a direct `ctx.agents` access can
    // throw on a context that never declared it, so only use the optional form.
    if (typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get('agents')
    } catch (error) {
      warn(`resolve agents service failed: ${errorText(error)}`)
      return undefined
    }
  }

  /** Reapply masks for every live agent (after a tool/settings/pack change). */
  const reconcileAll = () => {
    if (!started) return
    let agents = []
    try {
      const service = agentService()
      agents = typeof service?.list === 'function' ? service.list() : []
    } catch (error) {
      warn(`list agents failed: ${errorText(error)}`)
      return
    }
    for (const agent of agents) {
      try {
        apply(agent)
      } catch (error) {
        warn(`reconcile agent "${agent?.id}" failed: ${errorText(error)}`)
      }
    }
  }

  /** Register listeners and apply masks to agents that already exist. */
  const start = () => {
    if (started) return
    started = true

    const onCreated = (payload) => {
      try {
        apply(payload?.agent)
      } catch (error) {
        warn(`agent/created handler failed: ${errorText(error)}`)
      }
    }
    const onDisposed = (payload) => {
      const sessionId = payload?.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      clearMask(sessionId)
      unlocked.delete(sessionId)
    }

    try {
      const off = ctx.on?.('agent/created', onCreated)
      if (typeof off === 'function') listeners.push(off)
    } catch (error) {
      warn(`listen agent/created failed: ${errorText(error)}`)
    }
    try {
      const off = ctx.on?.('agent/disposed', onDisposed)
      if (typeof off === 'function') listeners.push(off)
    } catch (error) {
      warn(`listen agent/disposed failed: ${errorText(error)}`)
    }

    reconcileAll()
  }

  /** Release every mask and listener; safe to call more than once. */
  const dispose = () => {
    started = false
    for (const sessionId of [...applied.keys()]) clearMask(sessionId)
    applied.clear()
    unlocked.clear()
    for (const off of listeners) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    listeners = []
  }

  /** Resolve a pack locator (id or display name). */
  const requirePack = (ref) => {
    const pack = store.findPackByName(typeof ref === 'string' ? ref : '')
    if (pack === undefined) throw new Error('工具包不存在（可能已被删除）')
    return pack
  }

  /** Resolve an ungrouped tool by name; pack members are rejected. */
  const requireUngroupedTool = (name) => {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') throw new Error('缺少 tool：请给出未分组工具的名字')
    const record = store.findByName(text)
    if (record === undefined) throw new Error(`找不到工具 "${text}"。先用 action="list" 看看现有的工具名`)
    const packId = typeof record.packId === 'string' ? record.packId : ''
    if (packId !== '') {
      const pack = store.getPack(packId)
      throw new Error(`工具 "${record.name}" 属于工具包 "${pack?.name ?? packId}"，请解锁或锁定整个工具包`)
    }
    return record
  }

  /** Status of every pack and ungrouped tool for one agent view. */
  const statusFor = (agent) => {
    const sessionId = typeof agent?.id === 'string' ? agent.id : ''
    const state = sessionId === '' ? { packs: new Set(), tools: new Set() } : loadFor(sessionId)
    const allRecords = store.list()
    const allPacks = store.listPacks()
    const live = new Set(liveNames())
    const allowUngrouped = allowUngroupedUnlock()

    const packs = allPacks.map((pack) => {
      const members = allRecords.filter((record) => record.packId === pack.id)
      return {
        id: pack.id,
        name: pack.name,
        alwaysUnlocked: pack.alwaysUnlocked === true,
        unlocked: state.packs.has(pack.id),
        toolCount: members.length,
        enabledCount: members.filter((record) => record.enabled !== false).length,
        tools: members.map((record) => record.name),
      }
    })

    const ungroupedRecords = allRecords.filter((record) => {
      const packId = typeof record.packId === 'string' ? record.packId : ''
      return packId === ''
    })
    const ungrouped = {
      count: ungroupedRecords.length,
      names: ungroupedRecords.map((record) => record.name),
      allowUnlock: allowUngrouped,
      tools: ungroupedRecords.map((record) => ({
        id: record.id,
        name: record.name,
        enabled: record.enabled !== false,
        registered: live.has(record.name),
        unlocked: state.tools.has(record.id),
      })),
    }

    let deny = []
    if (enabled()) {
      deny = computeDeny({
        records: allRecords,
        packs: allPacks,
        liveNames: [...live],
        unlockedPackIds: state.packs,
        unlockedToolIds: state.tools,
        allowUngroupedUnlock: allowUngrouped,
      })
    }
    const hidden = new Set(deny)
    return {
      enabled: enabled(),
      allowUngroupedUnlock: allowUngrouped,
      sessionId,
      baseline: [...BASELINE_TOOL_NAMES],
      packs,
      ungrouped,
      visibleTools: [...live].filter((name) => !hidden.has(name)),
      hiddenTools: [...hidden],
    }
  }

  /** Unlock one pack for this agent. */
  const unlockPack = (agent, ref) => {
    if (!enabled()) throw new Error('解锁模式未开启：请在页面「设置」里开启「AI 主动解锁模式」')
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
      throw new Error('无法确定当前对话（缺少 agent），不能记录本次解锁')
    }
    const pack = requirePack(ref)
    if (pack.alwaysUnlocked === true) {
      return { pack, already: true, always: true, names: [], warning: '' }
    }
    const state = loadFor(agent.id)
    if (state.packs.has(pack.id)) {
      return { pack, already: true, always: false, names: [], warning: '' }
    }
    state.packs.add(pack.id)
    const warning = persist(agent.id, state)
    apply(agent)
    const names = store.list()
      .filter((record) => record.packId === pack.id && record.enabled !== false)
      .map((record) => record.name)
    return { pack, already: false, always: false, names, warning }
  }

  /** Re-lock one pack for this agent. */
  const lockPack = (agent, ref) => {
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
      throw new Error('无法确定当前对话（缺少 agent），不能记录本次锁定')
    }
    const pack = requirePack(ref)
    if (pack.alwaysUnlocked === true) {
      throw new Error(`工具包 "${pack.name}" 是始终解锁，不能单独锁定；请在页面关闭它的「始终解锁」`)
    }
    const state = loadFor(agent.id)
    const had = state.packs.delete(pack.id)
    const warning = had ? persist(agent.id, state) : ''
    if (had) apply(agent)
    return { pack, already: !had, warning }
  }

  /** Unlock one ungrouped tool for this agent. */
  const unlockTool = (agent, name) => {
    if (!enabled()) throw new Error('解锁模式未开启：请在页面「设置」里开启「AI 主动解锁模式」')
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
      throw new Error('无法确定当前对话（缺少 agent），不能记录本次解锁')
    }
    if (!allowUngroupedUnlock()) {
      throw new Error('未分组工具单独解锁未开启：请把工具放进工具包，或在页面「设置」里开启「允许单独解锁未分组工具」')
    }
    const record = requireUngroupedTool(name)
    if (BASELINE_TOOL_NAMES.includes(record.name)) throw new Error('基线工具始终可见，无需解锁')
    if (record.enabled === false) throw new Error(`工具 "${record.name}" 已停用，启用后才能解锁`)
    const state = loadFor(agent.id)
    if (state.tools.has(record.id)) return { record, already: true, warning: '' }
    state.tools.add(record.id)
    const warning = persist(agent.id, state)
    apply(agent)
    return { record, already: false, warning }
  }

  /** Re-lock one ungrouped tool for this agent. */
  const lockTool = (agent, name) => {
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
      throw new Error('无法确定当前对话（缺少 agent），不能记录本次锁定')
    }
    const record = requireUngroupedTool(name)
    const state = loadFor(agent.id)
    const had = state.tools.delete(record.id)
    const warning = had ? persist(agent.id, state) : ''
    if (had) apply(agent)
    return { record, already: !had, warning }
  }

  return {
    start,
    dispose,
    reconcileAll,
    enabled,
    statusFor,
    unlockPack,
    lockPack,
    unlockTool,
    lockTool,
  }
}

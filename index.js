/**
 * Custom tool studio — Host half.
 *
 * Responsibilities:
 *  1. Persist custom tool records (`<DSH_HOME>/custom-tools/tools.json`).
 *  2. Register every enabled record as a real DSH tool, and re-register on
 *     every create/update/delete/enable change — no restart needed.
 *  3. Expose the shared operations to the Web page over loopback HTTP routes.
 *  4. Expose the same operations to the model through `custom_tool_manage`.
 *  5. Group tools into named, described packs. A pack is a label plus a
 *     one-click switch over its members; registration stays per tool, so a
 *     pack never becomes a single registry entry.
 *  6. Gate dangerous tools: a `tools/pre-execute` decision of `ask` routes the
 *     call through the built-in approval seam, which is also what the built-in
 *     Auto review feature delegates to.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStore, DEFAULT_SETTINGS } from './lib/store.js'
import { detectPython, runPython } from './lib/python.js'
import { buildManageTool, buildToolDefinition, buildUnlockTool } from './lib/tools.js'
import { createAccessController } from './lib/access.js'
import { makeRoutes } from './lib/routes.js'
import { makePreExecuteListener } from './lib/gate.js'

/** Cordis plugin name (log/loader identity, not a tool name). */
export const name = 'custom-tool-studio'

/** Services required before tools can be registered and routes mounted. */
export const inject = ['webServer', 'tools']

const TIMEOUT_MS = Number(process.env.DSH_CUSTOM_TOOL_TIMEOUT_MS) > 0
  ? Number(process.env.DSH_CUSTOM_TOOL_TIMEOUT_MS)
  : 60_000

/** Resolve the data directory: env override, then `<DSH_HOME>/custom-tools`. */
function resolveRootDir() {
  const configured = typeof process.env.DSH_CUSTOM_TOOLS_DIR === 'string' ? process.env.DSH_CUSTOM_TOOLS_DIR.trim() : ''
  if (configured !== '') return resolve(configured)
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'custom-tools')
}

/**
 * Mount the custom tool studio.
 * @param {object} ctx Host plugin context carrying `tools` and `webServer`.
 */
export function apply(ctx) {
  try {
    mount(ctx)
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[custom-tool-studio] mount failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      /* ignore */
    }
  }
}

/** Actual mount body (kept separate so a failure never breaks the boot). */
function mount(ctx) {
  const rootDir = resolveRootDir()
  const store = createStore(rootDir)
  const registered = new Map()
  const registrationErrors = new Map()
  let dangerousNames = new Set()

  /** Optional agent service: without it the plugin still manages tools. */
  const agentService = () => {
    // Do not touch `ctx.agents` directly: this plugin does not declare it as a
    // hard dependency, and optional services must be read through `ctx.get`.
    if (typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get('agents')
    } catch {
      return undefined
    }
  }
  /** Current initiating agent (lazy: the service may exist only after mount). */
  const currentAgent = () => {
    const service = agentService()
    return typeof service?.currentInitiator === 'function' ? service.currentInitiator() : undefined
  }
  /** Per-conversation visibility controller (unlock mode). Null = unavailable. */
  let access = null
  try {
    access = createAccessController({ ctx, store, registered, logger: ctx.logger })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[custom-tool-studio] unlock controller unavailable: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      /* ignore */
    }
  }

  /** Run one record's Python code. */
  const runRecord = (record, args, options = {}) => runPython(record, args, {
    rootDir,
    timeoutMs: TIMEOUT_MS,
    signal: options.signal,
  })

  /** Drop one registration. */
  const unregister = (id) => {
    const entry = registered.get(id)
    if (entry === undefined) return
    try {
      entry.dispose()
    } catch {
      /* a stale disposer must not break the sync pass */
    }
    registered.delete(id)
  }

  /** Reconcile the live tool registry with the stored records. */
  const syncTools = () => {
    const records = store.list()
    const wanted = new Set(records.filter((record) => record.enabled !== false).map((record) => record.id))
    for (const id of [...registered.keys()]) {
      if (!wanted.has(id)) unregister(id)
    }

    const nextDangerous = new Set()
    for (const record of records) {
      if (record.enabled === false) continue
      const existing = registered.get(record.id)
      if (existing !== undefined && existing.name === record.name && existing.updatedAt === record.updatedAt) {
        if (record.dangerous === true) nextDangerous.add(record.name)
        continue
      }
      if (existing !== undefined) unregister(record.id)
      try {
        const definition = buildToolDefinition(record, runRecord)
        const occupant = ctx.tools.get(definition.name)
        if (occupant !== undefined) {
          throw new Error(`工具名 "${definition.name}" 已被现有工具占用（内置工具或其他插件），请换一个名字`)
        }
        const dispose = ctx.tools.register(definition)
        registered.set(record.id, { name: record.name, updatedAt: record.updatedAt, dispose })
        registrationErrors.delete(record.id)
        if (record.dangerous === true) nextDangerous.add(record.name)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        registrationErrors.set(record.id, message)
        try {
          ctx.logger?.warn?.(`[custom-tool-studio] register ${record.name} failed: ${message}`)
        } catch {
          /* ignore */
        }
      }
    }
    dangerousNames = nextDangerous
    // Registration changes can add/remove names the per-agent masks must cover.
    access?.reconcileAll()
  }

  /** One record plus its live registration status. */
  const decorate = (record) => {
    if (record === undefined) return undefined
    return {
      ...record,
      registered: registered.has(record.id),
      registrationError: registrationErrors.get(record.id),
    }
  }

  /** One pack plus its membership summary (names, counts, all-on flag). */
  const decoratePack = (pack, records) => {
    if (pack === undefined) return undefined
    const members = records.filter((record) => record.packId === pack.id)
    return {
      ...pack,
      tools: members.map((record) => record.name),
      toolCount: members.length,
      enabledCount: members.filter((record) => record.enabled !== false).length,
      allEnabled: members.length > 0 && members.every((record) => record.enabled !== false),
    }
  }

  /** Resolve a pack locator (id or display name) to its record. */
  const requirePack = (ref) => {
    const pack = store.findPackByName(typeof ref === 'string' ? ref : '')
    if (pack === undefined) throw new Error('工具包不存在（可能已被删除）')
    return pack
  }

  const engine = {
    paths: store.paths,
    pythonInfo() {
      const info = detectPython()
      return { ok: info.ok === true, command: info.command, version: info.version, error: info.error }
    },
    list() {
      return store.list().map(decorate)
    },
    get(id) {
      return decorate(store.get(id))
    },
    findByName(toolName) {
      return store.findByName(toolName)
    },
    create(input) {
      const record = store.create(input)
      syncTools()
      return engine.get(record.id)
    },
    update(id, patch) {
      store.update(id, patch)
      syncTools()
      return engine.get(id)
    },
    removeRecord(id) {
      unregister(id)
      const removed = store.remove(id)
      syncTools()
      return removed
    },
    setEnabled(id, enabled) {
      store.setEnabled(id, enabled)
      syncTools()
      return engine.get(id)
    },
    listPacks() {
      const records = store.list()
      return store.listPacks().map((pack) => decoratePack(pack, records))
    },
    getPack(ref) {
      const pack = store.findPackByName(typeof ref === 'string' ? ref : '')
      return decoratePack(pack, store.list())
    },
    createPack(input) {
      const pack = store.createPack(input)
      syncTools()
      return decoratePack(pack, store.list())
    },
    updatePack(ref, patch) {
      const pack = requirePack(ref)
      const updated = store.updatePack(pack.id, patch)
      syncTools()
      return decoratePack(updated, store.list())
    },
    removePack(ref) {
      const pack = requirePack(ref)
      const outcome = store.removePack(pack.id)
      syncTools()
      return { ...outcome, pack: decoratePack(outcome.pack, store.list()) }
    },
    setPackEnabled(ref, enabled) {
      const pack = requirePack(ref)
      const outcome = store.setPackEnabled(pack.id, enabled)
      syncTools()
      return {
        pack: decoratePack(outcome.pack, store.list()),
        tools: outcome.tools.map((record) => decorate(record)),
      }
    },
    getSettings() {
      return store.settings()
    },
    setSettings(patch) {
      const next = store.saveSettings(patch)
      // Toggling the mode (or the ungrouped switch) changes visibility at once.
      access?.reconcileAll()
      return next
    },
    unlockView(agent) {
      return access === null ? null : access.statusFor(agent)
    },
    defaultSettings() {
      return { ...DEFAULT_SETTINGS }
    },
    runRecord,
  }

  // 1. Register every stored tool for this process generation.
  syncTools()

  // 2. Publish the agent-facing management tool.
  ctx.effect(() => {
    const dispose = ctx.tools.register(buildManageTool(engine))
    return () => {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  })

  // 3. Publish the per-conversation unlock tool and start the visibility
  //    controller. The controller is started only after both baseline tools
  //    exist, so no mask can ever hide them.
  ctx.effect(() => {
    const dispose = ctx.tools.register(buildUnlockTool(access, (exec) => (exec?.agent ?? currentAgent())))
    return () => {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  })

  ctx.effect(() => {
    access?.start()
    return () => access?.dispose()
  })

  // 4. Mount the Web page routes.
  ctx.effect(() => {
    const disposers = makeRoutes(engine, { logger: ctx.logger }).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  })

  // 5. Ask for approval before every dangerous execution (including a test
  //    call made through the management tool), and before the management
  //    operations the user gated in the page's settings dialog. `ask` is
  //    exactly what the built-in approval seam and Auto review expect.
  ctx.on('tools/pre-execute', makePreExecuteListener({
    isDangerous: (toolName) => dangerousNames.has(toolName),
    findByName: (toolName) => store.findByName(toolName),
    findPackByName: (ref) => store.findPackByName(ref),
    getSettings: () => store.settings(),
  }))

  // 6. Release every live registration with the plugin.
  ctx.effect(() => () => {
    for (const id of [...registered.keys()]) unregister(id)
    registered.clear()
    registrationErrors.clear()
  })
}

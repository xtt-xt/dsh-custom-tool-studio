import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeDeny, createAccessController } from '../lib/access.js'
import { createStore } from '../lib/store.js'

const fails = []
const check = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

const root = mkdtempSync(join(tmpdir(), 'cts-access-'))
const store = createStore(root)

const alpha = store.create({
  name: 'alpha',
  description: 'alpha tool',
  code: 'def run(args):\n    return {"ok": True}\n',
})
const beta = store.create({
  name: 'beta',
  description: 'beta tool',
  code: 'def run(args):\n    return {"ok": True}\n',
})
const gamma = store.create({
  name: 'gamma',
  description: 'ungrouped tool',
  code: 'def run(args):\n    return {"ok": True}\n',
})
const pack = store.createPack({ name: 'pack one', description: 'one pack', tools: ['alpha', 'beta'] })

const registered = new Map(store.list().map((record) => [record.id, { name: record.name }]))

/** Fake agent whose scope exposes a recording `restrict`. */
const makeAgent = (id) => {
  const calls = []
  return {
    id,
    calls,
    ctx: {
      tools: {
        restrict(filter) {
          const entry = { filter, disposed: false }
          calls.push(entry)
          return () => {
            entry.disposed = true
          }
        },
      },
    },
  }
}

/** Fake host context with event handlers and an agent list. */
const makeCtx = (agents) => {
  const handlers = new Map()
  return {
    agents,
    get(name) {
      return name === 'agents' ? agents : undefined
    },
    on(name, handler) {
      handlers.set(name, handler)
      return () => {
        if (handlers.get(name) === handler) handlers.delete(name)
      }
    },
    emit(name, payload) {
      const handler = handlers.get(name)
      if (handler !== undefined) handler(payload)
    },
    handlers,
  }
}

// --- pure deny computation -------------------------------------------------
{
  const deny = computeDeny({
    records: store.list(),
    packs: store.listPacks(),
    liveNames: ['custom_tool_manage', 'custom_tool_unlock', 'alpha', 'beta', 'gamma'],
    baseNames: ['custom_tool_manage', 'custom_tool_unlock'],
    unlockedPackIds: [],
    unlockedToolIds: [],
    allowUngroupedUnlock: false,
  })
  check('baseline tools are never denied', !deny.includes('custom_tool_manage') && !deny.includes('custom_tool_unlock'), deny.join(','))
  check('pack members are denied until unlocked', deny.includes('alpha') && deny.includes('beta'), deny.join(','))
  check('ungrouped tools are denied by default', deny.includes('gamma'), deny.join(','))
}

// --- controller lifecycle --------------------------------------------------
const agent = makeAgent('session-1')
const agents = { list: () => [agent], currentInitiator: () => agent }
const ctx = makeCtx(agents)
store.saveSettings({ unlockMode: true, allowUngroupedUnlock: false })

const access = createAccessController({ ctx, store, registered })
access.start()
check('start applies a mask to a live agent', agent.calls.length === 1, String(agent.calls.length))
check('mask denies pack members', agent.calls[0].filter.deny.includes('alpha'), JSON.stringify(agent.calls[0].filter))

const firstMask = agent.calls[0]
const unlocked = access.unlockPack(agent, 'pack one')
check('unlockPack reports the newly visible tools', unlocked.names.includes('alpha') && unlocked.names.includes('beta'), JSON.stringify(unlocked))
check('unlockPack replaces the old mask', firstMask.disposed === true && agent.calls.length === 2, `${firstMask.disposed}/${agent.calls.length}`)
check('unlocked pack members leave the deny list', !agent.calls[1].filter.deny.includes('alpha') && !agent.calls[1].filter.deny.includes('beta'), JSON.stringify(agent.calls[1].filter))

const view = access.statusFor(agent)
check('statusFor reports the session unlock', view.packs.find((entry) => entry.id === pack.id)?.unlocked === true)
check('statusFor keeps ungrouped tools visible as locked', view.ungrouped.tools.find((entry) => entry.id === gamma.id)?.unlocked === false)

let threw = ''
try {
  access.unlockTool(agent, 'gamma')
} catch (error) {
  threw = error.message
}
check('unlockTool refuses while allowUngroupedUnlock is off', /单独解锁未开启/.test(threw), threw)

store.saveSettings({ allowUngroupedUnlock: true })
access.reconcileAll()
threw = ''
try {
  access.unlockTool(agent, 'alpha')
} catch (error) {
  threw = error.message
}
check('unlockTool refuses a pack member', /属于工具包/.test(threw), threw)

const unlockGamma = access.unlockTool(agent, 'gamma')
check('unlockTool unlocks one ungrouped tool', unlockGamma.record.name === 'gamma' && unlockGamma.already === false, JSON.stringify(unlockGamma))
check('unlocked ungrouped tool leaves the deny list', !access.statusFor(agent).hiddenTools.includes('gamma'), JSON.stringify(access.statusFor(agent).hiddenTools))
check('an emptied deny set lifts the mask instead of installing one', agent.calls.every((entry) => entry.disposed === true))

store.saveSettings({ allowUngroupedUnlock: false })
access.reconcileAll()
check('turning the single-tool switch off hides the tool again', access.statusFor(agent).hiddenTools.includes('gamma'), JSON.stringify(access.statusFor(agent).hiddenTools))
store.saveSettings({ allowUngroupedUnlock: true })
access.reconcileAll()
check('turning it back on restores the remembered unlock', !access.statusFor(agent).hiddenTools.includes('gamma'))

// always-unlocked pack
store.updatePack(pack.id, { alwaysUnlocked: true })
access.reconcileAll()
check('always-unlocked pack members are never denied', !agent.calls[agent.calls.length - 1].filter.deny.includes('alpha'))
threw = ''
try {
  access.lockPack(agent, 'pack one')
} catch (error) {
  threw = error.message
}
check('lockPack refuses an always-unlocked pack', /始终解锁/.test(threw), threw)

// mode off lifts every mask
store.saveSettings({ unlockMode: false })
access.reconcileAll()
check('turning unlock mode off disposes existing masks', agent.calls.every((entry) => entry.disposed === true), JSON.stringify(agent.calls.map((entry) => entry.disposed)))

// mode back on restores persisted state
store.saveSettings({ unlockMode: true })
access.reconcileAll()
check('re-enabling the mode reapplies the policy', access.statusFor(agent).hiddenTools.length === 0, JSON.stringify(access.statusFor(agent).hiddenTools))

// a new session starts locked, independent from session-1
const second = makeAgent('session-2')
agents.list = () => [agent, second]
ctx.emit('agent/created', { agent: second })
check('a new session gets its own mask', second.calls.length === 1, String(second.calls.length))
check('a new session does not inherit unlocks', second.calls[0].filter.deny.includes('gamma'), JSON.stringify(second.calls[0].filter))

// a failing restrict must not throw out of the creation listener
const broken = {
  id: 'session-broken',
  ctx: { tools: { restrict() { throw new Error('scope gone') } } },
}
let listenerThrew = false
try {
  ctx.emit('agent/created', { agent: broken })
} catch {
  listenerThrew = true
}
check('a restrict failure never vetoes agent creation', listenerThrew === false)

// disposal clears listeners and masks
access.dispose()
check('dispose disposes every installed mask', agent.calls.every((entry) => entry.disposed === true) && second.calls.every((entry) => entry.disposed === true))
check('dispose removes listeners', ctx.handlers.size === 0, String(ctx.handlers.size))

// persistence survives a fresh controller
const reopened = createAccessController({ ctx: makeCtx({ list: () => [], currentInitiator: () => undefined }), store, registered })
reopened.start()
const persisted = reopened.statusFor({ id: 'session-1' })
check('unlocks survive a controller rebuild', persisted.packs.find((entry) => entry.id === pack.id)?.unlocked === true)
check('single-tool unlocks survive a controller rebuild', persisted.ungrouped.tools.find((entry) => entry.id === gamma.id)?.unlocked === true)
reopened.dispose()

rmSync(root, { recursive: true, force: true })

if (fails.length > 0) {
  console.error(`FAILED: ${fails.join(', ')}`)
  process.exit(1)
}
console.log('ALL PASS')

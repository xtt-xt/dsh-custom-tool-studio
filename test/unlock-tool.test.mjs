import { buildUnlockTool, UNLOCK_TOOL_NAME } from '../lib/tools.js'

const fails = []
const check = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

const agent = { id: 'session-test' }
const view = {
  enabled: true,
  allowUngroupedUnlock: true,
  sessionId: agent.id,
  baseline: ['custom_tool_manage', 'custom_tool_unlock'],
  packs: [
    { id: 'p1', name: 'pack one', alwaysUnlocked: false, unlocked: true, toolCount: 2, enabledCount: 2, tools: ['alpha', 'beta'] },
    { id: 'p2', name: 'pack two', alwaysUnlocked: true, unlocked: false, toolCount: 1, enabledCount: 1, tools: ['gamma'] },
  ],
  ungrouped: {
    count: 1,
    names: ['delta'],
    allowUnlock: true,
    tools: [{ id: 't1', name: 'delta', enabled: true, registered: true, unlocked: false }],
  },
  visibleTools: ['custom_tool_manage', 'custom_tool_unlock', 'alpha', 'beta', 'gamma'],
  hiddenTools: ['delta'],
}

const calls = []
const access = {
  statusFor() {
    return view
  },
  unlockPack(_agent, ref) {
    calls.push(['unlockPack', ref])
    if (ref === 'always') return { pack: { name: 'pack two' }, already: true, always: true, names: [], warning: '' }
    if (ref === 'done') return { pack: { name: 'pack one' }, already: true, always: false, names: [], warning: '' }
    return { pack: { name: 'pack one' }, already: false, always: false, names: ['alpha', 'beta'], warning: '' }
  },
  lockPack(_agent, ref) {
    calls.push(['lockPack', ref])
    return { pack: { name: 'pack one' }, already: false, warning: '' }
  },
  unlockTool(_agent, ref) {
    calls.push(['unlockTool', ref])
    if (ref === 'done') return { record: { name: 'delta' }, already: true, warning: '' }
    return { record: { name: 'delta' }, already: false, warning: 'disk full' }
  },
  lockTool(_agent, ref) {
    calls.push(['lockTool', ref])
    return { record: { name: 'delta' }, already: false, warning: '' }
  },
}

const tool = buildUnlockTool(access, () => agent)
const run = async (args) => tool.execute(args, { agent })
const summary = (value) => (typeof value?.summary === 'string' ? value.summary : '')

check('tool name is reserved and documented', tool.name === UNLOCK_TOOL_NAME && tool.name === 'custom_tool_unlock', tool.name)
check('parameters expose list/unlock/lock', JSON.stringify(tool.parameters.properties.action.enum) === JSON.stringify(['list', 'unlock', 'lock']))
check('parameters expose pack and tool', typeof tool.parameters.properties.pack.type === 'string' && typeof tool.parameters.properties.tool.type === 'string')
check('tool is not concurrency safe', tool.isConcurrencySafe() === false)

const listed = await run({ action: 'list' })
check('list succeeds', listed.ok === true)
check('list mentions both baseline tools', summary(listed).includes('custom_tool_manage') && summary(listed).includes('custom_tool_unlock'))
check('list shows pack states', summary(listed).includes('始终解锁') && summary(listed).includes('当前对话已解锁'))
check('list shows ungrouped state', summary(listed).includes('delta') && summary(listed).includes('可单独解锁'))

const unlockedPack = await run({ action: 'unlock', pack: 'pack one' })
check('unlock pack succeeds', unlockedPack.ok === true && summary(unlockedPack).includes('已解锁工具包'))
check('unlock pack lists newly visible tools', summary(unlockedPack).includes('alpha') && summary(unlockedPack).includes('beta'))
check('unlock pack calls the controller', JSON.stringify(calls[calls.length - 1]) === JSON.stringify(['unlockPack', 'pack one']))

const always = await run({ action: 'unlock', pack: 'always' })
check('always-unlocked pack needs no unlock', always.ok === true && summary(always).includes('始终解锁'))

const already = await run({ action: 'unlock', pack: 'done' })
check('already-unlocked pack is idempotent', already.ok === true && summary(already).includes('已经是解锁状态'))

const unlockedTool = await run({ action: 'unlock', tool: 'delta' })
check('unlock ungrouped tool succeeds', unlockedTool.ok === true && summary(unlockedTool).includes('已单独解锁'))
check('unlock tool reports a persistence warning', summary(unlockedTool).includes('未能写入 unlocks.json') && summary(unlockedTool).includes('disk full'))

const alreadyTool = await run({ action: 'unlock', tool: 'done' })
check('already-unlocked tool is idempotent', alreadyTool.ok === true && summary(alreadyTool).includes('已经单独解锁'))

const lockedPack = await run({ action: 'lock', pack: 'pack one' })
check('lock pack succeeds', lockedPack.ok === true && summary(lockedPack).includes('已重新锁定工具包'))

const lockedTool = await run({ action: 'lock', tool: 'delta' })
check('lock tool succeeds', lockedTool.ok === true && summary(lockedTool).includes('已锁定未分组工具'))

const both = await run({ action: 'unlock', pack: 'p', tool: 't' })
check('pack and tool together are rejected', both.ok === false && summary(both).includes('只能给一个'))

const neither = await run({ action: 'unlock' })
check('missing target is rejected', neither.ok === false && summary(neither).includes('缺少目标'))

const unknown = await run({ action: 'nope' })
check('unknown action is rejected', unknown.ok === false && summary(unknown).includes('未知 action'))

const throwing = {
  statusFor() {
    throw new Error('boom')
  },
}
const failingTool = buildUnlockTool(throwing, () => agent)
const failed = await failingTool.execute({ action: 'list' }, { agent })
check('controller errors become a failed tool result', failed.ok === false && summary(failed).includes('boom'))

const unavailable = buildUnlockTool(null, () => agent)
const missing = await unavailable.execute({ action: 'list' }, { agent })
check('missing controller fails cleanly', missing.ok === false && summary(missing).includes('解锁功能不可用'))

if (fails.length > 0) {
  console.error(`FAILED: ${fails.join(', ')}`)
  process.exit(1)
}
console.log('ALL PASS')

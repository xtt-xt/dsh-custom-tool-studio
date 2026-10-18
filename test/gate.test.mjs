import { approvalDecision, makePreExecuteListener, managementDecision, APPROVAL_SWITCH } from '../lib/gate.js'
import { MANAGE_TOOL_NAME, UNLOCK_TOOL_NAME } from '../lib/tools.js'

const fails = []
const check = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

const records = {
  py_danger: { name: 'py_danger', title: '危险示例', dangerous: true, enabled: true },
  py_safe: { name: 'py_safe', title: '安全', dangerous: false, enabled: true },
}
const dangerousNames = new Set(['py_danger'])

let settings = { approveCreate: false, approveUpdate: false, approveDelete: true }
const listener = makePreExecuteListener({
  isDangerous: (name) => dangerousNames.has(name),
  findByName: (name) => records[name],
  getSettings: () => settings,
})

const ALLOW = { kind: 'allow' }
let nextCalls = 0
const next = async () => {
  nextCalls += 1
  return ALLOW
}
const decide = (name, args) => listener({ name, arguments: args }, next)

// --- dangerous execution ---------------------------------------------------
nextCalls = 0
const dangerousDecision = await decide('py_danger', {})
check('dangerous tool asks', dangerousDecision.kind === 'ask', dangerousDecision.kind)
check('dangerous tool not delegated', nextCalls === 0)
check('ask carries audited reason', typeof dangerousDecision.reason === 'string' && dangerousDecision.reason.includes('py_danger'))
check('ask carries zh + en prompt', typeof dangerousDecision.displayReason?.zh === 'string' && typeof dangerousDecision.displayReason?.en === 'string')
check('ask zh mentions title', dangerousDecision.displayReason.zh.includes('危险示例'), dangerousDecision.displayReason.zh)

nextCalls = 0
const safeDecision = await decide('py_safe', {})
check('safe tool delegates', safeDecision === ALLOW && nextCalls === 1)

nextCalls = 0
const builtinDecision = await decide('read', { path: 'x' })
check('builtin tool delegates', builtinDecision === ALLOW && nextCalls === 1)

// --- manage test of a dangerous tool (always gated) ------------------------
nextCalls = 0
const manageTestDangerous = await decide(MANAGE_TOOL_NAME, { action: 'test', name: 'py_danger' })
check('manage test of dangerous tool asks', manageTestDangerous.kind === 'ask', manageTestDangerous.kind)
check('manage test of dangerous tool not delegated', nextCalls === 0)

nextCalls = 0
check('manage test of safe tool delegates', (await decide(MANAGE_TOOL_NAME, { action: 'test', name: 'py_safe' })) === ALLOW && nextCalls === 1)

nextCalls = 0
check('manage list delegates', (await decide(MANAGE_TOOL_NAME, { action: 'list' })) === ALLOW && nextCalls === 1)

nextCalls = 0
check('unlock tool delegates without management approval', (await decide(UNLOCK_TOOL_NAME, { action: 'unlock', pack: 'x' })) === ALLOW && nextCalls === 1)

// --- management approval switches ------------------------------------------
check('switch map', APPROVAL_SWITCH.create === 'approveCreate' && APPROVAL_SWITCH.update === 'approveUpdate' && APPROVAL_SWITCH.delete === 'approveDelete')
check('unlock/lock are not approval switches', APPROVAL_SWITCH.unlock === undefined && APPROVAL_SWITCH.lock === undefined)

settings = { approveCreate: false, approveUpdate: false, approveDelete: false }
nextCalls = 0
check('create allowed when switch off', (await decide(MANAGE_TOOL_NAME, { action: 'create', name: 'new_tool' })) === ALLOW && nextCalls === 1)

settings = { approveCreate: true, approveUpdate: false, approveDelete: false }
nextCalls = 0
const createAsk = await decide(MANAGE_TOOL_NAME, { action: 'create', name: 'new_tool' })
check('create asks when switch on', createAsk.kind === 'ask' && nextCalls === 0, createAsk.kind)
check('create prompt names the tool', createAsk.displayReason.zh.includes('new_tool'), createAsk.displayReason.zh)
check('create prompt says 创建', createAsk.displayReason.zh.includes('创建'), createAsk.displayReason.zh)
check('create reason mentions approval', createAsk.reason.includes('requires approval'))

settings = { approveCreate: false, approveUpdate: true, approveDelete: false }
nextCalls = 0
const updateAsk = await decide(MANAGE_TOOL_NAME, { action: 'update', name: 'py_safe' })
check('update asks when switch on', updateAsk.kind === 'ask' && nextCalls === 0, updateAsk.kind)
check('update prompt says 修改', updateAsk.displayReason.zh.includes('修改'), updateAsk.displayReason.zh)

settings = { approveCreate: false, approveUpdate: false, approveDelete: true }
nextCalls = 0
const deleteAsk = await decide(MANAGE_TOOL_NAME, { action: 'delete', name: 'py_safe' })
check('delete asks by default', deleteAsk.kind === 'ask' && nextCalls === 0, deleteAsk.kind)
check('delete prompt warns it is irreversible', deleteAsk.displayReason.zh.includes('无法撤销'), deleteAsk.displayReason.zh)

settings = { approveCreate: false, approveUpdate: false, approveDelete: false }
nextCalls = 0
check('delete allowed when switch off', (await decide(MANAGE_TOOL_NAME, { action: 'delete', name: 'py_safe' })) === ALLOW && nextCalls === 1)

settings = { approveCreate: false, approveUpdate: false, approveDelete: true }
nextCalls = 0
check('set_enabled is not gated', (await decide(MANAGE_TOOL_NAME, { action: 'set_enabled', name: 'py_safe', enabled: false })) === ALLOW && nextCalls === 1)

// --- tool packs ------------------------------------------------------------
const packs = {
  '日志包': { id: 'p_1', name: '日志包' },
  p_2: { id: 'p_2', name: '数据包' },
}
const packListener = makePreExecuteListener({
  isDangerous: () => false,
  findByName: (name) => records[name],
  findPackByName: (ref) => packs[ref],
  getSettings: () => settings,
})
const decidePack = (args) => packListener({ name: MANAGE_TOOL_NAME, arguments: args }, next)

check(
  'pack switch map',
  APPROVAL_SWITCH.pack_create === 'approveCreate'
    && APPROVAL_SWITCH.pack_update === 'approveUpdate'
    && APPROVAL_SWITCH.pack_delete === 'approveDelete',
)

settings = { approveCreate: false, approveUpdate: false, approveDelete: false }
nextCalls = 0
check('pack_create allowed when switch off', (await decidePack({ action: 'pack_create', name: '新包' })) === ALLOW && nextCalls === 1)

settings = { approveCreate: true, approveUpdate: false, approveDelete: false }
nextCalls = 0
const packCreateAsk = await decidePack({ action: 'pack_create', name: '新包', description: 'x' })
check('pack_create asks when switch on', packCreateAsk.kind === 'ask' && nextCalls === 0, packCreateAsk.kind)
check('pack_create prompt says 工具包', packCreateAsk.displayReason.zh.includes('工具包'), packCreateAsk.displayReason.zh)
check('pack_create prompt names the pack', packCreateAsk.displayReason.zh.includes('新包'), packCreateAsk.displayReason.zh)
check('pack_create reason says tool pack', packCreateAsk.reason.includes('Tool pack'), packCreateAsk.reason)

settings = { approveCreate: false, approveUpdate: true, approveDelete: false }
nextCalls = 0
const packUpdateAsk = await decidePack({ action: 'pack_update', pack: 'p_2', description: 'y' })
check('pack_update asks when switch on', packUpdateAsk.kind === 'ask' && nextCalls === 0, packUpdateAsk.kind)
check('pack_update resolves the canonical name', packUpdateAsk.displayReason.zh.includes('数据包'), packUpdateAsk.displayReason.zh)
check('pack_update prompt says 修改', packUpdateAsk.displayReason.zh.includes('修改'), packUpdateAsk.displayReason.zh)

const packUpdateByName = await decidePack({ action: 'pack_update', name: '日志包', description: 'z' })
check('pack_update falls back to name', packUpdateByName.displayReason.zh.includes('日志包'), packUpdateByName.displayReason.zh)

settings = { approveCreate: false, approveUpdate: false, approveDelete: true }
nextCalls = 0
const packDeleteAsk = await decidePack({ action: 'pack_delete', pack: '日志包' })
check('pack_delete asks by default', packDeleteAsk.kind === 'ask' && nextCalls === 0, packDeleteAsk.kind)
check('pack_delete warns it is irreversible', packDeleteAsk.displayReason.zh.includes('无法撤销'), packDeleteAsk.displayReason.zh)
check('pack_delete says tools are kept', packDeleteAsk.displayReason.zh.includes('保留'), packDeleteAsk.displayReason.zh)

nextCalls = 0
check('pack_set_enabled is not gated', (await decidePack({ action: 'pack_set_enabled', pack: '日志包', enabled: false })) === ALLOW && nextCalls === 1)

settings = { approveCreate: true, approveUpdate: true, approveDelete: true }
const packUnknownAsk = await decidePack({ action: 'pack_create', name: '未建的包' })
check('unknown pack asks without a known marker', packUnknownAsk.kind === 'ask' && !packUnknownAsk.reason.includes('(pack'), packUnknownAsk.reason)

nextCalls = 0
const toolCreateWithPack = await decide(MANAGE_TOOL_NAME, { action: 'create', name: 't_new', pack: '日志包' })
check('tool create with pack stays a tool prompt', toolCreateWithPack.kind === 'ask' && toolCreateWithPack.displayReason.zh.includes('自定义工具'), toolCreateWithPack.displayReason.zh)

const packDecisionShape = managementDecision('pack_delete', '日志包', true, 'pack')
check(
  'pack decision shape',
  Object.keys(packDecisionShape).sort().join(',') === 'displayReason,kind,reason' && packDecisionShape.reason.includes('pack "日志包"'),
  packDecisionShape.reason,
)

// --- robustness ------------------------------------------------------------
nextCalls = 0
check('anonymous execution delegates', (await listener({}, next)) === ALLOW && nextCalls === 1)

const throwing = makePreExecuteListener({
  isDangerous: () => {
    throw new Error('boom')
  },
  findByName: () => undefined,
  getSettings: () => {
    throw new Error('boom')
  },
})
nextCalls = 0
check('throwing lookups still delegate', (await throwing({ name: 'x', arguments: {} }, next)) === ALLOW && nextCalls === 1)

const noSettings = makePreExecuteListener({ isDangerous: () => false, findByName: () => undefined })
nextCalls = 0
check('missing getSettings delegates', (await noSettings({ name: MANAGE_TOOL_NAME, arguments: { action: 'delete', name: 'x' } }, next)) === ALLOW && nextCalls === 1)

check('managementDecision shape', Object.keys(managementDecision('delete', 'x', true)).sort().join(',') === 'displayReason,kind,reason')
check('title-less ask', approvalDecision({ name: 'bare' }).displayReason.zh.includes('bare'))
check('decision keys', Object.keys(dangerousDecision).sort().join(',') === 'displayReason,kind,reason', Object.keys(dangerousDecision).join(','))

console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILED: ${fails.join(', ')}`)
process.exit(fails.length === 0 ? 0 : 1)

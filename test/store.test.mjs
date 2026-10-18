import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, validateToolName, normalizeParameters, normalizeInput } from '../lib/store.js'
import { detectPython, runPython } from '../lib/python.js'
import { buildToolDefinition, buildManageTool, MANAGE_TOOL_NAME } from '../lib/tools.js'

const fails = []
const ok = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

ok('validateToolName good', validateToolName('python_word_count') === undefined)
ok('validateToolName bad upper', typeof validateToolName('Word') === 'string')
ok('validateToolName reserved', typeof validateToolName('run_code') === 'string')
ok('normalizeParameters undefined', normalizeParameters(undefined).type === 'object')
ok('normalizeParameters garbage', normalizeParameters('not json').type === 'object')
ok('normalizeParameters passthrough', normalizeParameters({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }).properties.a.type === 'string')
try {
  normalizeInput({ name: 'x_tool', description: '', code: 'def run(a): return 1' })
  ok('normalizeInput rejects empty description', false)
} catch (error) {
  ok('normalizeInput rejects empty description', true, error.message)
}
try {
  normalizeInput({ name: 'x_tool', description: 'd', code: 'print(1)' })
  ok('normalizeInput rejects no run()', false)
} catch (error) {
  ok('normalizeInput rejects no run()', true, error.message)
}

const root = mkdtempSync(join(tmpdir(), 'cts-test-'))
const store = createStore(root)
console.log('store paths:', store.paths)

const good = store.create({
  name: 'python_word_count',
  title: '字数统计',
  description: '统计文本的字符。',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  code: [
    'import sys',
    'def run(args):',
    '    text = args.get("text", "")',
    '    print("hello from stdout")',
    '    print("warn", file=sys.stderr)',
    '    return {"chars": len(text), "words": len(text.split())}',
    '',
  ].join('\n'),
  dangerous: false,
})
ok('create record', typeof good.id === 'string' && good.name === 'python_word_count')

const py = detectPython()
console.log('python:', py)
ok('detect python', py.ok === true, `${py.command} ${py.version}`)

const def = buildToolDefinition(good, (record, args, options) => runPython(record, args, { ...options, rootDir: root }))
ok('definition shape', def.name === good.name && def.parameters === good.parameters && typeof def.output.schema === 'object')
ok('definition render', Array.isArray(def.output.render({}, { ok: true, content: 'x', stdout: 's', stderr: '', durationMs: 1, error: '' })))
const passed = await def.execute({ text: 'hello world' }, {})
console.log('execute ->', JSON.stringify(passed))
ok('execute ok', passed.ok === true && JSON.parse(passed.content).chars === 11)
ok('execute stdout captured', passed.stdout.includes('hello from stdout'))
ok('execute stderr captured', passed.stderr.includes('warn'))
ok('execute schema keys', ['ok', 'content', 'stdout', 'stderr', 'durationMs', 'error'].every((key) => key in passed))

const bad = store.create({
  name: 'python_broken',
  description: '故意报错',
  parameters: undefined,
  code: 'def run(args):\n    raise ValueError("boom")\n',
  dangerous: true,
})
const badDef = buildToolDefinition(bad, (record, args, options) => runPython(record, args, { ...options, rootDir: root }))
const badResult = await badDef.execute({}, {})
console.log('broken ->', JSON.stringify({ ok: badResult.ok, error: badResult.error.slice(0, 80) }))
ok('broken tool reports failure', badResult.ok === false && badResult.error.includes('boom'))
ok('broken tool keeps schema valid', Object.keys(badResult).length === 6)

// timeout
const slow = store.create({
  name: 'python_slow',
  description: '慢',
  code: 'import time\ndef run(args):\n    time.sleep(5)\n    return 1\n',
})
const t0 = Date.now()
const slowResult = await runPython(slow, {}, { rootDir: root, timeoutMs: 800 })
const elapsed = Date.now() - t0
console.log('timeout ->', JSON.stringify({ ok: slowResult.ok, error: slowResult.error, elapsed }))
ok('timeout kills run', slowResult.ok === false && slowResult.error.includes('超时') && elapsed < 4000)

// abort
const controller = new AbortController()
setTimeout(() => controller.abort(), 300)
const abortResult = await runPython(slow, {}, { rootDir: root, timeoutMs: 8000, signal: controller.signal })
ok('abort cancels run', abortResult.ok === false && abortResult.error.includes('取消'), abortResult.error)

// management engine (store-only parts)
const decoratePack = (pack) => {
  if (pack === undefined) return undefined
  const members = store.list().filter((tool) => tool.packId === pack.id)
  return {
    ...pack,
    tools: members.map((tool) => tool.name),
    toolCount: members.length,
    enabledCount: members.filter((tool) => tool.enabled !== false).length,
    allEnabled: members.length > 0 && members.every((tool) => tool.enabled !== false),
  }
}
const requirePack = (ref) => {
  const pack = store.findPackByName(ref)
  if (pack === undefined) throw new Error('工具包不存在（可能已被删除）')
  return pack
}
const engine = {
  list: () => store.list(),
  findByName: (n) => store.findByName(n),
  create: (input) => store.create(input),
  update: (id, patch) => store.update(id, patch),
  removeRecord: (id) => store.remove(id),
  setEnabled: (id, enabled) => store.setEnabled(id, enabled),
  listPacks: () => store.listPacks().map(decoratePack),
  getPack: (ref) => decoratePack(store.findPackByName(ref)),
  createPack: (input) => decoratePack(store.createPack(input)),
  updatePack: (ref, patch) => decoratePack(store.updatePack(requirePack(ref).id, patch)),
  removePack: (ref) => {
    const outcome = store.removePack(requirePack(ref).id)
    return { pack: decoratePack(outcome.pack), tools: outcome.tools }
  },
  setPackEnabled: (ref, enabled) => {
    const outcome = store.setPackEnabled(requirePack(ref).id, enabled)
    return { pack: decoratePack(outcome.pack), tools: outcome.tools }
  },
  runRecord: (record, args, options) => runPython(record, args, { ...options, rootDir: root }),
}
const manage = buildManageTool(engine)
ok('manage tool name', manage.name === MANAGE_TOOL_NAME)
const listed = await manage.execute({ action: 'list' })
ok('manage list', listed.ok === true && listed.summary.includes('python_word_count'), listed.summary.split('\n')[0])
const created = await manage.execute({
  action: 'create',
  name: 'manage_made',
  description: '由管理工具创建',
  code: 'def run(args):\n    return {"hi": args.get("who", "there")}\n',
  dangerous: true,
})
ok('manage create', created.ok === true && created.summary.includes('manage_made'))
const tested = await manage.execute({ action: 'test', name: 'manage_made', args: { who: 'dsh' } })
ok('manage test', tested.ok === true && tested.summary.includes('dsh'), tested.summary.split('\n')[0])
const disabled = await manage.execute({ action: 'set_enabled', name: 'manage_made', enabled: false })
ok('manage set_enabled', disabled.ok === true && disabled.summary.includes('已停用'))
const removed = await manage.execute({ action: 'delete', name: 'manage_made' })
ok('manage delete', removed.ok === true)
const missing = await manage.execute({ action: 'get', name: 'nope' })
ok('manage missing name', missing.ok === false && missing.summary.includes('找不到'))

// duplicate name
try {
  store.create({ name: 'python_word_count', description: 'dup', code: 'def run(a): return 1' })
  ok('duplicate rejected', false)
} catch (error) {
  ok('duplicate rejected', error.message.includes('已存在'), error.message)
}

// script mirror
const { existsSync, readFileSync } = await import('node:fs')
ok('script mirror written', existsSync(join(root, 'scripts', 'python_word_count.py')))
ok('script mirror content', readFileSync(join(root, 'scripts', 'python_word_count.py'), 'utf8').includes('def run'))
ok('runner written', existsSync(join(root, 'runner.py')))

// settings
const defaults = store.settings()
ok('settings defaults', defaults.approveCreate === false && defaults.approveUpdate === false && defaults.approveDelete === true, JSON.stringify(defaults))
const saved = store.saveSettings({ approveCreate: true, approveUpdate: 'yes', junk: 1 })
ok('settings save keeps booleans only', saved.approveCreate === true && saved.approveUpdate === false && saved.approveDelete === true && !('junk' in saved), JSON.stringify(saved))
ok('settings persisted', JSON.stringify(store.settings()) === JSON.stringify(saved))
const freshStore = createStore(root)
ok('settings survive reopening', freshStore.settings().approveCreate === true)
const cleared = store.saveSettings({ approveDelete: false })
ok('settings patch merges', cleared.approveCreate === true && cleared.approveDelete === false, JSON.stringify(cleared))
ok('settings file exists', existsSync(join(root, 'settings.json')))
ok('settings file is valid json', JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).approveDelete === false)

// ---- tool packs ----------------------------------------------------------
const packListEmpty = await manage.execute({ action: 'pack_list' })
ok('pack_list empty hint', packListEmpty.ok === true && packListEmpty.summary.includes('pack_create'), packListEmpty.summary)

const packA = store.createPack({ name: '文本工具', description: '处理文本的合集', tools: ['python_word_count'] })
ok('pack create', packA.name === '文本工具' && packA.id.startsWith('p_'), packA.id)
ok('pack membership written', store.findByName('python_word_count').packId === packA.id)
ok('pack membership summary', decoratePack(packA).toolCount === 1 && decoratePack(packA).enabledCount === 1)
ok('pack find by name', store.findPackByName('文本工具')?.id === packA.id)
ok('pack find by id', store.findPackByName(packA.id)?.id === packA.id)
ok('pack find unknown', store.findPackByName('没有这个包') === undefined)

try {
  store.createPack({ name: '文本工具' })
  ok('pack duplicate rejected', false)
} catch (error) {
  ok('pack duplicate rejected', error.message.includes('已存在'), error.message)
}
try {
  store.createPack({ name: '   ' })
  ok('pack blank name rejected', false)
} catch (error) {
  ok('pack blank name rejected', error.message.includes('不能为空'), error.message)
}
try {
  store.createPack({ name: '坏包', tools: ['no_such_tool'] })
  ok('pack unknown member rejected', false)
} catch (error) {
  ok('pack unknown member rejected', error.message.includes('还没有创建'), error.message)
}
ok('failed pack create leaves nothing', store.listPacks().length === 1)

const renamed = store.updatePack(packA.id, { name: '文本处理', description: '新描述' })
ok('pack rename', renamed.name === '文本处理' && renamed.description === '新描述')
ok('pack rename keeps membership', store.findByName('python_word_count').packId === packA.id)

// A tool can join / leave a pack through the tool's own record.
const inPack = store.create({
  name: 'python_join_pack',
  description: '通过 pack 参数入包',
  code: 'def run(a): return 1',
  pack: '文本处理',
})
ok('tool create with pack', inPack.packId === packA.id)
const packCleared = store.update(inPack.id, { pack: '' })
ok('tool leaves pack', packCleared.packId === '')
ok('pack summary after leave', decoratePack(store.findPackByName('文本处理')).toolCount === 1)

const rejoined = store.update(inPack.id, { pack: '文本处理' })
ok('tool rejoins pack', rejoined.packId === packA.id)

// One-click switch: flips every member, leaves other tools alone.
const outsider = store.create({ name: 'python_outsider', description: '包外工具', code: 'def run(a): return 0' })
const off = store.setPackEnabled(packA.id, false)
ok('pack switch off touches members only', off.tools.length === 2 && off.tools.every((tool) => tool.enabled === false))
ok('pack switch off spares outsiders', store.findByName('python_outsider').enabled === true)
ok('pack switch off count', decoratePack(store.findPackByName('文本处理')).enabledCount === 0)
const on = store.setPackEnabled(packA.id, true)
ok('pack switch on', on.tools.every((tool) => tool.enabled === true) && decoratePack(store.findPackByName('文本处理')).enabledCount === 2)
ok('tool identity untouched by switch', store.findByName('python_word_count').code.includes('def run'))
ok('outsider still enabled', store.findByName('python_outsider').enabled === true)

// Deleting a pack keeps its tools.
const deletedPack = store.removePack(packA.id)
ok('pack delete returns members', deletedPack.tools.length === 2)
ok('pack delete clears membership', store.findByName('python_word_count').packId === '')
ok('pack delete keeps tool record', store.findByName('python_word_count') !== undefined)
ok('pack delete keeps code', store.findByName('python_word_count').code.includes('def run'))
ok('pack delete keeps enabled', store.findByName('python_word_count').enabled === true)
try {
  store.removePack(packA.id)
  ok('pack delete twice rejected', false)
} catch (error) {
  ok('pack delete twice rejected', error.message.includes('不存在'), error.message)
}
ok('pack gone from list', store.listPacks().length === 0)

// Manage-tool pack actions.
const packMadeByTool = await manage.execute({
  action: 'pack_create',
  name: 'AI 建的包',
  description: '由 custom_tool_manage 创建',
  tools: ['python_word_count', 'python_outsider'],
})
ok('manage pack_create', packMadeByTool.ok === true && packMadeByTool.summary.includes('AI 建的包'), packMadeByTool.summary.split('\n')[0])
const listedPacks = await manage.execute({ action: 'pack_list' })
ok('manage pack_list', listedPacks.ok === true && listedPacks.summary.includes('AI 建的包') && listedPacks.summary.includes('python_word_count'))
const packDetail = await manage.execute({ action: 'pack_get', name: 'AI 建的包' })
ok('manage pack_get', packDetail.ok === true && packDetail.summary.includes('2 个') && packDetail.summary.includes('python_outsider'))
const packEdited = await manage.execute({ action: 'pack_update', pack: 'AI 建的包', description: '改后的描述', tools: ['python_word_count'] })
ok(
  'manage pack_update',
  packEdited.ok === true && packEdited.summary.includes('改后的描述') && !packEdited.summary.includes('python_outsider'),
  packEdited.summary.split('\n')[0],
)
ok('pack update detached the dropped tool', store.findByName('python_outsider').packId === '')
const packSwitched = await manage.execute({ action: 'pack_set_enabled', pack: 'AI 建的包', enabled: false })
ok('manage pack_set_enabled', packSwitched.ok === true && packSwitched.summary.includes('整体停用'), packSwitched.summary)
ok('manage pack switch persisted', store.findByName('python_word_count').enabled === false)
await manage.execute({ action: 'pack_set_enabled', pack: 'AI 建的包', enabled: true })
const packDropped = await manage.execute({ action: 'pack_delete', pack: 'AI 建的包' })
ok('manage pack_delete', packDropped.ok === true && packDropped.summary.includes('被保留'), packDropped.summary)
ok('pack delete keeps tools registered', store.findByName('python_word_count') !== undefined)
const packMissing = await manage.execute({ action: 'pack_get', pack: '不存在的包' })
ok('manage pack missing', packMissing.ok === false && packMissing.summary.includes('找不到工具包'))
const packBadAction = await manage.execute({ action: 'pack_whatever' })
ok('manage unknown action lists packs', packBadAction.ok === false && packBadAction.summary.includes('pack_list'), packBadAction.summary)

// Pack files survive a fresh store instance.
const packPersist = store.createPack({ name: '持久化包', description: '重开后还在' })
const reopened = createStore(root)
ok('pack survives reopening', reopened.findPackByName('持久化包')?.id === packPersist.id)
ok('packs.json is valid json', JSON.parse(readFileSync(join(root, 'packs.json'), 'utf8')).packs.length === 1)
ok('tool packId survives reopening', reopened.findByName('python_word_count').packId === '')
ok('legacy record gets empty packId', reopened.list().every((tool) => typeof tool.packId === 'string'))

rmSync(root, { recursive: true, force: true })
console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILED: ${fails.join(', ')}`)
process.exit(fails.length === 0 ? 0 : 1)

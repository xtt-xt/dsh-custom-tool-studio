#!/usr/bin/env node
/**
 * Offline self-check for dsh-custom-tool-studio.
 *
 * Runs with the profile's Node (v20+) and does NOT boot DSH: it imports the
 * host modules directly and exercises the stable export surface documented in
 * CONTRACT.md §6:
 *
 *   ./lib/store.js  -> validateToolName, normalizeParameters, normalizeInput,
 *                      validatePackName, normalizePackInput, createStore
 *   ./lib/tools.js  -> buildToolDefinition, buildManageTool, MANAGE_TOOL_NAME
 *
 * Usage:
 *   node F:\xtt\workspace\dsh-custom-tool-studio\selfcheck.mjs
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed (or a host
 * module / export is missing). No npm dependencies: Node built-ins only.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHECKS = []
let failed = 0

function must(condition, message) {
  if (!condition) throw new Error(message)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObjectRootedSchema(node) {
  return isPlainObject(node) && node.type === 'object' && isPlainObject(node.properties)
}

function describe(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.length > 80 ? `${text.slice(0, 77)}…` : text
  } catch {
    return String(value)
  }
}

function record(label, fn) {
  try {
    const detail = fn()
    CHECKS.push({ label, ok: true })
    console.log(`[ok]   ${label}${typeof detail === 'string' && detail !== '' ? ` — ${detail}` : ''}`)
  } catch (error) {
    reportFailure(label, error)
  }
}

async function recordAsync(label, fn) {
  try {
    const detail = await fn()
    CHECKS.push({ label, ok: true })
    console.log(`[ok]   ${label}${typeof detail === 'string' && detail !== '' ? ` — ${detail}` : ''}`)
  } catch (error) {
    reportFailure(label, error)
  }
}

function reportFailure(label, error) {
  failed += 1
  const reason = error instanceof Error ? error.message : String(error)
  CHECKS.push({ label, ok: false })
  console.log(`[FAIL] ${label} — ${reason}`)
}

/**
 * Load a host module and make sure every promised export exists.
 * A missing module or missing export is a hard, clearly-reported stop —
 * never a raw stack trace.
 */
async function loadHostModule(specifier, exportNames) {
  let module
  try {
    module = await import(specifier)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[selfcheck] FAILED: cannot load host module ${specifier}`)
    console.error(`[selfcheck] reason: ${reason}`)
    if (error && typeof error.code === 'string') {
      console.error(`[selfcheck] code: ${error.code}`)
    }
    process.exit(1)
  }

  const missing = exportNames.filter((name) => module[name] === undefined)
  if (missing.length > 0) {
    console.error(`[selfcheck] FAILED: ${specifier} does not export: ${missing.join(', ')}`)
    console.error('[selfcheck] The host half is incomplete; fix lib/*.js and run this check again.')
    process.exit(1)
  }

  return module
}

// ---------------------------------------------------------------------------
// Load the promised host surface first (clear errors instead of stack traces).
// ---------------------------------------------------------------------------

const store = await loadHostModule('./lib/store.js', [
  'validateToolName',
  'normalizeParameters',
  'normalizeInput',
  'validatePackName',
  'normalizePackInput',
  'createStore',
  'DEFAULT_SETTINGS',
  'TOOL_NAME_RE',
])

const tools = await loadHostModule('./lib/tools.js', ['buildToolDefinition', 'buildManageTool', 'buildUnlockTool', 'MANAGE_TOOL_NAME', 'UNLOCK_TOOL_NAME'])

const access = await loadHostModule('./lib/access.js', ['createAccessController', 'computeDeny', 'BASELINE_TOOL_NAMES'])

const prompt = await loadHostModule('./lib/prompt.js', ['buildPackContextText'])

const {
  TOOL_NAME_RE,
  validateToolName,
  normalizeParameters,
  normalizeInput,
  validatePackName,
  normalizePackInput,
  createStore,
  DEFAULT_SETTINGS,
} = store
const { buildToolDefinition, buildManageTool, buildUnlockTool, MANAGE_TOOL_NAME, UNLOCK_TOOL_NAME } = tools
const { computeDeny, BASELINE_TOOL_NAMES } = access
const { buildPackContextText } = prompt

// ---------------------------------------------------------------------------
// TOOL_NAME_RE
// ---------------------------------------------------------------------------

record('TOOL_NAME_RE matches the documented name shape', () => {
  must(TOOL_NAME_RE instanceof RegExp, `expected a RegExp, got ${describe(TOOL_NAME_RE)}`)
  must(TOOL_NAME_RE.test('python_word_count'), 'should match a normal tool name')
  must(TOOL_NAME_RE.test('a1'), 'should match a two-character name')
  must(!TOOL_NAME_RE.test('1abc'), 'should not match a name starting with a digit')
  must(!TOOL_NAME_RE.test('bad name'), 'should not match a name with a space')
  must(!TOOL_NAME_RE.test('x'.repeat(49)), 'should not match a name longer than 48 chars')
  return String(TOOL_NAME_RE)
})

// ---------------------------------------------------------------------------
// validateToolName
// ---------------------------------------------------------------------------

record('validateToolName accepts valid model-facing names', () => {
  const valid = ['python_word_count', 'a1', 'x_9', 'tool_2', 'count_lines']
  for (const name of valid) {
    const error = validateToolName(name)
    must(error === undefined, `expected ${JSON.stringify(name)} to be valid, got: ${describe(error)}`)
  }
  return `${valid.length} names accepted`
})

record('validateToolName rejects invalid names', () => {
  const invalid = [
    '',
    'A_bad',
    '1abc',
    'a',
    'bad name',
    '工具',
    'x'.repeat(49),
    'run_code',
    'custom_tool_manage',
    'custom_tool_unlock',
  ]
  for (const name of invalid) {
    const error = validateToolName(name)
    must(
      typeof error === 'string' && error.trim() !== '',
      `expected ${JSON.stringify(name)} to be rejected, got: ${describe(error)}`,
    )
  }
  return `${invalid.length} names rejected`
})

// ---------------------------------------------------------------------------
// normalizeParameters — never throws, always object-rooted
// ---------------------------------------------------------------------------

record('normalizeParameters(undefined) returns an object-rooted schema', () => {
  const node = normalizeParameters(undefined)
  must(isObjectRootedSchema(node), `not an object-rooted schema: ${describe(node)}`)
  return describe(node)
})

record('normalizeParameters(garbage) always returns an object-rooted schema', () => {
  const garbage = [null, '', 'not json', 42, true, [], { type: 'string' }, { foo: 'bar' }]
  for (const value of garbage) {
    const node = normalizeParameters(value)
    must(isObjectRootedSchema(node), `input ${describe(value)} produced ${describe(node)}`)
    must(node.type === 'object', `input ${describe(value)} lost type=object`)
    must(isPlainObject(node.properties), `input ${describe(value)} lost properties`)
  }
  return `${garbage.length} garbage inputs normalized`
})

record('normalizeParameters keeps a supplied object schema', () => {
  const input = {
    type: 'object',
    properties: { text: { type: 'string', description: '要统计的文本' } },
    required: ['text'],
    additionalProperties: false,
  }
  const node = normalizeParameters(input)
  must(isObjectRootedSchema(node), `not an object-rooted schema: ${describe(node)}`)
  must(node.required?.[0] === 'text', 'required list was not preserved')
  must(node.additionalProperties === false, 'additionalProperties was not preserved')
  must(node.properties.text?.type === 'string', 'property schema was not preserved')
  return describe(node)
})

// ---------------------------------------------------------------------------
// normalizeInput — validates author input
// ---------------------------------------------------------------------------

record('normalizeInput rejects a record with no code/description', () => {
  const invalidInputs = [
    { name: 'x_demo' }, // no description, no code
    { name: 'x_demo', description: '有一段描述' }, // no code
    { name: 'x_demo', code: 'def run(args):\n    return 1\n' }, // no description
    { name: 'x_demo', description: '有一段描述', code: 'print("no entry point")' }, // no def run
  ]
  for (const input of invalidInputs) {
    let threw = false
    let message = ''
    try {
      normalizeInput(input)
    } catch (error) {
      threw = true
      message = error instanceof Error ? error.message : String(error)
    }
    must(threw, `expected normalizeInput to throw for ${describe(input)}`)
    must(message.trim() !== '', `expected a human-readable error for ${describe(input)}`)
  }
  return `${invalidInputs.length} invalid records rejected`
})

record('normalizeInput accepts a good record', () => {
  const input = {
    name: 'Python_Word_Count',
    description: '统计一段文本的字符数。Use when the user asks for text length statistics.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要统计的文本' } },
      required: ['text'],
    },
    code: 'def run(args):\n    return {"chars": len(args["text"])}\n',
  }
  const fields = normalizeInput(input)
  must(isPlainObject(fields), `expected an object, got ${describe(fields)}`)
  must(fields.name === 'python_word_count', `name was not normalized: ${describe(fields.name)}`)
  must(fields.title === 'python_word_count', `title should default to name: ${describe(fields.title)}`)
  must(typeof fields.description === 'string' && fields.description !== '', 'description missing')
  must(isObjectRootedSchema(fields.parameters), `parameters not object-rooted: ${describe(fields.parameters)}`)
  must(fields.code === input.code, 'code was not preserved')
  must(fields.dangerous === false, 'dangerous should default to false')
  must(fields.enabled === true, 'enabled should default to true')

  const strict = normalizeInput({ ...input, dangerous: true, enabled: false })
  must(strict.dangerous === true, 'dangerous:true was not honored')
  must(strict.enabled === false, 'enabled:false was not honored')
  return 'normalized fields look correct'
})

// ---------------------------------------------------------------------------
// buildToolDefinition — plain ToolDefinition
// ---------------------------------------------------------------------------

const recordFixture = {
  id: 't_1a2b3c4d5e6f',
  name: 'python_word_count',
  title: '字数统计',
  description: '统计一段文本的字符数。Use when the user asks for text length statistics.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: '要统计的文本' } },
    required: ['text'],
  },
  code: 'def run(args):\n    return {"chars": len(args["text"])}\n',
  dangerous: true,
  enabled: true,
}

const runCalls = []
const fakeRun = async (record, args, options) => {
  runCalls.push({ record, args, options })
  return {
    ok: true,
    result: { chars: 3 },
    content: '{"chars": 3}',
    stdout: 'printed from python',
    stderr: '',
    durationMs: 12,
    error: '',
  }
}

const tool = buildToolDefinition(recordFixture, fakeRun)

record('buildToolDefinition returns the documented tool shape', () => {
  must(isPlainObject(tool), `expected an object, got ${describe(tool)}`)
  must(tool.name === recordFixture.name, `name mismatch: ${describe(tool.name)}`)
  must(tool.description === recordFixture.description, 'description was not passed through')
  must(tool.parameters === recordFixture.parameters, 'parameters were not passed through')
  must(typeof tool.execute === 'function', 'execute is not a function')
  must(isPlainObject(tool.output), 'output is not an object')
  must(typeof tool.output.render === 'function', 'output.render is not a function')
  must(isObjectRootedSchema(tool.output.schema), `output.schema is not object-rooted: ${describe(tool.output.schema)}`)
  must(tool.output.schema.additionalProperties === false, 'output.schema should be closed')
  must(isPlainObject(tool.output.schema.properties), 'output.schema has no properties')
  must(tool.output.schema.properties.ok !== undefined, 'output.schema is missing ok')
  must(tool.output.schema.properties.content !== undefined, 'output.schema is missing content')
  const required = Array.isArray(tool.output.schema.required) ? tool.output.schema.required : []
  must(required.includes('ok'), 'output.schema.required is missing ok')
  must(required.includes('content'), 'output.schema.required is missing content')
  return `name=${tool.name}, output keys=${Object.keys(tool.output.schema.properties).join(',')}`
})

record('buildToolDefinition render returns { type: "text" } blocks', () => {
  const value = {
    ok: true,
    content: '{"chars": 3}',
    stdout: 'printed from python',
    stderr: '',
    durationMs: 12,
    error: '',
  }
  const blocks = tool.output.render({}, value)
  must(Array.isArray(blocks), `render returned ${describe(blocks)}`)
  must(blocks.length > 0, 'render returned no blocks')
  for (const block of blocks) {
    must(isPlainObject(block), `block is not an object: ${describe(block)}`)
    must(block.type === 'text', `block type is ${describe(block.type)}`)
    must(typeof block.text === 'string', `block text is ${describe(block.text)}`)
  }
  must(
    blocks.some((block) => block.text.includes('{"chars": 3}')),
    'render blocks do not contain the result content',
  )
  return `${blocks.length} text block(s)`
})

await recordAsync('execute result keys match the declared output schema', async () => {
  const args = { text: 'abc' }
  const exec = { signal: new AbortController().signal, callId: 'call_1' }
  const value = await tool.execute(args, exec)

  must(isPlainObject(value), `execute returned ${describe(value)}`)
  must(runCalls.length === 1, `expected run() to be called once, got ${runCalls.length}`)
  const call = runCalls[0]
  must(call.record === recordFixture, 'execute did not pass the record to run()')
  must(call.args === args, 'execute did not pass args to run()')
  must(call.options?.signal === exec.signal, 'execute did not forward exec.signal')

  const declaredKeys = Object.keys(tool.output.schema.properties).sort()
  const actualKeys = Object.keys(value).sort()
  must(
    declaredKeys.join(',') === actualKeys.join(','),
    `key mismatch: declared [${declaredKeys.join(',')}] vs actual [${actualKeys.join(',')}]`,
  )
  for (const key of tool.output.schema.required ?? []) {
    must(value[key] !== undefined, `required key "${key}" is missing from the result`)
  }
  must(value.ok === true, `ok should be true, got ${describe(value.ok)}`)
  must(value.content === '{"chars": 3}', `content was not passed through: ${describe(value.content)}`)
  must(value.stdout === 'printed from python', `stdout was not passed through: ${describe(value.stdout)}`)
  return `keys=${actualKeys.join(',')}`
})

// ---------------------------------------------------------------------------
// MANAGE_TOOL_NAME
// ---------------------------------------------------------------------------

record('MANAGE_TOOL_NAME is the documented agent tool name', () => {
  must(MANAGE_TOOL_NAME === 'custom_tool_manage', `got ${describe(MANAGE_TOOL_NAME)}`)
  return MANAGE_TOOL_NAME
})

// ---------------------------------------------------------------------------
// Tool packs (store level)
// ---------------------------------------------------------------------------

record('validatePackName accepts labels and rejects blank/oversized ones', () => {
  for (const name of ['文本处理', 'text tools', 'a']) {
    must(validatePackName(name) === undefined, `expected ${JSON.stringify(name)} to be valid`)
  }
  const invalid = ['', '   ', 'x'.repeat(49), 'two\nlines']
  for (const name of invalid) {
    const error = validatePackName(name)
    must(typeof error === 'string' && error.trim() !== '', `expected ${JSON.stringify(name)} to be rejected`)
  }
  return `${invalid.length} rejected`
})

record('normalizePackInput trims and keeps an optional description', () => {
  const fields = normalizePackInput({ name: '  演示包  ', description: '  说明  ' })
  must(fields.name === '演示包', `name was not trimmed: ${describe(fields.name)}`)
  must(fields.description === '说明', `description was not trimmed: ${describe(fields.description)}`)
  must(fields.alwaysUnlocked === false, 'alwaysUnlocked should default to false')
  const bare = normalizePackInput({ name: '没描述' })
  must(bare.description === '', `description should default to "": ${describe(bare.description)}`)
  const always = normalizePackInput({ name: '始终解锁包', alwaysUnlocked: true })
  must(always.alwaysUnlocked === true, 'alwaysUnlocked was not preserved')
  return `${describe(fields)}`
})

record('a pack only groups tools; it never rewrites or removes them', () => {
  const root = mkdtempSync(join(tmpdir(), 'cts-selfcheck-'))
  try {
    const lib = createStore(root)
    const tool = lib.create({
      name: 'selfcheck_pack_tool',
      description: '仅用于自检',
      code: 'def run(args):\n    return {"ok": True}\n',
    })
    const pack = lib.createPack({ name: '自检包', description: '演示', tools: ['selfcheck_pack_tool'] })
    must(lib.findByName('selfcheck_pack_tool').packId === pack.id, 'membership was not written to the tool')
    must(lib.listPacks().length === 1, `expected 1 pack, got ${lib.listPacks().length}`)

    lib.setPackEnabled(pack.id, false)
    const off = lib.findByName('selfcheck_pack_tool')
    must(off.enabled === false, 'pack switch did not disable its member')
    must(off.code === tool.code, 'pack switch rewrote the tool code')
    lib.setPackEnabled(pack.id, true)
    must(lib.findByName('selfcheck_pack_tool').enabled === true, 'pack switch did not re-enable its member')

    const removed = lib.removePack(pack.id)
    must(removed.tools.length === 1, 'removePack did not report the detached tool')
    const kept = lib.findByName('selfcheck_pack_tool')
    must(kept !== undefined && kept.packId === '', 'removePack should keep the tool and clear its pack')
    must(kept.code === tool.code && kept.parameters !== undefined, 'removePack damaged the tool record')

    const packsFile = join(root, 'packs.json')
    must(existsSync(packsFile), 'packs.json was not written')
    const parsed = JSON.parse(readFileSync(packsFile, 'utf8'))
    must(Array.isArray(parsed.packs) && parsed.packs.length === 0, 'packs.json should hold the current list')
    return 'group / switch / delete verified'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

record('buildManageTool exposes the pack actions', () => {
  const engine = {
    list: () => [],
    findByName: () => undefined,
    create: () => ({}),
    update: () => ({}),
    removeRecord: () => ({}),
    setEnabled: () => ({}),
    listPacks: () => [],
    getPack: () => undefined,
    createPack: () => ({}),
    updatePack: () => ({}),
    removePack: () => ({ pack: {}, tools: [] }),
    setPackEnabled: () => ({ pack: {}, tools: [] }),
    runRecord: async () => ({ ok: true, content: '', stdout: '', stderr: '', durationMs: 0, error: '' }),
  }
  const manage = buildManageTool(engine)
  const actions = manage.parameters?.properties?.action?.enum ?? []
  for (const action of ['pack_list', 'pack_get', 'pack_create', 'pack_update', 'pack_delete', 'pack_set_enabled']) {
    must(actions.includes(action), `management tool is missing action "${action}"`)
  }
  must(manage.parameters.properties.pack !== undefined, 'management tool has no "pack" parameter')
  must(manage.parameters.properties.tools !== undefined, 'management tool has no "tools" parameter')
  must(manage.parameters.properties.alwaysUnlocked !== undefined, 'management tool has no "alwaysUnlocked" parameter')
  must(manage.description.includes('工具包'), 'management tool description does not mention packs')
  return `${actions.length} actions`
})

// ---------------------------------------------------------------------------
// Unlock mode (deferred tool loading)
// ---------------------------------------------------------------------------

record('global defaults keep unlock mode off', () => {
  must(DEFAULT_SETTINGS.unlockMode === false, `unlockMode default: ${describe(DEFAULT_SETTINGS.unlockMode)}`)
  must(DEFAULT_SETTINGS.allowUngroupedUnlock === false, `allowUngroupedUnlock default: ${describe(DEFAULT_SETTINGS.allowUngroupedUnlock)}`)
  must(DEFAULT_SETTINGS.approveDelete === true, 'delete approval should stay on by default')
  return describe(DEFAULT_SETTINGS)
})

record('baseline tools are the two studio tools', () => {
  must(Array.isArray(BASELINE_TOOL_NAMES), 'BASELINE_TOOL_NAMES should be an array')
  must(BASELINE_TOOL_NAMES.includes(MANAGE_TOOL_NAME), 'baseline is missing the management tool')
  must(BASELINE_TOOL_NAMES.includes(UNLOCK_TOOL_NAME), 'baseline is missing the unlock tool')
  return BASELINE_TOOL_NAMES.join(', ')
})

record('computeDeny keeps baseline tools and unlocks by pack or single tool', () => {
  const records = [
    { id: 't_a', name: 'alpha', packId: 'p_1' },
    { id: 't_b', name: 'beta', packId: 'p_1' },
    { id: 't_c', name: 'gamma', packId: '' },
  ]
  const packs = [{ id: 'p_1', name: 'pack', alwaysUnlocked: false }]
  const base = [...BASELINE_TOOL_NAMES]
  const all = [...base, 'alpha', 'beta', 'gamma']

  const locked = computeDeny({ records, packs, liveNames: all, unlockedPackIds: [], unlockedToolIds: [], allowUngroupedUnlock: false })
  must(locked.includes('alpha') && locked.includes('gamma'), 'locked view should hide pack and ungrouped tools')
  must(!locked.includes(MANAGE_TOOL_NAME) && !locked.includes(UNLOCK_TOOL_NAME), 'baseline tools must never be denied')

  const packOpen = computeDeny({ records, packs, liveNames: all, unlockedPackIds: ['p_1'], unlockedToolIds: [], allowUngroupedUnlock: false })
  must(!packOpen.includes('alpha') && !packOpen.includes('beta'), 'an unlocked pack should reveal its members')
  must(packOpen.includes('gamma'), 'an ungrouped tool should stay hidden')

  const toolOpen = computeDeny({ records, packs, liveNames: all, unlockedPackIds: [], unlockedToolIds: ['t_c'], allowUngroupedUnlock: true })
  must(!toolOpen.includes('gamma'), 'an individually unlocked tool should become visible')
  const toolOff = computeDeny({ records, packs, liveNames: all, unlockedPackIds: [], unlockedToolIds: ['t_c'], allowUngroupedUnlock: false })
  must(toolOff.includes('gamma'), 'the single-tool switch must gate the remembered unlock')

  const always = computeDeny({ records, packs: [{ ...packs[0], alwaysUnlocked: true }], liveNames: all, unlockedPackIds: [], unlockedToolIds: [], allowUngroupedUnlock: false })
  must(!always.includes('alpha'), 'an always-unlocked pack should reveal its members')
  return `${locked.length}/${packOpen.length}/${toolOpen.length}`
})

record('buildUnlockTool exposes list/unlock/lock and the pack/tool target', () => {
  const unlock = buildUnlockTool(null, () => undefined)
  must(unlock.name === UNLOCK_TOOL_NAME, `unlock tool name: ${describe(unlock.name)}`)
  const actions = unlock.parameters?.properties?.action?.enum ?? []
  for (const action of ['list', 'unlock', 'lock']) must(actions.includes(action), `unlock tool is missing action "${action}"`)
  must(unlock.parameters.properties.pack !== undefined, 'unlock tool has no "pack" parameter')
  must(unlock.parameters.properties.tool !== undefined, 'unlock tool has no "tool" parameter')
  return actions.join('/')
})

record('per-session unlock state round-trips through unlocks.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'cts-selfcheck-unlock-'))
  try {
    const lib = createStore(root)
    const tool = lib.create({
      name: 'selfcheck_unlock_tool',
      description: '仅用于自检',
      code: 'def run(args):\n    return {"ok": True}\n',
    })
    const pack = lib.createPack({ name: '自检解锁包', tools: ['selfcheck_unlock_tool'] })
    must(lib.unlocks('session-a').packs.length === 0, 'new session should have no unlocks')
    lib.setUnlocks('session-a', { packs: [pack.id], tools: [tool.id] })
    const reopened = createStore(root).unlocks('session-a')
    must(reopened.packs[0] === pack.id, 'pack unlock did not persist')
    must(reopened.tools[0] === tool.id, 'single-tool unlock did not persist')
    lib.clearUnlocks('session-a')
    must(lib.unlocks('session-a').packs.length === 0, 'clearUnlocks did not clear the session')
    must(existsSync(join(root, 'unlocks.json')), 'unlocks.json was not written')
    return 'packs + tools persisted'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

record('prompt context lists packs only while unlock mode is on', () => {
  const packs = [{ id: 'p1', name: '自检包', alwaysUnlocked: false }]
  const records = [{ name: 'selfcheck_ctx_tool', packId: 'p1', enabled: true }]
  const on = buildPackContextText({ settings: DEFAULT_SETTINGS, packs, records })
  must(on === '', 'unlock mode is off by default, so the context must be empty')
  const text = buildPackContextText({ settings: { ...DEFAULT_SETTINGS, unlockMode: true }, packs, records })
  must(text.includes('自检包'), 'pack name missing from the prompt context')
  must(text.includes('selfcheck_ctx_tool'), 'pack member missing from the prompt context')
  return 'empty off / lists on'
})

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const failedChecks = CHECKS.filter((check) => !check.ok).map((check) => check.label)
if (failed === 0 && failedChecks.length === 0) {
  console.log('SELF-CHECK OK')
  process.exit(0)
}
console.log(`SELF-CHECK FAILED: ${failed} check(s) failed — ${failedChecks.join('; ')}`)
process.exit(1)

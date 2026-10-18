import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { runPython } from '../lib/python.js'
import { makeRoutes, ROUTES } from '../lib/routes.js'

const fails = []
const check = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

const root = mkdtempSync(join(tmpdir(), 'cts-routes-'))
const store = createStore(root)
let settingsState = store.settings()

/** Membership summary, mirroring the Host engine's decorator. */
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
const packByRef = (ref) => store.findPackByName(ref)
const requirePack = (ref) => {
  const pack = packByRef(ref)
  if (pack === undefined) throw new Error('工具包不存在（可能已被删除）')
  return pack
}

const engine = {
  paths: store.paths,
  pythonInfo: () => ({ ok: true, command: 'python', version: '3.12.10' }),
  list: () => store.list(),
  get: (id) => store.get(id),
  findByName: (name) => store.findByName(name),
  create: (input) => store.create(input),
  update: (id, patch) => store.update(id, patch),
  removeRecord: (id) => store.remove(id),
  setEnabled: (id, enabled) => store.setEnabled(id, enabled),
  listPacks: () => store.listPacks().map(decoratePack),
  getPack: (ref) => decoratePack(packByRef(ref)),
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
  getSettings: () => settingsState,
  setSettings: (patch) => {
    settingsState = store.saveSettings(patch)
    return settingsState
  },
  defaultSettings: () => ({
    unlockMode: false,
    allowUngroupedUnlock: false,
    approveCreate: false,
    approveUpdate: false,
    approveDelete: true,
  }),
  runRecord: (record, args) => runPython(record, args, { rootDir: root }),
}

const routes = makeRoutes(engine)
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no route' }))
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
console.log('base', base)

const call = async (path, body) => {
  const response = await fetch(`${base}${path}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: response.status, json }
}

const health = await call(ROUTES.health)
check('health', health.status === 200 && health.json.ok === true && health.json.pythonReady === true)
check('health paths', typeof health.json.paths.store === 'string')

const empty = await call(ROUTES.list)
check('list empty', empty.status === 200 && Array.isArray(empty.json.tools) && empty.json.tools.length === 0)
check(
  'list carries settings',
  empty.json.settings?.unlockMode === false
    && empty.json.settings?.allowUngroupedUnlock === false
    && empty.json.settings?.approveCreate === false
    && empty.json.settings?.approveDelete === true,
  JSON.stringify(empty.json.settings),
)

const settingsRead = await call(ROUTES.settings)
check(
  'settings GET defaults',
  settingsRead.status === 200
    && settingsRead.json.settings.unlockMode === false
    && settingsRead.json.settings.allowUngroupedUnlock === false
    && settingsRead.json.settings.approveDelete === true
    && settingsRead.json.defaults.unlockMode === false,
)

const settingsWrite = await call(ROUTES.settings, { unlockMode: true, allowUngroupedUnlock: true, approveCreate: true, approveDelete: false })
check(
  'settings POST',
  settingsWrite.status === 200
    && settingsWrite.json.settings.unlockMode === true
    && settingsWrite.json.settings.allowUngroupedUnlock === true
    && settingsWrite.json.settings.approveCreate === true
    && settingsWrite.json.settings.approveDelete === false,
  JSON.stringify(settingsWrite.json.settings),
)

const settingsAfter = await call(ROUTES.list)
check(
  'settings persisted into list',
  settingsAfter.json.settings.unlockMode === true
    && settingsAfter.json.settings.allowUngroupedUnlock === true
    && settingsAfter.json.settings.approveCreate === true
    && settingsAfter.json.settings.approveDelete === false,
)

const settingsIgnoreJunk = await call(ROUTES.settings, { approveUpdate: 'yes', nonsense: 1 })
check(
  'settings ignores non-booleans',
  settingsIgnoreJunk.json.settings.approveUpdate === false && !('nonsense' in settingsIgnoreJunk.json.settings),
)
// Restore the shipped defaults so the rest of the run matches them.
await call(ROUTES.settings, {
  unlockMode: false,
  allowUngroupedUnlock: false,
  approveCreate: false,
  approveUpdate: false,
  approveDelete: true,
})

const created = await call(ROUTES.create, {
  name: 'route_echo',
  title: '回声',
  description: '回显参数',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  code: 'def run(args):\n    return {"echo": args.get("text", "")}\n',
  dangerous: false,
  enabled: true,
})
check('create', created.status === 200 && created.json.tool.name === 'route_echo', created.status)
const id = created.json.tool.id

const dup = await call(ROUTES.create, {
  name: 'route_echo',
  description: 'dup',
  code: 'def run(a): return 1',
})
check('create duplicate -> 409', dup.status === 409 && typeof dup.json.error === 'string', `${dup.status} ${dup.json.error}`)

const badJson = await fetch(`${base}${ROUTES.create}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
check('bad json -> 400', badJson.status === 400)
await badJson.text()

const badName = await call(ROUTES.create, { name: 'Bad Name', description: 'x', code: 'def run(a): return 1' })
check('bad name -> 400', badName.status === 400, `${badName.status} ${badName.json.error}`)

const listed = await call(ROUTES.list)
check('list after create', listed.json.tools.length === 1 && listed.json.tools[0].name === 'route_echo')

const tested = await call(ROUTES.test, { id, args: { text: 'hi' } })
check('test route', tested.status === 200 && tested.json.ok === true && tested.json.result.echo === 'hi', JSON.stringify(tested.json.result))

const testedByName = await call(ROUTES.test, { name: 'route_echo', args: { text: 'yo' } })
check('test by name', testedByName.status === 200 && testedByName.json.result.echo === 'yo')

const testedMissing = await call(ROUTES.test, { id: 'nope' })
check('test unknown -> 404', testedMissing.status === 404)

const disabled = await call(ROUTES.setEnabled, { id, enabled: false })
check('set-enabled', disabled.status === 200 && disabled.json.tool.enabled === false)

const updated = await call(ROUTES.update, { id, title: '改名了', dangerous: true })
check('update', updated.status === 200 && updated.json.tool.title === '改名了' && updated.json.tool.dangerous === true)

const updatedEmpty = await call(ROUTES.update, {})
check('update without id -> 400', updatedEmpty.status === 400)

// ---- tool packs ----------------------------------------------------------
const packsEmpty = await call(ROUTES.packs)
check('packs GET empty', packsEmpty.status === 200 && Array.isArray(packsEmpty.json.packs) && packsEmpty.json.packs.length === 0)

const packCreated = await call(ROUTES.packCreate, {
  name: '演示包',
  description: '路由测试用的工具包',
  tools: ['route_echo'],
  alwaysUnlocked: true,
})
check(
  'pack create',
  packCreated.status === 200
    && packCreated.json.pack.name === '演示包'
    && packCreated.json.pack.toolCount === 1
    && packCreated.json.pack.tools[0] === 'route_echo'
    && packCreated.json.pack.alwaysUnlocked === true,
  JSON.stringify(packCreated.json.pack?.tools),
)
const packId = packCreated.json.pack.id

const packDup = await call(ROUTES.packCreate, { name: '演示包', description: 'dup' })
check('pack create duplicate -> 409', packDup.status === 409, `${packDup.status} ${packDup.json.error}`)

const packBadMember = await call(ROUTES.packCreate, { name: '空包', tools: ['nope_tool'] })
check('pack create unknown member -> 400', packBadMember.status === 400, `${packBadMember.status} ${packBadMember.json.error}`)
const packsAfterBad = await call(ROUTES.packs)
check('failed pack create leaves no pack', packsAfterBad.json.packs.length === 1)

const listWithPack = await call(ROUTES.list)
check('list carries packs', Array.isArray(listWithPack.json.packs) && listWithPack.json.packs[0].name === '演示包')
check('tool carries packId', listWithPack.json.tools[0].packId === packId)

const packUpdated = await call(ROUTES.packUpdate, {
  id: packId,
  name: '改名包',
  description: '改过描述',
  alwaysUnlocked: false,
})
check(
  'pack update',
  packUpdated.status === 200
    && packUpdated.json.pack.name === '改名包'
    && packUpdated.json.pack.description === '改过描述'
    && packUpdated.json.pack.alwaysUnlocked === false
    && packUpdated.json.pack.toolCount === 1,
)

const packUpdateMissing = await call(ROUTES.packUpdate, { id: 'p_missing', name: 'x' })
check('pack update unknown -> 404', packUpdateMissing.status === 404, `${packUpdateMissing.status}`)

const packOff = await call(ROUTES.packSetEnabled, { id: packId, enabled: false })
check('pack set-enabled off', packOff.status === 200 && packOff.json.pack.enabledCount === 0 && packOff.json.tools[0].enabled === false)

const afterOff = await call(ROUTES.list)
check('pack switch disables the member tool', afterOff.json.tools[0].enabled === false)

const packOn = await call(ROUTES.packSetEnabled, { id: packId, enabled: true })
check('pack set-enabled on', packOn.status === 200 && packOn.json.pack.enabledCount === 1 && packOn.json.tools[0].enabled === true)

const packRemoved = await call(ROUTES.packDelete, { id: packId })
check('pack delete', packRemoved.status === 200 && packRemoved.json.deleted === true && packRemoved.json.tools.length === 1)

const afterPackDelete = await call(ROUTES.list)
check('pack delete keeps the tool', afterPackDelete.json.tools.length === 1 && afterPackDelete.json.tools[0].packId === '')
check('pack delete removes the pack', afterPackDelete.json.packs.length === 0)

const removed = await call(ROUTES.delete, { id })
check('delete', removed.status === 200 && removed.json.deleted === true)

const listAfter = await call(ROUTES.list)
check('list after delete', listAfter.json.tools.length === 0)

const wrongMethod = await fetch(`${base}${ROUTES.create}`, { method: 'GET' })
check('wrong method -> 405', wrongMethod.status === 405)
await wrongMethod.text()

const missingRoute = await call('/api/custom-tool-studio/nope')
check('unknown route -> 404', missingRoute.status === 404)

server.close()
rmSync(root, { recursive: true, force: true })
console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILED: ${fails.join(', ')}`)
process.exit(fails.length === 0 ? 0 : 1)

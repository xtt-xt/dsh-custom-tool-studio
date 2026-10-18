import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const fails = []
const check = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

const ReactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    },
  }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useSyncExternalStore: () => 0,
}

let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ factory }) {
        captured = factory((name) => (name === 'react' ? ReactStub : (() => {})))
      },
    },
    console,
  },
  console,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

/** Render a node tree, invoking function components and every child. */
function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node.type === 'function') return render(node.type(node.props))
  return {
    type: node.type,
    props: { ...node.props, children: render(node.props?.children) },
  }
}

/** Depth-first collect rendered element nodes matching a predicate. */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  const children = node.props?.children
  if (children !== undefined) collect(children, predicate, out)
  return out
}

const cls = (node) => node?.props?.className ?? ''
const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node?.props?.children !== undefined) return textOf(node.props.children)
  return ''
}

const { SettingsDialog, StudioPage, ToolList, PackEditorDialog, DeletePackDialog, EditorDialog, groupTools } = captured?.__test ?? {}
check('SettingsDialog exported for test', typeof SettingsDialog === 'function')
check('pack components exported for test', typeof ToolList === 'function' && typeof PackEditorDialog === 'function' && typeof DeletePackDialog === 'function' && typeof groupTools === 'function')
const t = (key) => key

const apiCalls = []
const api = {
  saveSettings: async (patch) => {
    apiCalls.push(patch)
    return { settings: { ...patch } }
  },
}

// --- default settings ------------------------------------------------------
let tree
try {
  tree = render(SettingsDialog({ t, api, settings: { approveCreate: false, approveUpdate: false, approveDelete: true }, onClose() {}, onSaved() {} }))
  check('SettingsDialog renders without throwing', true)
} catch (error) {
  check('SettingsDialog renders without throwing', false, error.message)
}

check('renders the dialog shell', collect(tree, (node) => cls(node).split(' ').includes('cts-dialog')).length === 1)
check('renders the modal backdrop', collect(tree, (node) => cls(node) === 'cts-backdrop').length === 1)
check('dialog has role=dialog', collect(tree, (node) => node?.props?.role === 'dialog').length === 1)
check('dialog has a close button', collect(tree, (node) => cls(node).includes('cts-dialogClose')).length === 1)
check('title comes from the dictionary', textOf(collect(tree, (node) => cls(node) === 'cts-dialogTitle')[0]) === 'settings.title')

const switches = collect(tree, (node) => node?.props?.role === 'switch')
check('five global switches', switches.length === 5, String(switches.length))
const states = switches.map((node) => node.props['aria-checked'])
check(
  'defaults: unlock off, ungrouped off, create off, update off, delete on',
  switches.length === 5 && JSON.stringify(states) === JSON.stringify(['false', 'false', 'false', 'false', 'true']),
  states.join(','),
)

const labels = collect(tree, (node) => cls(node) === 'cts-switchLabel').map(textOf)
check(
  'switch labels',
  labels.join('|') === 'settings.unlockMode|settings.allowUngroupedUnlock|settings.approveCreate|settings.approveUpdate|settings.approveDelete',
  labels.join('|'),
)
const hints = collect(tree, (node) => cls(node) === 'cts-switchHint').map(textOf)
check('switch hints', hints.length === 5 && hints[0] === 'settings.unlockModeHint', hints.join('|'))

const footerButtons = collect(tree, (node) => node?.type === 'button' && (cls(node).includes('cts-primary') || cls(node).includes('cts-ghost')))
check('footer has exactly cancel + save', footerButtons.length === 2, String(footerButtons.length))
const saveButton = footerButtons.find((node) => cls(node).includes('cts-primary'))
check('save is the primary button', saveButton !== undefined && textOf(saveButton) === 'settings.save', saveButton === undefined ? '' : textOf(saveButton))
check('cancel uses the shared label', footerButtons.some((node) => textOf(node) === 'editor.cancel'))

// --- all off / untrusted ---------------------------------------------------
const allOff = render(SettingsDialog({
  t,
  api,
  settings: { unlockMode: false, allowUngroupedUnlock: false, approveCreate: false, approveUpdate: false, approveDelete: false },
  onClose() {},
  onSaved() {},
}))
const offStates = collect(allOff, (node) => node?.props?.role === 'switch').map((node) => node.props['aria-checked'])
check('all-off renders five "false"', offStates.length === 5 && offStates.every((value) => value === 'false'), offStates.join(','))

const untrusted = render(SettingsDialog({ t, api, settings: 'nonsense', onClose() {}, onSaved() {} }))
const untrustedStates = collect(untrusted, (node) => node?.props?.role === 'switch').map((node) => node.props['aria-checked'])
check(
  'untrusted settings fall back to defaults',
  JSON.stringify(untrustedStates) === JSON.stringify(['false', 'false', 'false', 'false', 'true']),
  untrustedStates.join(','),
)

const allOn = render(SettingsDialog({
  t,
  api,
  settings: { unlockMode: true, allowUngroupedUnlock: true, approveCreate: true, approveUpdate: true, approveDelete: true },
  onClose() {},
  onSaved() {},
}))
const onStates = collect(allOn, (node) => node?.props?.role === 'switch').map((node) => node.props['aria-checked'])
check('all-on renders five "true"', onStates.length === 5 && onStates.every((value) => value === 'true'), onStates.join(','))

// --- page header -----------------------------------------------------------
const locale = {
  bind: () => (key) => key,
  register: () => () => {},
  getSnapshot: () => ({ active: 'zh', revision: 1 }),
  subscribe: () => () => {},
}
const pageTree = render(StudioPage({ locale, api }))
const header = collect(pageTree, (node) => cls(node) === 'cts-headerActions')[0]
check('page header renders', header !== undefined)
const headerButtons = collect(header, (node) => node?.type === 'button')
check('header has settings / refresh / new-pack / new-tool', headerButtons.length === 4, String(headerButtons.length))
check('settings button is first', headerButtons.length === 4 && textOf(headerButtons[0]) === 'settings.button', headerButtons.map(textOf).join('|'))
check('new-pack button comes before new-tool', headerButtons.length === 4 && textOf(headerButtons[2]) === 'page.createPack', headerButtons.map(textOf).join('|'))
check('new-tool button is last', textOf(headerButtons[headerButtons.length - 1]) === 'page.create')
check('primary button carries the inverse label class', cls(headerButtons[headerButtons.length - 1]) === 'cts-primary')

// --- grouping --------------------------------------------------------------
const toolA = { id: 't_a', name: 'tool_a', description: 'A', enabled: true, dangerous: false }
const toolB = { id: 't_b', name: 'tool_b', description: 'B', enabled: false, dangerous: false }
const toolC = { id: 't_c', name: 'tool_c', description: 'C', enabled: true, dangerous: false }
const packOne = { id: 'p_1', name: '文本包', description: '处理文本', alwaysUnlocked: true }
const packTwo = { id: 'p_2', name: '空包', description: '' }
const grouped = groupTools(
  [{ ...toolA, packId: 'p_1' }, { ...toolB, packId: 'p_1' }, { ...toolC, packId: '' }],
  [packOne, packTwo],
)
check('groupTools one group per pack plus ungrouped', grouped.length === 3, String(grouped.length))
check('groupTools pack order follows the pack list', grouped[0].pack?.id === 'p_1' && grouped[1].pack?.id === 'p_2')
check('groupTools membership by packId', grouped[0].tools.length === 2 && grouped[0].tools[1].name === 'tool_b')
check('groupTools empty pack stays', grouped[1].tools.length === 0)
check('groupTools ungrouped last', grouped[2].pack === null && grouped[2].tools.length === 1 && grouped[2].tools[0].name === 'tool_c')

const noUngrouped = groupTools([{ ...toolA, packId: 'p_1' }], [packOne])
check('groupTools omits an empty ungrouped group', noUngrouped.length === 1 && noUngrouped[0].pack?.id === 'p_1')

const orphaned = groupTools([{ ...toolA, packId: 'p_gone' }], [])
check('groupTools still lists a tool whose pack vanished', orphaned.length === 1 && orphaned[0].pack === null && orphaned[0].tools.length === 1)

// --- grouped list rendering ------------------------------------------------
const noop = () => {}
const listProps = {
  t,
  groups: grouped,
  allowUngroupedUnlock: true,
  isPending: () => false,
  isPendingPack: () => false,
  onTogglePack: noop,
  onEditPack: noop,
  onDeletePack: noop,
  onTest: noop,
  onEdit: noop,
  onDelete: noop,
  onToggle: noop,
}
let listTree
try {
  listTree = render(ToolList(listProps))
  check('ToolList renders without throwing', true)
} catch (error) {
  check('ToolList renders without throwing', false, error.message)
}
const cards = collect(listTree, (node) => cls(node).split(' ').includes('cts-card'))
check('one card per group', cards.length === 3, String(cards.length))
check('pack cards carry data-pack-id', cards[0].props['data-pack-id'] === 'p_1' && cards[2].props['data-pack-id'] === 'ungrouped')
const packNames = collect(listTree, (node) => cls(node) === 'cts-packName').map(textOf)
check('pack names rendered', packNames.join('|') === '文本包|空包|pack.ungrouped', packNames.join('|'))
const packDescs = collect(listTree, (node) => cls(node) === 'cts-packDesc').map(textOf)
check('pack description rendered, empty one omitted', packDescs.length === 1 && packDescs[0] === '处理文本', packDescs.join('|'))
const countBadges = collect(listTree, (node) => cls(node) === 'cts-badge' && textOf(node) === 'pack.count')
check('count badge per group', countBadges.length === 3, String(countBadges.length))

const alwaysUnlockedBadges = collect(listTree, (node) => cls(node) === 'cts-badge' && textOf(node) === 'pack.alwaysUnlocked')
check('always-unlocked pack gets a badge', alwaysUnlockedBadges.length === 1, String(alwaysUnlockedBadges.length))
const ungroupedUnlockBadges = collect(listTree, (node) => cls(node) === 'cts-badge' && textOf(node) === 'pack.ungroupedUnlockable')
check('ungrouped card shows the single-tool badge when enabled', ungroupedUnlockBadges.length === 1, String(ungroupedUnlockBadges.length))

const packSwitches = collect(listTree, (node) => node?.props?.role === 'switch' && node.props['aria-label'] === 'pack.toggle')
const rowSwitches = collect(listTree, (node) => node?.props?.role === 'switch' && node.props['aria-label'] === 'row.toggle')
check('pack groups have a switch, ungrouped does not', packSwitches.length === 2, String(packSwitches.length))
check('every tool row keeps its own switch', rowSwitches.length === 3, String(rowSwitches.length))
check('partially-enabled pack renders off', packSwitches[0].props['aria-checked'] === 'false', packSwitches[0].props['aria-checked'])
const mixedBadge = collect(listTree, (node) => cls(node) === 'cts-badge cts-badgeMixed')
check('mixed state gets a badge', mixedBadge.length === 1, String(mixedBadge.length))
check('empty pack switch is disabled', packSwitches[1].props.disabled === true)

const packEditButtons = collect(listTree, (node) => node?.type === 'button' && textOf(node) === 'pack.edit')
const packDeleteButtons = collect(listTree, (node) => node?.type === 'button' && textOf(node) === 'pack.delete')
check('pack edit/delete buttons per pack', packEditButtons.length === 2 && packDeleteButtons.length === 2, `${packEditButtons.length}/${packDeleteButtons.length}`)
const emptyNote = collect(listTree, (node) => cls(node) === 'cts-packEmpty').map(textOf)
check('empty pack shows the hint', emptyNote.includes('pack.empty'), emptyNote.join('|'))
check('ungrouped header has no switch', collect(listTree, (node) => cls(node) === 'cts-listHead' && textOf(node).includes('pack.ungrouped')).length === 1)

// --- pack editor -----------------------------------------------------------
const packEditorTree = render(PackEditorDialog({
  t,
  api: { createPack: async () => ({ pack: {} }), updatePack: async () => ({ pack: {} }) },
  mode: 'edit',
  pack: { ...packOne, id: 'p_1' },
  tools: [{ ...toolA, packId: 'p_1' }, { ...toolB, packId: 'p_1' }, { ...toolC, packId: '' }],
  onClose: noop,
  onSaved: noop,
}))
const packEditorInputs = collect(packEditorTree, (node) => node?.type === 'input' && node.props.type === undefined)
check('pack editor has name + description inputs', packEditorInputs.length === 2, String(packEditorInputs.length))
check('pack editor seeds the name', packEditorInputs[0].props.value === '文本包')
check('pack editor seeds the description', packEditorInputs[1].props.value === '处理文本')
const checkboxes = collect(packEditorTree, (node) => node?.type === 'input' && node.props.type === 'checkbox')
check('one checkbox per tool', checkboxes.length === 3, String(checkboxes.length))
check('members preselected from packId', JSON.stringify(checkboxes.map((node) => node.props.checked)) === JSON.stringify([true, true, false]), checkboxes.map((node) => node.props.checked).join(','))
const packEditorSwitches = collect(packEditorTree, (node) => node?.props?.role === 'switch')
check(
  'pack editor exposes one always-unlocked switch, seeded from the pack',
  packEditorSwitches.length === 1
    && packEditorSwitches[0].props['aria-label'] === 'packEditor.alwaysUnlocked'
    && packEditorSwitches[0].props['aria-checked'] === 'true',
  `${packEditorSwitches.length}/${packEditorSwitches[0]?.props?.['aria-checked']}`,
)
const packEditorFooter = collect(packEditorTree, (node) => node?.type === 'button' && (cls(node).includes('cts-primary') || cls(node).includes('cts-ghost')))
check('pack editor footer cancel + save', packEditorFooter.length === 2 && textOf(packEditorFooter[1]) === 'packEditor.saveEdit', packEditorFooter.map(textOf).join('|'))

const emptyPackEditor = render(PackEditorDialog({
  t,
  api: { createPack: async () => ({ pack: {} }), updatePack: async () => ({ pack: {} }) },
  mode: 'create',
  pack: null,
  tools: [],
  onClose: noop,
  onSaved: noop,
}))
check('create mode has no preselected member', collect(emptyPackEditor, (node) => node?.props?.type === 'checkbox').length === 0)
check('empty tool list shows its hint', collect(emptyPackEditor, (node) => cls(node) === 'cts-checkEmpty').length === 1)
check('create mode save label', textOf(collect(emptyPackEditor, (node) => node?.type === 'button' && cls(node).includes('cts-primary'))[0]) === 'packEditor.saveCreate')

// --- delete pack -----------------------------------------------------------
const deletePackTree = render(DeletePackDialog({
  t,
  api: { removePack: async () => ({ deleted: true, pack: {}, tools: [] }) },
  pack: { id: 'p_1', name: '文本包' },
  memberCount: 2,
  onClose: noop,
  onDeleted: noop,
}))
check('delete pack dialog title', textOf(collect(deletePackTree, (node) => cls(node) === 'cts-dialogTitle')[0]) === 'deletePack.title')
check('delete pack names the pack', textOf(collect(deletePackTree, (node) => cls(node) === 'cts-confirmTitle')[0]) === 'deletePack.target')
const deletePackButtons = collect(deletePackTree, (node) => node?.type === 'button')
check('delete pack confirm button', deletePackButtons.some((node) => textOf(node) === 'deletePack.confirm'))

// --- tool editor pack select ----------------------------------------------
const editorTree = render(EditorDialog({
  t,
  api: { create: async () => ({}), update: async () => ({}) },
  mode: 'edit',
  record: { ...toolA, packId: 'p_1', parameters: { type: 'object', properties: {} }, code: 'def run(a):\n    return 1\n' },
  packs: [packOne, packTwo],
  onClose: noop,
  onSaved: noop,
}))
const selects = collect(editorTree, (node) => node?.type === 'select')
check('tool editor has a pack select', selects.length === 1, String(selects.length))
check('pack select preselects the record pack', selects[0].props.value === 'p_1', String(selects[0].props.value))
const options = collect(selects[0], (node) => node?.type === 'option')
check('pack select lists "no pack" plus every pack', options.length === 3, String(options.length))
check('first option is "no pack"', textOf(options[0]) === 'editor.packNone')
check('pack options carry ids', options[1].props.value === 'p_1' && options[2].props.value === 'p_2')

const unused = render(EditorDialog({
  t,
  api: { create: async () => ({}), update: async () => ({}) },
  mode: 'create',
  record: null,
  packs: [{ id: 'p_9', name: '别的包' }],
  onClose: noop,
  onSaved: noop,
}))
const unusedSelect = collect(unused, (node) => node?.type === 'select')[0]
check('new tool defaults to no pack', unusedSelect.props.value === '', String(unusedSelect.props.value))
check('new tool still lists the packs', collect(unusedSelect, (node) => node?.type === 'option').length === 2)

console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILED: ${fails.join(', ')}`)
process.exit(fails.length === 0 ? 0 : 1)

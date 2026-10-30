/**
 * dsh-go native front end for the custom tool studio.
 *
 * The Web page in `client.js` cannot render inside the dsh-go app: the app
 * only draws declarative JSON views and calls back into this process. This
 * module registers that native surface with the `dshGo` service:
 *
 *  - a status strip above the composer ("工具 3 · 启用 2"),
 *  - four panels: tools + packs list, tool detail + edit (also used to
 *    create), pack detail, settings,
 *  - two composer actions: "新建工具" and "工具".
 *
 * View v2 (styles, native forms) is used when the app advertises those
 * components; older apps get a v1 summary without the forms. Everything runs
 * in the host process and reuses the same `engine` the Web page and
 * `custom_tool_manage` use, so registration, packs, approval gating and
 * storage stay in one place.
 *
 * The v2 renderer puts content inside the app's fixed plugin surface
 * (#272A33 dark / #F8FAFE light). Plugins cannot tint or make it transparent;
 * the only theme-following token is `accent: 'app'`, so that is used for the
 * accent while the content surface stays the app default.
 */

const PANEL_STUDIO = 'studio'
const PANEL_TOOL = 'tool'
const PANEL_PACK = 'pack'
const PANEL_SETTINGS = 'settings'
const STRIP_ID = 'studio-count'

const DEFAULT_CODE = 'def run(args):\n    return {"ok": True}\n'
const DEFAULT_PARAMETERS = '{\n  "type": "object",\n  "properties": {}\n}'

const zh = (locale) => !String(locale ?? '').startsWith('en')
const pick = (locale, z, e) => (zh(locale) ? z : e)
const text = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

function formValues(event) {
  const value = event?.value
  if (value !== null && typeof value === 'object' && value.values !== null && typeof value.values === 'object') {
    return value.values
  }
  return {}
}

/** Read one bound form field from `{ values: { 'data.form.x': … } }`. */
function field(values, path) {
  const dotted = `data.${path}`
  if (Object.prototype.hasOwnProperty.call(values, dotted)) return values[dotted]
  return values[path]
}

function defaultForm() {
  return {
    name: '',
    title: '',
    description: '',
    parameters: DEFAULT_PARAMETERS,
    code: DEFAULT_CODE,
    dangerous: false,
    packId: '__none__',
  }
}

/** `packId` in the form uses `__none__` because option values cannot be empty. */
const packRef = (value) => {
  const id = typeof value === 'string' ? value.trim() : ''
  return id === '' || id === '__none__' ? '' : id
}

function parseParameters(raw) {
  const source = text(raw).trim()
  if (source === '') return { type: 'object', properties: {}, additionalProperties: true }
  try {
    const parsed = JSON.parse(source)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('parameters')
    return parsed
  } catch {
    throw new Error('PARAMETERS_JSON')
  }
}

function formatTime(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function mountDshGo(ctx, { engine }) {
  const dshGo = ctx.dshGo

  /** Selection and drafts; custom tools are host-wide, not per conversation. */
  const state = {
    selectedId: null,
    selectedPackId: null,
    edit: defaultForm(),
    packForm: { name: '', description: '', alwaysUnlocked: false },
  }
  const panelEmitters = new Set()
  const stripUpdaters = new Set()

  const packList = () => engine.listPacks()
  const packName = (packs, id) => {
    const pack = packs.find((entry) => entry.id === id)
    return pack === undefined ? '' : text(pack.name)
  }

  function statusOf(record, locale) {
    if (record.enabled === false) return pick(locale, '已停用', 'Off')
    if (record.registered !== true) return pick(locale, '未注册', 'Not registered')
    return pick(locale, '启用', 'On')
  }

  function editOf(record) {
    return {
      name: text(record.name),
      title: text(record.title),
      description: text(record.description),
      parameters: JSON.stringify(record.parameters ?? {}, null, 2).slice(0, 2000),
      code: text(record.code).slice(0, 2000),
      dangerous: record.dangerous === true,
      packId: record.packId === '' || record.packId === undefined ? '__none__' : record.packId,
    }
  }

  function buildRows(records, packs, locale) {
    return records.map((record) => {
      const packLabel = packName(packs, record.packId)
      const parts = [text(record.name)]
      if (record.dangerous === true) parts.push(pick(locale, '危险', 'danger'))
      if (packLabel !== '') parts.push(packLabel)
      if (typeof record.registrationError === 'string') parts.push(pick(locale, '注册失败', 'failed'))
      return {
        title: text(record.title) || text(record.name),
        subtitle: parts.join(' · '),
        trailing: statusOf(record, locale),
        icon: record.dangerous === true ? 'warning' : 'tool',
        tone: typeof record.registrationError === 'string' ? 'bad' : record.enabled === false ? 'muted' : record.dangerous === true ? 'warn' : 'good',
        action: { id: 'select', args: { id: record.id } },
      }
    })
  }

  function buildDetail(record, packs, locale) {
    if (record === undefined) {
      return [[pick(locale, '提示', 'Tip'), pick(locale, '到「编辑」页签填写后保存即可新建', 'Fill the Edit tab and save to create')]]
    }
    const rows = [
      [pick(locale, '工具名', 'Name'), text(record.name)],
      [pick(locale, '标题', 'Title'), text(record.title) || text(record.name)],
      [pick(locale, '状态', 'Status'), statusOf(record, locale)],
      [pick(locale, '危险工具', 'Dangerous'), record.dangerous === true ? pick(locale, '是', 'yes') : pick(locale, '否', 'no')],
      [pick(locale, '工具包', 'Pack'), packName(packs, record.packId) || pick(locale, '未分组', 'ungrouped')],
    ]
    if (typeof record.registrationError === 'string') rows.push([pick(locale, '注册错误', 'Error'), text(record.registrationError)])
    const updated = formatTime(record.updatedAt)
    if (updated !== '') rows.push([pick(locale, '最近修改', 'Updated'), updated])
    return rows
  }

  function buildPackRows(packs, locale) {
    return packs.map((pack) => ({
      title: text(pack.name),
      subtitle: pick(locale, `${pack.toolCount} 个工具 · 启用 ${pack.enabledCount}`, `${pack.toolCount} tools · ${pack.enabledCount} on`) + (pack.alwaysUnlocked === true ? ` · ${pick(locale, '始终解锁', 'always unlocked')}` : ''),
      trailing: pack.allEnabled === true ? pick(locale, '启用', 'On') : pick(locale, '停用', 'Off'),
      icon: 'puzzle',
      tone: pack.allEnabled === true ? 'good' : 'muted',
      action: { id: 'selectPack', args: { id: pack.id } },
    }))
  }

  function buildPackOptions(packs, locale) {
    return [{ label: pick(locale, '不分组', 'Ungrouped'), value: '__none__' }].concat(
      packs.map((pack) => ({ label: text(pack.name), value: pack.id })),
    )
  }

  function snapshot(scope, locale) {
    const records = engine.list()
    const packs = packList()
    const selected = records.find((record) => record.id === state.selectedId)
    const selectedPack = packs.find((pack) => pack.id === state.selectedPackId)
    if (selected === undefined && state.selectedId !== null) state.selectedId = null
    if (selectedPack === undefined && state.selectedPackId !== null) state.selectedPackId = null
    const enabled = records.filter((record) => record.enabled !== false).length
    const python = engine.pythonInfo()
    const notice = python.ok === true ? '' : pick(locale, `未检测到 Python，工具无法执行。${text(python.error)}`, `Python not found; tools cannot run. ${text(python.error)}`)
    const creating = selected === undefined
    const selectedTitle = creating ? pick(locale, '新建工具', 'New tool') : text(selected.title) || text(selected.name)
    const selectedSub = creating
      ? pick(locale, '在「编辑」页签填写，保存即注册', 'Fill the Edit tab; saving registers it')
      : [text(selected.name), statusOf(selected, locale)]
        .concat(selected.dangerous === true ? [pick(locale, '危险', 'danger')] : [])
        .concat([packName(packs, selected.packId) || pick(locale, '未分组', 'ungrouped')])
        .join(' · ')
    const packMembers = selectedPack === undefined ? [] : records.filter((record) => record.packId === selectedPack.id)
    return {
      header: pick(locale, `${records.length} 个工具 · ${enabled} 启用`, `${records.length} tools · ${enabled} on`),
      notice,
      hint: records.length === 0 ? pick(locale, '还没有工具，点「新建工具」开始。', 'No tools yet. Tap "New tool".') : '',
      rows: buildRows(records, packs, locale),
      detail: buildDetail(selected, packs, locale),
      toolTitle: selectedTitle,
      toolSub: selectedSub,
      packRows: buildPackRows(packs, locale),
      packTitle: selectedPack === undefined ? pick(locale, '未选中工具包', 'No pack selected') : text(selectedPack.name),
      packSub: selectedPack === undefined
        ? pick(locale, '返回「工具包」页签点一行', 'Go back to the Packs tab and tap one')
        : pick(locale, `${selectedPack.toolCount} 个工具 · 启用 ${selectedPack.enabledCount}`, `${selectedPack.toolCount} tools · ${selectedPack.enabledCount} on`)
          + (selectedPack.alwaysUnlocked === true ? ` · ${pick(locale, '始终解锁', 'always unlocked')}` : ''),
      packEnabled: selectedPack === undefined ? false : selectedPack.allEnabled === true,
      packTools: buildRows(packMembers, packs, locale),
      settings: engine.getSettings(),
      sysDetail: [
        [pick(locale, 'Python', 'Python'), python.ok === true ? pick(locale, '正常', 'ready') : pick(locale, '未检测到', 'missing')],
        [pick(locale, '数据目录', 'Data directory'), text(engine.paths.root)],
      ],
      edit: state.edit,
      packForm: state.packForm,
    }
  }

  function broadcast() {
    for (const entry of panelEmitters) {
      try {
        const next = snapshot(entry.scope, entry.locale)
        const encoded = JSON.stringify(next)
        if (encoded !== entry.last) {
          entry.last = encoded
          entry.emit(next)
        }
      } catch {
        /* a single broken feed must not stop the others */
      }
    }
    for (const update of stripUpdaters) {
      try {
        update()
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------ views

  const canForms = (caps) => {
    const components = Array.isArray(caps?.components) ? caps.components : []
    return ['form', 'tabs', 'textField', 'toggle', 'select'].every((name) => components.includes(name))
  }

  const rootStyle = () => ({ gap: 'M', padding: 'S' })

  function formFields(locale, prefix, packs) {
    return [
      { type: 'textField', label: pick(locale, '工具名', 'Tool name'), bind: `data.${prefix}.name`, required: true, minLength: 2, maxLength: 48, placeholder: 'my_tool' },
      { type: 'textField', label: pick(locale, '标题', 'Title'), bind: `data.${prefix}.title`, maxLength: 80 },
      { type: 'textField', label: pick(locale, '描述（模型据此选择）', 'Description (the model picks by this)'), bind: `data.${prefix}.description`, required: true, multiline: true, maxLines: 3, maxLength: 500 },
      { type: 'textField', label: pick(locale, '参数 JSON Schema', 'Parameters JSON Schema'), bind: `data.${prefix}.parameters`, multiline: true, maxLines: 5, maxLength: 2000 },
      { type: 'textField', label: pick(locale, 'Python 代码', 'Python code'), bind: `data.${prefix}.code`, required: true, multiline: true, maxLines: 6, maxLength: 2000 },
      { type: 'toggle', label: pick(locale, '危险工具（每次执行前审批）', 'Dangerous (approve every run)'), bind: `data.${prefix}.dangerous` },
      { type: 'select', label: pick(locale, '工具包', 'Pack'), bind: `data.${prefix}.packId`, options: buildPackOptions(packs, locale) },
    ]
  }

  function studioView(caps) {
    const locale = caps?.locale
    if (!canForms(caps)) {
      return {
        type: 'stack',
        title: pick(locale, '自定义工具', 'Custom tools'),
        children: [
          { type: 'text', text: { $: 'data.header' } },
          { type: 'text', text: { $: 'data.notice' }, tone: 'muted' },
          { type: 'list', items: { $: 'data.rows' } },
          { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
          { type: 'actions', items: [{ label: pick(locale, '新建工具', 'New tool'), icon: 'add', action: 'newTool' }] },
        ],
      }
    }
    const packs = packList()
    return {
      v: 2,
      accent: 'app',
      type: 'stack',
      style: rootStyle(),
      children: [
        {
          type: 'tabs',
          items: [
            {
              label: pick(locale, '工具', 'Tools'),
              children: [
                { type: 'text', text: { $: 'data.header' }, style: { size: 'subtitle', weight: 'semibold' } },
                { type: 'text', text: { $: 'data.notice' }, tone: 'muted', style: { size: 'caption' } },
                { type: 'stack', style: { card: 'surface', padding: 'S' }, children: [{ type: 'list', items: { $: 'data.rows' } }] },
                { type: 'text', text: { $: 'data.hint' }, tone: 'muted', style: { size: 'caption' } },
                {
                  type: 'actions',
                  items: [
                    { label: pick(locale, '新建工具', 'New tool'), icon: 'add', action: 'newTool' },
                    { label: pick(locale, '设置', 'Settings'), icon: 'settings', action: 'settings' },
                  ],
                },
              ],
            },
            {
              label: pick(locale, '工具包', 'Packs'),
              children: [
                { type: 'text', text: pick(locale, '点一行进入工具包；开关在详情页。', 'Tap a pack to open it; its switch is on the detail page.'), tone: 'muted', style: { size: 'caption' } },
                { type: 'stack', style: { card: 'surface', padding: 'S' }, children: [{ type: 'list', items: { $: 'data.packRows' } }] },
                {
                  type: 'form',
                  submit: 'createPack',
                  submitLabel: pick(locale, '新建工具包', 'Create pack'),
                  children: [
                    { type: 'textField', label: pick(locale, '工具包名称', 'Pack name'), bind: 'data.packForm.name', required: true, maxLength: 48 },
                    { type: 'textField', label: pick(locale, '描述', 'Description'), bind: 'data.packForm.description', multiline: true, maxLines: 2, maxLength: 500 },
                    { type: 'toggle', label: pick(locale, '始终解锁', 'Always unlocked'), bind: 'data.packForm.alwaysUnlocked' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
  }

  function toolView(caps) {
    const locale = caps?.locale
    if (!canForms(caps)) {
      return {
        type: 'stack',
        title: pick(locale, '工具', 'Tool'),
        children: [
          { type: 'text', text: { $: 'data.toolTitle' } },
          { type: 'text', text: { $: 'data.toolSub' }, tone: 'muted' },
          { type: 'keyValue', items: { $: 'data.detail' } },
          { type: 'actions', items: [
            { label: pick(locale, '切换启停', 'Toggle on/off'), icon: 'refresh', action: 'toggleEnabled' },
            { label: pick(locale, '试运行', 'Test'), icon: 'play-video', action: 'test' },
          ] },
          { type: 'text', text: pick(locale, '删除这个工具（不可恢复）', 'Delete this tool (permanent)'), tone: 'muted' },
          { type: 'confirm', id: 'deleteConfirm', confirmLabel: pick(locale, '删除', 'Delete'), cancelLabel: pick(locale, '取消', 'Cancel') },
        ],
      }
    }
    const packs = packList()
    return {
      v: 2,
      accent: 'app',
      type: 'stack',
      style: rootStyle(),
      children: [
        { type: 'text', text: { $: 'data.toolTitle' }, style: { size: 'title', weight: 'bold' } },
        { type: 'text', text: { $: 'data.toolSub' }, tone: 'muted', style: { size: 'caption' } },
        {
          type: 'tabs',
          items: [
            {
              label: pick(locale, '详情', 'Details'),
              children: [
                { type: 'stack', style: { card: 'surface', padding: 'S' }, children: [{ type: 'keyValue', items: { $: 'data.detail' } }] },
                { type: 'actions', items: [
                  { label: pick(locale, '切换启停', 'Toggle on/off'), icon: 'refresh', action: 'toggleEnabled' },
                  { label: pick(locale, '试运行', 'Test'), icon: 'play-video', action: 'test' },
                ] },
                { type: 'text', text: pick(locale, '删除这个工具（不可恢复）', 'Delete this tool (permanent)'), tone: 'muted', style: { size: 'caption' } },
                { type: 'confirm', id: 'deleteConfirm', confirmLabel: pick(locale, '删除', 'Delete'), cancelLabel: pick(locale, '取消', 'Cancel') },
              ],
            },
            {
              label: pick(locale, '编辑', 'Edit'),
              children: [
                { type: 'form', submit: 'saveTool', submitLabel: pick(locale, '保存', 'Save'), children: formFields(locale, 'edit', packs) },
              ],
            },
          ],
        },
      ],
    }
  }

  function packView(caps) {
    const locale = caps?.locale
    if (!canForms(caps)) {
      return {
        type: 'stack',
        title: pick(locale, '工具包', 'Pack'),
        children: [
          { type: 'text', text: { $: 'data.packTitle' } },
          { type: 'text', text: { $: 'data.packSub' }, tone: 'muted' },
          { type: 'list', items: { $: 'data.packTools' } },
        ],
      }
    }
    return {
      v: 2,
      accent: 'app',
      type: 'stack',
      style: rootStyle(),
      children: [
        { type: 'text', text: { $: 'data.packTitle' }, style: { size: 'title', weight: 'bold' } },
        { type: 'text', text: { $: 'data.packSub' }, tone: 'muted', style: { size: 'caption' } },
        { type: 'toggle', label: pick(locale, '启用整包', 'Enable pack'), bind: 'data.packEnabled', onChange: 'togglePack' },
        { type: 'stack', style: { card: 'surface', padding: 'S' }, children: [{ type: 'list', items: { $: 'data.packTools' } }] },
        { type: 'text', text: pick(locale, '删除工具包不会删掉里面的工具', 'Deleting a pack keeps its tools'), tone: 'muted', style: { size: 'caption' } },
        { type: 'confirm', id: 'deletePackConfirm', confirmLabel: pick(locale, '删除', 'Delete'), cancelLabel: pick(locale, '取消', 'Cancel') },
      ],
    }
  }

  function settingsView(caps) {
    const locale = caps?.locale
    if (!canForms(caps)) {
      return {
        type: 'stack',
        title: pick(locale, '设置', 'Settings'),
        children: [
          { type: 'text', text: pick(locale, '旧版 App 不支持在这里改设置，请在 Web 版设置页修改。', 'This app version cannot edit settings here; use the Web page.'), tone: 'muted' },
          { type: 'keyValue', items: { $: 'data.sysDetail' } },
        ],
      }
    }
    return {
      v: 2,
      accent: 'app',
      type: 'stack',
      style: rootStyle(),
      children: [
        { type: 'text', text: pick(locale, '设置', 'Settings'), style: { size: 'title', weight: 'bold' } },
        { type: 'text', text: pick(locale, '和 Web 版「设置」是同一份开关。', 'The same switches as the Web page settings.'), tone: 'muted', style: { size: 'caption' } },
        {
          type: 'form',
          submit: 'saveSettings',
          submitLabel: pick(locale, '保存设置', 'Save settings'),
          children: [
            { type: 'toggle', label: pick(locale, 'AI 主动解锁模式', 'Deferred unlock mode'), bind: 'data.settings.unlockMode' },
            { type: 'toggle', label: pick(locale, '允许单独解锁未分组工具', 'Allow unlocking ungrouped tools'), bind: 'data.settings.allowUngroupedUnlock' },
            { type: 'toggle', label: pick(locale, '创建前审批', 'Approve before create'), bind: 'data.settings.approveCreate' },
            { type: 'toggle', label: pick(locale, '修改前审批', 'Approve before update'), bind: 'data.settings.approveUpdate' },
            { type: 'toggle', label: pick(locale, '删除前审批', 'Approve before delete'), bind: 'data.settings.approveDelete' },
          ],
        },
        { type: 'stack', style: { card: 'surface', padding: 'S' }, children: [{ type: 'keyValue', items: { $: 'data.sysDetail' } }] },
      ],
    }
  }

  // ---------------------------------------------------------------- helpers

  function selectedRecord() {
    if (state.selectedId === null) return undefined
    return engine.list().find((record) => record.id === state.selectedId)
  }

  function toast(locale, z, e) {
    return { toast: pick(locale, z, e).slice(0, 40) }
  }

  function failToast(locale, error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'PARAMETERS_JSON') return { toast: pick(locale, '参数不是合法的 JSON', 'Parameters are not valid JSON') }
    return { toast: message.slice(0, 40) }
  }

  // --------------------------------------------------------------- actions

  const actions = {
    select(scope, event) {
      const id = event?.value?.id
      const record = engine.list().find((entry) => entry.id === id)
      if (record === undefined) return toast(event?.locale, '工具不存在，可能已被删除', 'Tool not found')
      state.selectedId = record.id
      state.edit = editOf(record)
      broadcast()
      return { open: `panel:${PANEL_TOOL}` }
    },

    selectPack(scope, event) {
      const id = event?.value?.id
      const pack = packList().find((entry) => entry.id === id)
      if (pack === undefined) return toast(event?.locale, '工具包不存在，可能已被删除', 'Pack not found')
      state.selectedPackId = pack.id
      broadcast()
      return { open: `panel:${PANEL_PACK}` }
    },

    newTool() {
      state.selectedId = null
      state.edit = defaultForm()
      broadcast()
      return { open: `panel:${PANEL_TOOL}` }
    },

    settings() {
      return { open: `panel:${PANEL_SETTINGS}` }
    },

    toggleEnabled(scope, event) {
      const record = selectedRecord()
      if (record === undefined) return toast(event?.locale, '请先在列表里选中一个工具', 'Select a tool first')
      try {
        const enabled = record.enabled === false
        engine.setEnabled(record.id, enabled)
        broadcast()
        return toast(event?.locale, enabled ? '已启用' : '已停用', enabled ? 'Enabled' : 'Disabled')
      } catch (error) {
        return failToast(event?.locale, error)
      }
    },

    test(scope, event) {
      const record = selectedRecord()
      if (record === undefined) return toast(event?.locale, '请先在列表里选中一个工具', 'Select a tool first')
      return {
        insert: pick(
          event?.locale,
          `用 custom_tool_manage 测试工具 ${record.name}：action="test"，args 按它的参数填好。`,
          `Use custom_tool_manage to test ${record.name}: action="test" with its args.`,
        ).slice(0, 2000),
      }
    },

    deleteConfirm(scope, event) {
      if (event?.value?.confirmed !== true) return toast(event?.locale, '已取消', 'Cancelled')
      const record = selectedRecord()
      if (record === undefined) return toast(event?.locale, '请先在列表里选中一个工具', 'Select a tool first')
      try {
        engine.removeRecord(record.id)
        state.selectedId = null
        state.edit = defaultForm()
        broadcast()
        return [{ toast: pick(event?.locale, '已删除', 'Deleted') }, { open: `panel:${PANEL_STUDIO}` }]
      } catch (error) {
        return failToast(event?.locale, error)
      }
    },

    saveTool(scope, event) {
      const locale = event?.locale
      const values = formValues(event)
      const input = {
        name: text(field(values, 'edit.name')).trim(),
        title: text(field(values, 'edit.title')).trim(),
        description: text(field(values, 'edit.description')).trim(),
        parameters: parseParameters(field(values, 'edit.parameters')),
        code: text(field(values, 'edit.code')),
        dangerous: field(values, 'edit.dangerous') === true,
        packId: packRef(field(values, 'edit.packId')),
      }
      const record = selectedRecord()
      try {
        if (record === undefined) {
          const created = engine.create({ ...input, enabled: true })
          state.selectedId = created.id
          state.edit = editOf(created)
          broadcast()
          return toast(locale, `已创建 ${created.name}`, `Created ${created.name}`)
        }
        const updated = engine.update(record.id, input)
        state.edit = editOf(updated)
        broadcast()
        return toast(locale, '已保存', 'Saved')
      } catch (error) {
        return failToast(locale, error)
      }
    },

    deletePackConfirm(scope, event) {
      if (event?.value?.confirmed !== true) return toast(event?.locale, '已取消', 'Cancelled')
      const pack = packList().find((entry) => entry.id === state.selectedPackId)
      if (pack === undefined) return toast(event?.locale, '请先在列表里选中一个工具包', 'Select a pack first')
      try {
        engine.removePack(pack.id)
        state.selectedPackId = null
        broadcast()
        return [{ toast: pick(event?.locale, '已删除工具包', 'Pack deleted') }, { open: `panel:${PANEL_STUDIO}` }]
      } catch (error) {
        return failToast(event?.locale, error)
      }
    },

    createPack(scope, event) {
      const locale = event?.locale
      const values = formValues(event)
      try {
        const pack = engine.createPack({
          name: text(field(values, 'packForm.name')).trim(),
          description: text(field(values, 'packForm.description')).trim(),
          alwaysUnlocked: field(values, 'packForm.alwaysUnlocked') === true,
        })
        state.packForm = { name: '', description: '', alwaysUnlocked: false }
        broadcast()
        return toast(locale, `已创建 ${pack.name}`, `Created ${pack.name}`)
      } catch (error) {
        return failToast(locale, error)
      }
    },

    togglePack(scope, event) {
      const locale = event?.locale
      const pack = packList().find((entry) => entry.id === state.selectedPackId)
      if (pack === undefined) return toast(locale, '请先在列表里选中一个工具包', 'Select a pack first')
      const value = event?.value
      const enabled = typeof value?.value === 'boolean' ? value.value : typeof value?.bind === 'string' ? value.value === true : pack.allEnabled !== true
      try {
        engine.setPackEnabled(pack.id, enabled)
        broadcast()
        return { patch: { packEnabled: enabled } }
      } catch (error) {
        return failToast(locale, error)
      }
    },

    saveSettings(scope, event) {
      const locale = event?.locale
      const values = formValues(event)
      const patch = {}
      for (const key of ['unlockMode', 'allowUngroupedUnlock', 'approveCreate', 'approveUpdate', 'approveDelete']) {
        const value = field(values, `settings.${key}`)
        if (typeof value === 'boolean') patch[key] = value
      }
      try {
        engine.setSettings(patch)
        broadcast()
        return toast(locale, '设置已保存', 'Settings saved')
      } catch (error) {
        return failToast(locale, error)
      }
    },
  }

  // ------------------------------------------------------------ registration

  function panelData(scope, emit, caps) {
    const locale = caps?.locale
    const entry = { scope, locale, emit, last: '' }
    const tick = () => {
      const next = snapshot(scope, locale)
      const encoded = JSON.stringify(next)
      if (encoded !== entry.last) {
        entry.last = encoded
        emit(next)
      }
    }
    tick()
    panelEmitters.add(entry)
    const timer = setInterval(() => {
      try {
        tick()
      } catch {
        /* ignore a transient read failure */
      }
    }, 3000)
    timer.unref?.()
    return () => {
      panelEmitters.delete(entry)
      clearInterval(timer)
    }
  }

  dshGo.panel(PANEL_STUDIO, {
    view: (scope, caps) => studioView(caps),
    data: panelData,
    actions,
  })

  dshGo.panel(PANEL_TOOL, {
    view: (scope, caps) => toolView(caps),
    data: panelData,
    actions,
  })

  dshGo.panel(PANEL_PACK, {
    view: (scope, caps) => packView(caps),
    data: panelData,
    actions,
  })

  dshGo.panel(PANEL_SETTINGS, {
    view: (scope, caps) => settingsView(caps),
    data: panelData,
    actions,
  })

  dshGo.strip(STRIP_ID, {
    data(scope, emit, caps) {
      const locale = caps?.locale
      let last = ''
      const tick = () => {
        const records = engine.list()
        const enabled = records.filter((record) => record.enabled !== false).length
        const value = {
          text: pick(locale, `工具 ${records.length} · 启用 ${enabled}`, `${records.length} tools · ${enabled} on`),
          icon: 'wrench',
          tone: 'info',
        }
        const encoded = JSON.stringify(value)
        if (encoded !== last) {
          last = encoded
          emit(value)
        }
      }
      tick()
      stripUpdaters.add(tick)
      const timer = setInterval(tick, 5000)
      timer.unref?.()
      return () => {
        stripUpdaters.delete(tick)
        clearInterval(timer)
      }
    },
  })

  dshGo.on('new-tool', (scope, event) => actions.newTool(scope, event))
}

/**
 * Custom tool studio — Web client half.
 *
 * A plain `window.__ModuleLoader__` script (no build step, no generated
 * markup) that adds one sidebar row and one central page. The page owns its own data through
 * the same-origin HTTP routes published by the Host half, and follows the
 * active locale through the shell locale service.
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-tool-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Stable id shared by the sidebar row and the main-slot page. */
    const PANEL_ID = 'custom-tool-studio';
    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-custom-tool-studio';

    /**
     * Route paths mirrored from the Host.
     *
     * DOCUMENT-RELATIVE on purpose (no leading slash): the GUI is served with
     * `<base href="./">`, so a sub-path deployment keeps these requests under
     * the entry directory.
     */
    const API = {
      list: 'api/custom-tool-studio/list',
      create: 'api/custom-tool-studio/create',
      update: 'api/custom-tool-studio/update',
      delete: 'api/custom-tool-studio/delete',
      setEnabled: 'api/custom-tool-studio/set-enabled',
      test: 'api/custom-tool-studio/test',
      settings: 'api/custom-tool-studio/settings',
      packs: 'api/custom-tool-studio/packs',
      packCreate: 'api/custom-tool-studio/pack-create',
      packUpdate: 'api/custom-tool-studio/pack-update',
      packDelete: 'api/custom-tool-studio/pack-delete',
      packSetEnabled: 'api/custom-tool-studio/pack-set-enabled',
    };

    /** Model-facing tool-name shape, mirrored from the Host validator. */
    const NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;

    /** Monospace stack (the code-ish surfaces; no extra font tokens needed). */
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

    // #region helpers

    /** JSON object predicate (records arrive as untrusted JSON). */
    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /** Array or empty list. */
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    /** Safe display text for an untrusted scalar. */
    function asText(value, fallback) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return fallback;
    }

    /** Join conditional class names. */
    function cx() {
      const parts = [];
      for (let index = 0; index < arguments.length; index += 1) {
        const part = arguments[index];
        if (typeof part === 'string' && part !== '') parts.push(part);
      }
      return parts.join(' ');
    }

    /** Readable message from anything thrown by the API client. */
    function errorText(error) {
      if (error instanceof Error && typeof error.message === 'string' && error.message.trim() !== '') {
        return error.message;
      }
      if (typeof error === 'string' && error.trim() !== '') return error;
      return String(error);
    }

    /** Pretty JSON that never throws on odd values. */
    function stringifyJson(value) {
      try {
        const text = JSON.stringify(value, null, 2);
        return typeof text === 'string' ? text : '{}';
      } catch {
        return '{}';
      }
    }

    /** Dictionary interpolation: `{name}` placeholders only. */
    function fmt(t, key, vars) {
      const template = t(key);
      if (typeof template !== 'string') return key;
      if (!isPlainObject(vars)) return template;
      return template.replace(/\{(\w+)\}/g, (match, token) =>
        Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : match,
      );
    }

    // #endregion
    // #region dictionaries

    const zh = {
      'panel.label': '自定义工具',
      'page.title': '自定义工具',
      'page.subtitle': '用 Python 定义模型可以调用的工具。保存后立即注册到当前会话，无需重启。',
      'page.create': '新建工具',
      'page.refresh': '刷新',
      'page.refreshing': '刷新中…',
      'list.heading': '工具列表',
      'list.count': '共 {n} 个',
      'list.loading': '正在加载工具…',
      'list.empty.title': '还没有自定义工具',
      'list.empty.text': '每个工具都是一段 Python：定义 def run(args)，返回任意可 JSON 序列化的结果，模型就能像调用内置工具一样调用它。',
      'list.empty.sample': 'def run(args):\n    return {"echo": args.get("text", "")}\n',
      'list.empty.cta': '创建第一个工具',
      'api.httpError': 'HTTP 错误',
      'state.error.title': '加载失败',
      'state.error.text': '无法读取自定义工具列表，请检查 Host 是否已加载，然后重试。',
      'state.retry': '重试',
      'python.missing.title': '未检测到 Python，创建的工具无法执行',
      'python.missing.hint': '安装 Python 3 并确保 python 在 PATH 中，然后重启 DSH。',
      'python.ready': 'Python {version}',
      'row.test': '测试',
      'row.edit': '编辑',
      'row.delete': '删除',
      'row.toggle': '启用或禁用 {name}',
      'row.noDescription': '没有描述',
      'row.untitled': '未命名工具',
      'row.broken': '这条记录缺少 id，无法操作',
      'row.badge.python': 'Python',
      'row.badge.danger': '危险',
      'row.badge.disabled': '已禁用',
      'row.badge.unregistered': '未注册',
      'row.registrationError': '注册失败：{message}',
      'footnote.store': '存储位置',
      'notice.refreshFailed': '刷新失败：{message}',
      'notice.toggleFailed': '切换失败：{message}',
      'notice.deleted': '已删除「{title}」',
      'notice.dismiss': '关闭提示',
      'editor.title.create': '新建自定义工具',
      'editor.title.edit': '编辑自定义工具',
      'editor.desc': '保存后工具会立即注册；修改名称会同步重命名脚本镜像。',
      'editor.name': '名称',
      'editor.nameHint': '模型看到的工具名：小写字母开头，只含小写字母、数字、下划线，2–48 个字符。',
      'editor.namePlaceholder': '例如 python_word_count',
      'editor.titleField': '标题',
      'editor.titlePlaceholder': '页面里显示的名称（可留空，默认同名称）',
      'editor.description': '描述',
      'editor.descriptionHint': '告诉模型「什么时候」该用这个工具，它会原样出现在工具定义里。',
      'editor.descriptionPlaceholder': '例如：统计一段文本的字符数，需要精确字数时使用。',
      'editor.parameters': '参数 JSON Schema',
      'editor.parametersHint': '根节点必须是 object；字段会原样展示给模型，用来生成调用参数。',
      'editor.code': 'Python 代码',
      'editor.codeHint': '必须定义 def run(args)，返回值需可 JSON 序列化；print 的输出会作为 stdout 返回。',
      'editor.dangerous': '危险工具',
      'editor.dangerousHint': '开启后，每次运行都需要内置审批确认。',
      'editor.enabled': '启用',
      'editor.enabledHint': '关闭后不会注册为工具，但记录会保留。',
      'editor.cancel': '取消',
      'editor.saveCreate': '创建工具',
      'editor.saveEdit': '保存修改',
      'editor.saving': '保存中…',
      'editor.error.nameRequired': '请填写工具名。',
      'editor.error.nameInvalid': '工具名格式不正确：小写字母开头，只含小写字母、数字、下划线，2–48 个字符。',
      'editor.error.descriptionRequired': '请填写描述：模型靠它判断何时使用这个工具。',
      'editor.error.parametersJson': '参数不是合法 JSON，请检查括号与引号。',
      'editor.error.parametersObject': '参数根节点必须是 JSON 对象（{ … }）。',
      'editor.error.codeRequired': '请填写 Python 代码。',
      'editor.error.codeEntry': '代码必须定义入口 run(args)，例如 def run(args): return {...}。',
      'editor.error.missingTool': '服务器没有返回工具记录，请刷新后重试。',
      'editor.template.parameters': '{\n  "type": "object",\n  "properties": {\n    "text": { "type": "string", "description": "要处理的文本" }\n  },\n  "required": ["text"]\n}',
      'editor.template.code': 'def run(args):\n    # args 就是模型传入的参数对象\n    text = args.get("text", "")\n    return {"chars": len(text)}\n',
      'test.title': '测试「{name}」',
      'test.desc': '用一份示例参数直接运行脚本，不会改动已保存的代码。',
      'test.args': '参数 JSON',
      'test.argsHint': '会作为 args 对象传给 run(args)。',
      'test.run': '运行',
      'test.running': '运行中…',
      'test.close': '关闭',
      'test.hint': '运行后这里会显示返回值、stdout、stderr 和耗时。',
      'test.ok': '运行成功',
      'test.failed': '运行失败',
      'test.duration': '耗时 {ms} ms',
      'test.errorJson': '参数不是合法 JSON。',
      'test.errorObject': '参数必须是 JSON 对象。',
      'test.errorTransport': '请求失败：{message}',
      'test.result': '返回值',
      'test.resultNone': '（没有返回值）',
      'test.stdout': 'stdout',
      'test.stderr': 'stderr',
      'test.errorLabel': '错误',
      'delete.title': '删除工具',
      'delete.desc': '这会从磁盘移除记录与脚本镜像，并立即从工具列表注销；无法撤销。',
      'delete.target': '{title}（{name}）',
      'delete.confirm': '删除',
      'delete.deleting': '删除中…',
      'delete.cancel': '取消',
      'delete.error': '删除失败：{message}',
      'settings.button': '设置',
      'settings.title': '审批设置',
      'settings.desc': 'AI 用 custom_tool_manage 做这些管理操作时，要不要先问你。危险工具的执行审批始终生效，不受这里影响。',
      'settings.approveCreate': '创建工具需要审批',
      'settings.approveCreateHint': 'AI 新建自定义工具时先弹审批。',
      'settings.approveUpdate': '修改工具需要审批',
      'settings.approveUpdateHint': 'AI 改名称、描述、参数、代码或危险/启用状态时先弹审批。',
      'settings.approveDelete': '删除工具需要审批',
      'settings.approveDeleteHint': '删除会同时移除脚本副本、无法撤销，建议保持开启。',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.error': '保存失败：{message}',
      'settings.saved': '审批设置已保存',
      'page.createPack': '新建工具包',
      'pack.count': '{n} 个工具 · 启用 {on}',
      'pack.toggle': '一键启用或停用工具包 {name}',
      'pack.mixed': '部分启用',
      'pack.empty': '这个工具包里还没有工具。点「编辑」把工具加进来。',
      'pack.ungrouped': '未分组工具',
      'pack.ungroupedHint': '还没有归入工具包的工具。',
      'pack.edit': '编辑',
      'pack.delete': '删除',
      'notice.packDeleted': '已删除工具包「{name}」，包里的工具保留为未分组',
      'notice.packToggleFailed': '切换工具包失败：{message}',
      'packEditor.title.create': '新建工具包',
      'packEditor.title.edit': '编辑工具包',
      'packEditor.desc': '工具包只是分组：包里每个工具仍然各自注册、各自启用。开关工具包时批量改它们的状态。',
      'packEditor.name': '名称',
      'packEditor.nameHint': '页面上显示的分组名，1–48 个字符，可以写中文。',
      'packEditor.namePlaceholder': '例如 文本处理',
      'packEditor.description': '描述',
      'packEditor.descriptionHint': '给这个工具包一句话说明，方便以后回来看懂它装了什么。',
      'packEditor.descriptionPlaceholder': '例如 处理文本统计与清洗的工具',
      'packEditor.members': '包里的工具',
      'packEditor.membersHint': '勾选要放进这个工具包的工具；取消勾选会把工具移出该包（工具本身保留）。',
      'packEditor.membersEmpty': '还没有可加入的自定义工具，先建一个工具再来分组。',
      'packEditor.memberOff': '已停用',
      'packEditor.memberOther': '现在在「{pack}」，勾选会移进本包',
      'packEditor.cancel': '取消',
      'packEditor.saveCreate': '创建工具包',
      'packEditor.saveEdit': '保存修改',
      'packEditor.saving': '保存中…',
      'packEditor.error.nameRequired': '请填写工具包名称。',
      'packEditor.error.nameTooLong': '工具包名称过长（上限 48 个字符）。',
      'packEditor.error.missingPack': '服务器没有返回工具包记录，请刷新后重试。',
      'deletePack.title': '删除工具包',
      'deletePack.desc': '只删除这个分组，包里的工具会保留并变成未分组，代码、参数和启用状态都不变。',
      'deletePack.target': '工具包「{name}」',
      'deletePack.members': '包里有 {n} 个工具',
      'deletePack.confirm': '删除工具包',
      'deletePack.deleting': '删除中…',
      'deletePack.cancel': '取消',
      'deletePack.error': '删除失败：{message}',
      'editor.pack': '所属工具包',
      'editor.packHint': '放进工具包只是分组，不改变工具的注册方式；选择「不放入工具包」表示不分组。',
      'editor.packNone': '不放入工具包',
      'common.close': '关闭',
    };

    const en = {
      'panel.label': 'Custom Tools',
      'page.title': 'Custom Tools',
      'page.subtitle': 'Define model-callable tools in Python. Saved tools register in this session immediately, with no restart.',
      'page.create': 'New tool',
      'page.refresh': 'Refresh',
      'page.refreshing': 'Refreshing…',
      'list.heading': 'Tools',
      'list.count': '{n} total',
      'list.loading': 'Loading tools…',
      'list.empty.title': 'No custom tools yet',
      'list.empty.text': 'Every tool is a Python snippet: define def run(args), return JSON-serializable data, and the model can call it like a built-in tool.',
      'list.empty.sample': 'def run(args):\n    return {"echo": args.get("text", "")}\n',
      'list.empty.cta': 'Create your first tool',
      'api.httpError': 'HTTP error',
      'state.error.title': 'Failed to load',
      'state.error.text': 'Could not read the custom tool list. Check that the Host half is loaded, then retry.',
      'state.retry': 'Retry',
      'python.missing.title': 'Python not detected; created tools cannot run',
      'python.missing.hint': 'Install Python 3, make sure python is on PATH, then restart DSH.',
      'python.ready': 'Python {version}',
      'row.test': 'Test',
      'row.edit': 'Edit',
      'row.delete': 'Delete',
      'row.toggle': 'Enable or disable {name}',
      'row.noDescription': 'No description',
      'row.untitled': 'Untitled tool',
      'row.broken': 'This record has no id and cannot be managed',
      'row.badge.python': 'Python',
      'row.badge.danger': 'Dangerous',
      'row.badge.disabled': 'Disabled',
      'row.badge.unregistered': 'Not registered',
      'row.registrationError': 'Registration failed: {message}',
      'footnote.store': 'Store',
      'notice.refreshFailed': 'Refresh failed: {message}',
      'notice.toggleFailed': 'Toggle failed: {message}',
      'notice.deleted': 'Deleted “{title}”',
      'notice.dismiss': 'Dismiss',
      'editor.title.create': 'New custom tool',
      'editor.title.edit': 'Edit custom tool',
      'editor.desc': 'The tool registers immediately after save; renaming also renames its script mirror.',
      'editor.name': 'Name',
      'editor.nameHint': 'Model-facing tool name: starts with a lowercase letter; lowercase letters, digits, underscores; 2–48 chars.',
      'editor.namePlaceholder': 'e.g. python_word_count',
      'editor.titleField': 'Title',
      'editor.titlePlaceholder': 'Name shown in this page (optional; defaults to the name)',
      'editor.description': 'Description',
      'editor.descriptionHint': 'Tell the model WHEN to use this tool; it appears verbatim in the tool definition.',
      'editor.descriptionPlaceholder': 'e.g. Count the characters of a text when an exact count matters.',
      'editor.parameters': 'Parameters JSON Schema',
      'editor.parametersHint': 'The root must be an object; these fields are shown to the model verbatim to build arguments.',
      'editor.code': 'Python code',
      'editor.codeHint': 'Must define def run(args); the return value must be JSON-serializable; print output is returned as stdout.',
      'editor.dangerous': 'Dangerous tool',
      'editor.dangerousHint': 'When on, every run requires built-in approval.',
      'editor.enabled': 'Enabled',
      'editor.enabledHint': 'When off, the tool is not registered, but the record is kept.',
      'editor.cancel': 'Cancel',
      'editor.saveCreate': 'Create tool',
      'editor.saveEdit': 'Save changes',
      'editor.saving': 'Saving…',
      'editor.error.nameRequired': 'Please enter a tool name.',
      'editor.error.nameInvalid': 'Invalid tool name: start with a lowercase letter; lowercase letters, digits, underscores; 2–48 chars.',
      'editor.error.descriptionRequired': 'Please enter a description; the model uses it to decide when to call this tool.',
      'editor.error.parametersJson': 'Parameters are not valid JSON; check brackets and quotes.',
      'editor.error.parametersObject': 'The parameters root must be a JSON object ({ … }).',
      'editor.error.codeRequired': 'Please enter Python code.',
      'editor.error.codeEntry': 'The code must define the entry point run(args), e.g. def run(args): return {...}.',
      'editor.error.missingTool': 'The server returned no tool record; refresh and retry.',
      'editor.template.parameters': '{\n  "type": "object",\n  "properties": {\n    "text": { "type": "string", "description": "Text to process" }\n  },\n  "required": ["text"]\n}',
      'editor.template.code': 'def run(args):\n    # args is the argument object the model passed in\n    text = args.get("text", "")\n    return {"chars": len(text)}\n',
      'test.title': 'Test “{name}”',
      'test.desc': 'Run the script with sample arguments; saved code is unchanged.',
      'test.args': 'Arguments JSON',
      'test.argsHint': 'Passed to run(args) as the args object.',
      'test.run': 'Run',
      'test.running': 'Running…',
      'test.close': 'Close',
      'test.hint': 'The result, stdout, stderr, and duration appear here after a run.',
      'test.ok': 'Success',
      'test.failed': 'Failed',
      'test.duration': '{ms} ms',
      'test.errorJson': 'Arguments are not valid JSON.',
      'test.errorObject': 'Arguments must be a JSON object.',
      'test.errorTransport': 'Request failed: {message}',
      'test.result': 'Result',
      'test.resultNone': '(no return value)',
      'test.stdout': 'stdout',
      'test.stderr': 'stderr',
      'test.errorLabel': 'Error',
      'delete.title': 'Delete tool',
      'delete.desc': 'This removes the record and script mirror from disk and unregisters the tool immediately. It cannot be undone.',
      'delete.target': '{title} ({name})',
      'delete.confirm': 'Delete',
      'delete.deleting': 'Deleting…',
      'delete.cancel': 'Cancel',
      'delete.error': 'Delete failed: {message}',
      'settings.button': 'Settings',
      'settings.title': 'Approval settings',
      'settings.desc': 'Ask before the AI performs these management operations. Executing a dangerous tool always asks and is not affected by this page.',
      'settings.approveCreate': 'Approve creating a tool',
      'settings.approveCreateHint': 'Ask before the AI creates a custom tool.',
      'settings.approveUpdate': 'Approve editing a tool',
      'settings.approveUpdateHint': 'Ask before the AI changes a name, description, parameters, code, or the dangerous/enabled flags.',
      'settings.approveDelete': 'Approve deleting a tool',
      'settings.approveDeleteHint': 'Deleting also removes the script mirror and cannot be undone; keep this on.',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.error': 'Could not save: {message}',
      'settings.saved': 'Approval settings saved',
      'page.createPack': 'New pack',
      'pack.count': '{n} tools · {on} enabled',
      'pack.toggle': 'Enable or disable tool pack {name}',
      'pack.mixed': 'Partially enabled',
      'pack.empty': 'This pack has no tools yet. Use “Edit” to add some.',
      'pack.ungrouped': 'Ungrouped tools',
      'pack.ungroupedHint': 'No tool has been grouped into a pack yet.',
      'pack.edit': 'Edit',
      'pack.delete': 'Delete',
      'notice.packDeleted': 'Deleted pack “{name}”; its tools are kept as ungrouped',
      'notice.packToggleFailed': 'Could not switch the pack: {message}',
      'packEditor.title.create': 'New tool pack',
      'packEditor.title.edit': 'Edit tool pack',
      'packEditor.desc': 'A pack is just a group: every tool inside still registers and enables on its own. The pack switch flips them together.',
      'packEditor.name': 'Name',
      'packEditor.nameHint': 'Group name shown on this page, 1–48 characters.',
      'packEditor.namePlaceholder': 'e.g. Text processing',
      'packEditor.description': 'Description',
      'packEditor.descriptionHint': 'One line describing what this pack holds.',
      'packEditor.descriptionPlaceholder': 'e.g. Tools for counting and cleaning text',
      'packEditor.members': 'Tools in this pack',
      'packEditor.membersHint': 'Check the tools to include; unchecking removes a tool from the pack (the tool itself is kept).',
      'packEditor.membersEmpty': 'No custom tools yet — create a tool first, then group it.',
      'packEditor.memberOff': 'Disabled',
      'packEditor.memberOther': 'Currently in “{pack}”; checking moves it here',
      'packEditor.cancel': 'Cancel',
      'packEditor.saveCreate': 'Create pack',
      'packEditor.saveEdit': 'Save changes',
      'packEditor.saving': 'Saving…',
      'packEditor.error.nameRequired': 'Please enter a pack name.',
      'packEditor.error.nameTooLong': 'The pack name is too long (48 characters max).',
      'packEditor.error.missingPack': 'The server returned no pack record; refresh and retry.',
      'deletePack.title': 'Delete tool pack',
      'deletePack.desc': 'Only the group is removed. The tools inside are kept and become ungrouped; code, parameters, and enabled state stay as they are.',
      'deletePack.target': 'Pack “{name}”',
      'deletePack.members': '{n} tools in this pack',
      'deletePack.confirm': 'Delete pack',
      'deletePack.deleting': 'Deleting…',
      'deletePack.cancel': 'Cancel',
      'deletePack.error': 'Delete failed: {message}',
      'editor.pack': 'Tool pack',
      'editor.packHint': 'Grouping does not change how the tool registers; “No pack” means ungrouped.',
      'editor.packNone': 'No pack',
      'common.close': 'Close',
    };

    // #endregion
    // #region api client

    /** One thrown API error carrying the Host message. */
    class ApiError extends Error {}

    /** Browser-side client for the studio routes. */
    class StudioApi {
      constructor(t) {
        this.t = typeof t === 'function' ? t : (key) => key;
      }

      list() {
        return this.request(API.list);
      }

      create(payload) {
        return this.request(API.create, { method: 'POST', body: payload });
      }

      update(payload) {
        return this.request(API.update, { method: 'POST', body: payload });
      }

      remove(id) {
        return this.request(API.delete, { method: 'POST', body: { id } });
      }

      setEnabled(id, enabled) {
        return this.request(API.setEnabled, { method: 'POST', body: { id, enabled } });
      }

      test(id, args) {
        return this.request(API.test, { method: 'POST', body: { id, args } });
      }

      saveSettings(patch) {
        return this.request(API.settings, { method: 'POST', body: patch });
      }

      packs() {
        return this.request(API.packs);
      }

      createPack(payload) {
        return this.request(API.packCreate, { method: 'POST', body: payload });
      }

      updatePack(payload) {
        return this.request(API.packUpdate, { method: 'POST', body: payload });
      }

      removePack(id) {
        return this.request(API.packDelete, { method: 'POST', body: { id } });
      }

      setPackEnabled(id, enabled) {
        return this.request(API.packSetEnabled, { method: 'POST', body: { id, enabled } });
      }

      async request(path, options) {
        const opts = isPlainObject(options) ? options : {};
        const hasBody = opts.body !== undefined;
        const response = await fetch(path, {
          method: typeof opts.method === 'string' ? opts.method : 'GET',
          headers: hasBody ? { 'content-type': 'application/json' } : undefined,
          body: hasBody ? JSON.stringify(opts.body) : undefined,
        });
        let body;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        if (response.ok !== true) {
          const message = isPlainObject(body) && typeof body.error === 'string' && body.error.trim() !== ''
            ? body.error
            : `${this.t('api.httpError')} ${response.status}`;
          throw new ApiError(message);
        }
        return isPlainObject(body) ? body : {};
      }
    }

    // #endregion
    // #region locale

    /** Bound translate function; falls back to the key when the service is unavailable. */
    function makeT(locale) {
      let bound = null;
      if (locale !== null && locale !== undefined && typeof locale.bind === 'function') {
        try {
          const candidate = locale.bind(NS);
          if (typeof candidate === 'function') bound = candidate;
        } catch {
          bound = null;
        }
      }
      if (bound === null) return (key) => key;
      return (key) => {
        try {
          const value = bound(key);
          return typeof value === 'string' ? value : key;
        } catch {
          return key;
        }
      };
    }

    /** Force a render whenever the locale revision changes. */
    function useLocaleRevision(locale) {
      const subscribe = React.useCallback((listener) => {
        if (locale !== null && locale !== undefined && typeof locale.subscribe === 'function') {
          const dispose = locale.subscribe(listener);
          return typeof dispose === 'function' ? dispose : () => {};
        }
        return () => {};
      }, [locale]);
      const read = React.useCallback(() => {
        if (locale !== null && locale !== undefined && typeof locale.getSnapshot === 'function') {
          try {
            const snapshot = locale.getSnapshot();
            if (isPlainObject(snapshot) && typeof snapshot.revision === 'number') return snapshot.revision;
          } catch {
            return 0;
          }
        }
        return 0;
      }, [locale]);
      React.useSyncExternalStore(subscribe, read, () => 0);
    }

    /** Track mount state so async work never writes into an unmounted tree. */
    function useAlive() {
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);
      return alive;
    }

    // #endregion
    // #region styles

    const CSS = `
.cts-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.cts-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.cts-inner {
  box-sizing: border-box;
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  padding: 28px 32px 44px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.cts-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.cts-heading { min-width: 0; }
.cts-title { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 650; color: var(--dsw-alias-label-primary); }
.cts-subtitle { margin: 6px 0 0; max-width: 760px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.55; }
.cts-headerActions { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
.cts-primary {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 7px 14px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, opacity .12s ease;
}
.cts-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.cts-primary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.cts-primary:disabled { opacity: .55; cursor: default; }
.cts-primary:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.cts-ghost {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 6px 12px;
  background: var(--dsw-alias-button-tool-bar-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.cts-ghost:hover:not(:disabled) { background: var(--dsw-alias-button-tool-bar-hover); }
.cts-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.cts-ghost:disabled { opacity: .55; cursor: default; }
.cts-ghost:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.cts-ghostDanger {
  color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2));
}
.cts-ghostDanger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.cts-warn {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, var(--dsw-alias-border-l1));
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent);
  padding: 10px 14px;
  font-size: 12.5px;
  line-height: 1.55;
}
.cts-warnIcon { flex: none; width: 18px; height: 18px; margin-top: 1px; color: var(--dsw-alias-state-warn-primary); }
.cts-warnBody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cts-warnTitle { color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
.cts-warnDetail { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.cts-warnAction { flex: none; align-self: center; }
.cts-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}
.cts-notice[data-kind="error"] {
  color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
}
.cts-notice[data-kind="success"] {
  color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent);
}
.cts-noticeText { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.cts-noticeClose {
  flex: none;
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  padding: 0 2px;
  font: inherit;
  line-height: 1.2;
  cursor: pointer;
  opacity: .8;
}
.cts-noticeClose:hover { opacity: 1; }
.cts-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.cts-listHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.cts-listTitle { margin: 0; font-size: 13px; font-weight: 600; }
.cts-listCount { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.cts-list { margin: 0; padding: 0; list-style: none; }
.cts-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  transition: background-color .12s ease;
}
.cts-row:last-child { border-bottom: none; }
.cts-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.cts-rowOff .cts-rowName { color: var(--dsw-alias-label-secondary); }
.cts-rowOff .cts-rowDesc { color: var(--dsw-alias-label-tertiary); }
.cts-rowGlyph {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--dsw-alias-brand-primary-soft);
  color: var(--dsw-alias-brand-primary);
}
.cts-rowMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.cts-rowTop { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.cts-rowName {
  font-family: ${MONO};
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.cts-rowTitle {
  max-width: 42ch;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cts-rowDesc {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cts-rowError {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.cts-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.cts-badgeDanger {
  color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.cts-badgeOff { color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); }
.cts-badgeWarn {
  color: var(--dsw-alias-state-warn-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
}
.cts-badgeOk {
  color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);
}
.cts-badgeMixed {
  color: var(--dsw-alias-state-warn-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
}
.cts-groups { display: flex; flex-direction: column; gap: 14px; }
.cts-rowActions { flex: none; display: flex; align-items: center; gap: 2px; }
.cts-rowAction {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 4px 8px;
  font: inherit;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.cts-rowAction:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.cts-rowAction:disabled { opacity: .45; cursor: default; }
.cts-rowAction:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.cts-rowActionDanger { color: var(--dsw-alias-state-error-primary); }
.cts-rowActionDanger:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
.cts-switch {
  appearance: none;
  flex: none;
  display: inline-flex;
  align-items: center;
  margin: 0 4px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
}
.cts-switch:disabled { opacity: .45; cursor: default; }
.cts-switch:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.cts-switchTrack {
  position: relative;
  display: block;
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
  transition: background-color .16s ease;
}
.cts-switchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-base);
  transition: left .16s ease;
}
.cts-switch[aria-checked="true"] .cts-switchTrack { background: var(--dsw-alias-brand-primary); }
.cts-switch[aria-checked="true"] .cts-switchThumb { left: 16px; }
.cts-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 60px 24px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  text-align: center;
}
.cts-stateTitle { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.cts-stateText {
  margin: 0;
  max-width: 540px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.cts-stateCode {
  margin: 2px 0 0;
  max-width: 100%;
  box-sizing: border-box;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-primary);
  font-family: ${MONO};
  font-size: 12px;
  line-height: 1.55;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cts-actions { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 4px; }
.cts-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: cts-spin .8s linear infinite;
}
@keyframes cts-spin { to { transform: rotate(360deg); } }
.cts-footnote {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.5;
}
.cts-footnoteItem { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.cts-codeText { font-family: ${MONO}; font-size: 11.5px; }
.cts-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--dsw-alias-bg-mask-1, color-mix(in srgb, var(--dsw-alias-label-primary) 32%, transparent));
  -webkit-backdrop-filter: var(--dsw-mask-blur, blur(2px));
  backdrop-filter: var(--dsw-mask-blur, blur(2px));
  animation: cts-fade .12s ease;
}
@keyframes cts-fade { from { opacity: 0; } to { opacity: 1; } }
.cts-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 41;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  /* Dialog fill: the skin's OPAQUE modal base when it publishes one (dream-skin
     does, and its --dsw-alias-bg-layer-2 is deliberately translucent), then the
     host's raised panel token, then the popover token. The blur only matters on
     a translucent token; on an opaque fill it is a no-op. */
  background: var(--dsh-dream-skin-modal-base, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)));
  -webkit-backdrop-filter: blur(18px) saturate(1.05);
  backdrop-filter: blur(18px) saturate(1.05);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-shadow-lv3, 0 18px 48px color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent));
  outline: none;
}
.cts-dialogWide { width: min(780px, calc(100vw - 32px)); }
.cts-dialogNarrow { width: min(440px, calc(100vw - 32px)); }
.cts-dialogHead {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 0;
}
.cts-dialogHeading { min-width: 0; }
.cts-dialogTitle { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.cts-dialogDesc { margin: 5px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.55; }
.cts-dialogClose {
  flex: none;
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: -2px -4px 0 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.cts-dialogClose:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.cts-dialogClose:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.cts-dialogBody {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 20px 4px;
}
.cts-dialogFoot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 18px;
}
.cts-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.cts-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.cts-label { color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 500; }
.cts-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 1.5; }
.cts-fieldError { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.45; }
.cts-input, .cts-textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-specific-input-major);
  color: var(--dsw-alias-label-primary);
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.cts-input::placeholder, .cts-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.cts-input:focus, .cts-textarea:focus {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary-soft);
}
.cts-input:disabled, .cts-textarea:disabled { opacity: .6; }
.cts-textarea { resize: vertical; min-height: 62px; line-height: 1.55; }
.cts-mono { font-family: ${MONO}; font-size: 12.5px; line-height: 1.55; tab-size: 2; }
.cts-inputInvalid, .cts-inputInvalid:focus {
  border-color: var(--dsw-alias-state-error-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);
}
.cts-switchRow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.cts-switchText { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cts-switchLabel { color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 500; }
.cts-switchHint { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.5; }
.cts-settingsList { display: flex; flex-direction: column; gap: 8px; }
.cts-settingsList .cts-switchRow { align-items: center; }
.cts-settingsBody { display: flex; flex-direction: column; gap: 10px; }
.cts-alert {
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
  color: var(--dsw-alias-state-error-primary);
  padding: 9px 12px;
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cts-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding-top: 12px;
}
.cts-resultMeta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.cts-section { display: flex; flex-direction: column; gap: 5px; }
.cts-sectionLabel { color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-weight: 600; }
.cts-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 240px;
  overflow: auto;
  border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-primary);
  font-family: ${MONO};
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cts-preError { color: var(--dsw-alias-state-error-primary); }
.cts-muted { color: var(--dsw-alias-label-tertiary); font-size: 12.5px; }
.cts-confirmTarget {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.cts-confirmTitle { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.cts-listHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 2px 0;
}
.cts-packInfo { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.cts-packTitleRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.cts-packGlyph {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--dsw-alias-brand-primary-soft);
  color: var(--dsw-alias-brand-primary);
}
.cts-packName { margin: 0; font-size: 13.5px; font-weight: 650; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.cts-packDesc { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.cts-packActions { flex: none; display: flex; align-items: center; gap: 2px; }
.cts-packEmpty { margin: 0; padding: 16px; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; }
.cts-checkList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 264px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.cts-checkRow {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.cts-checkRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.cts-checkRow input[type="checkbox"] {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.cts-checkText { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cts-checkName { color: var(--dsw-alias-label-primary); font-family: ${MONO}; font-size: 12.5px; }
.cts-checkDesc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cts-checkEmpty { padding: 14px; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; text-align: center; }
select.cts-input { cursor: pointer; }
@media (max-width: 720px) {
  .cts-inner { padding: 20px 16px 32px; }
  .cts-grid2 { grid-template-columns: minmax(0, 1fr); }
  .cts-row { flex-wrap: wrap; align-items: flex-start; }
  .cts-rowActions { width: 100%; justify-content: flex-end; }
  .cts-listHead { flex-wrap: wrap; }
  .cts-rowDesc {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cts-primary, .cts-ghost, .cts-row, .cts-rowAction, .cts-switchTrack, .cts-switchThumb,
  .cts-input, .cts-textarea, .cts-dialogClose { transition: none; }
  .cts-spinner { animation: none; }
  .cts-backdrop { animation: none; }
}
`;

    // #endregion
    // #region glyphs

    /** Sidebar row glyph: the shell owns the row, this component draws the mark. */
    function SidebarIconMark(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16;
      const active = props?.active === true;
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.35',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: {
          display: 'block',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
        },
      },
      h('path', { d: 'M3 4.1h10a1.1 1.1 0 0 1 1.1 1.1v5.6a1.1 1.1 0 0 1-1.1 1.1H3a1.1 1.1 0 0 1-1.1-1.1V5.2A1.1 1.1 0 0 1 3 4.1Z' }),
      h('path', { d: 'M5.1 7.1 6.6 8.4 5.1 9.7' }),
      h('path', { d: 'M8.1 9.7h3' }));
    }

    /** Small code glyph shown at the left of every list row. */
    function RowGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.4',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', { d: 'M6 3.2 3.2 8 6 12.8' }),
      h('path', { d: 'M10 3.2 12.8 8 10 12.8' }));
    }

    /** Dialog close cross. */
    function CloseGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.5',
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', { d: 'm4 4 8 8M12 4l-8 8' }));
    }

    /** Settings gear. */
    function GearGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      h('circle', { cx: 8, cy: 8, r: 2.4 }),
      h('path', {
        d: 'M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1',
      }));
    }

    /** Tool-pack glyph: a small archive box. */
    function PackGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', { d: 'M2.6 5.4h10.8v6.7a1.1 1.1 0 0 1-1.1 1.1H3.7a1.1 1.1 0 0 1-1.1-1.1V5.4Z' }),
      h('path', { d: 'M1.9 2.6h12.2v2.8H1.9z' }),
      h('path', { d: 'M8 8.3v2.3' }));
    }

    /** Warning triangle. */
    function WarnGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 18,
        height: 18,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.4',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', { d: 'M8 2.4 14.2 13H1.8L8 2.4Z' }),
      h('path', { d: 'M8 6.4v3.1' }),
      h('path', { d: 'M8 11.3v.1' }));
    }

    // #endregion
    // #region shared ui

    /** Enable/disable switch (`role="switch"`). */
    function Switch(props) {
      const checked = props?.checked === true;
      const disabled = props?.disabled === true;
      const label = typeof props?.label === 'string' ? props.label : '';
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: 'cts-switch',
        disabled,
        onClick: () => {
          if (disabled) return;
          if (typeof props?.onChange === 'function') props.onChange(!checked);
        },
      },
      h('span', { className: 'cts-switchTrack', 'aria-hidden': 'true' },
        h('span', { className: 'cts-switchThumb' })));
    }

    /** One labelled form field. */
    function Field(props) {
      const label = typeof props?.label === 'string' ? props.label : '';
      const hint = typeof props?.hint === 'string' ? props.hint : '';
      const error = typeof props?.error === 'string' ? props.error : '';
      const htmlFor = typeof props?.htmlFor === 'string' ? props.htmlFor : undefined;
      return h('div', { className: 'cts-field' },
        label !== '' ? h('label', { className: 'cts-label', htmlFor }, label) : null,
        props?.children,
        hint !== '' ? h('p', { className: 'cts-hint' }, hint) : null,
        error !== '' ? h('p', { className: 'cts-fieldError' }, error) : null);
    }

    /**
     * Modal shell: fixed panel, Escape closes, focus enters on open, backdrop
     * click closes, and focus returns to the previously active element.
     */
    function Dialog(props) {
      const t = props.t;
      const title = typeof props?.title === 'string' ? props.title : '';
      const description = typeof props?.description === 'string' ? props.description : '';
      const width = props?.width;
      const panelRef = React.useRef(null);
      const closeRef = React.useRef(props?.onClose);
      closeRef.current = props?.onClose;

      const requestClose = React.useCallback(() => {
        if (typeof closeRef.current === 'function') closeRef.current();
      }, []);

      React.useEffect(() => {
        const panel = panelRef.current;
        const previous = typeof document !== 'undefined' ? document.activeElement : null;
        if (panel !== null) {
          const target = panel.querySelector('[data-autofocus="true"]')
            || panel.querySelector('input, textarea, select, button');
          try {
            if (target !== null) target.focus({ preventScroll: true });
            else panel.focus({ preventScroll: true });
          } catch {
            try {
              if (target !== null) target.focus();
              else panel.focus();
            } catch {
              /* focus is best-effort */
            }
          }
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          requestClose();
        };
        if (typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown);
        return () => {
          if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeyDown);
          if (previous !== null && typeof previous.focus === 'function') {
            try {
              previous.focus({ preventScroll: true });
            } catch {
              /* the trigger may be gone */
            }
          }
        };
      }, [requestClose]);

      return h(React.Fragment, null,
        h('div', { className: 'cts-backdrop', onClick: requestClose, 'aria-hidden': 'true' }),
        h('div', {
          className: cx('cts-dialog', width === 'wide' && 'cts-dialogWide', width === 'narrow' && 'cts-dialogNarrow'),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          tabIndex: -1,
          ref: panelRef,
        },
        h('div', { className: 'cts-dialogHead' },
          h('div', { className: 'cts-dialogHeading' },
            h('h2', { className: 'cts-dialogTitle' }, title),
            description !== '' ? h('p', { className: 'cts-dialogDesc' }, description) : null),
          h('button', {
            type: 'button',
            className: 'cts-dialogClose',
            onClick: requestClose,
            'aria-label': t('common.close'),
          }, h(CloseGlyph))),
        h('div', { className: 'cts-dialogBody' }, props?.children),
        props?.footer ? h('div', { className: 'cts-dialogFoot' }, props.footer) : null));
    }

    // #endregion
    // #region page states

    function LoadingState(props) {
      return h('div', { className: 'cts-state', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'cts-spinner', 'aria-hidden': 'true' }),
        h('p', { className: 'cts-stateText' }, props.t('list.loading')));
    }

    function ErrorState(props) {
      const t = props.t;
      return h('div', { className: 'cts-state', role: 'alert' },
        h('p', { className: 'cts-stateTitle' }, t('state.error.title')),
        h('p', { className: 'cts-stateText' }, t('state.error.text')),
        typeof props.message === 'string' && props.message !== ''
          ? h('pre', { className: 'cts-stateCode' }, props.message)
          : null,
        h('div', { className: 'cts-actions' },
          h('button', { type: 'button', className: 'cts-primary', onClick: props.onRetry }, t('state.retry'))));
    }

    function EmptyState(props) {
      const t = props.t;
      return h('div', { className: 'cts-state' },
        h('p', { className: 'cts-stateTitle' }, t('list.empty.title')),
        h('p', { className: 'cts-stateText' }, t('list.empty.text')),
        h('pre', { className: 'cts-stateCode' }, t('list.empty.sample')),
        h('div', { className: 'cts-actions' },
          h('button', { type: 'button', className: 'cts-primary', onClick: props.onCreate }, t('list.empty.cta'))));
    }

    // #endregion
    // #region list

    function ToolRow(props) {
      const t = props.t;
      const record = isPlainObject(props.record) ? props.record : {};
      const id = asText(record.id, '');
      const name = asText(record.name, '');
      const title = asText(record.title, '');
      const description = asText(record.description, '');
      const enabled = record.enabled !== false;
      const dangerous = record.dangerous === true;
      const unregistered = record.registered === false;
      const registrationError = asText(record.registrationError, '');
      const missingId = id === '';
      const displayName = name !== '' ? name : (title !== '' ? title : t('row.untitled'));
      const showTitle = title !== '' && title !== name;
      const brokenTitle = missingId ? t('row.broken') : undefined;

      return h('li', {
        className: cx('cts-row', !enabled && 'cts-rowOff'),
        'data-tool-id': missingId ? undefined : id,
      },
      h('div', { className: 'cts-rowGlyph', 'aria-hidden': 'true' }, h(RowGlyph)),
      h('div', { className: 'cts-rowMain' },
        h('div', { className: 'cts-rowTop' },
          h('span', { className: 'cts-rowName', title: name !== '' ? name : undefined }, displayName),
          showTitle ? h('span', { className: 'cts-rowTitle', title }, title) : null,
          h('span', { className: 'cts-badge' }, t('row.badge.python')),
          dangerous ? h('span', { className: 'cts-badge cts-badgeDanger' }, t('row.badge.danger')) : null,
          !enabled ? h('span', { className: 'cts-badge cts-badgeOff' }, t('row.badge.disabled')) : null,
          enabled && unregistered
            ? h('span', {
              className: 'cts-badge cts-badgeWarn',
              title: registrationError !== '' ? registrationError : undefined,
            }, t('row.badge.unregistered'))
            : null),
        h('p', {
          className: 'cts-rowDesc',
          title: description !== '' ? description : undefined,
        }, description !== '' ? description : t('row.noDescription')),
        registrationError !== '' && enabled
          ? h('p', { className: 'cts-rowError' }, fmt(t, 'row.registrationError', { message: registrationError }))
          : null),
      h('div', { className: 'cts-rowActions' },
        h(Switch, {
          checked: enabled,
          disabled: props.busy === true || missingId,
          label: missingId ? t('row.broken') : fmt(t, 'row.toggle', { name: displayName }),
          onChange: () => props.onToggle(record),
        }),
        h('button', {
          type: 'button',
          className: 'cts-rowAction',
          disabled: missingId,
          title: brokenTitle,
          onClick: () => props.onTest(record),
        }, t('row.test')),
        h('button', {
          type: 'button',
          className: 'cts-rowAction',
          disabled: missingId,
          title: brokenTitle,
          onClick: () => props.onEdit(record),
        }, t('row.edit')),
        h('button', {
          type: 'button',
          className: 'cts-rowAction cts-rowActionDanger',
          disabled: missingId,
          title: brokenTitle,
          onClick: () => props.onDelete(record),
        }, t('row.delete'))));
    }

    /**
     * One group of tools. A pack group owns a header (name, description, member
     * count, one-click switch, edit/delete); the ungrouped group has a plain
     * header. Rows are the same `ToolRow` used before — registration is
     * per tool, so a pack is purely a list grouping.
     */
    function PackCard(props) {
      const t = props.t;
      const pack = isPlainObject(props.pack) ? props.pack : null;
      const tools = asArray(props.tools);
      const packId = pack !== null ? asText(pack.id, '') : '';
      const name = pack !== null ? asText(pack.name, '') : t('pack.ungrouped');
      const description = pack !== null ? asText(pack.description, '') : '';
      const enabledCount = tools.filter((record) => isPlainObject(record) && record.enabled !== false).length;
      const allEnabled = tools.length > 0 && enabledCount === tools.length;
      const mixed = enabledCount > 0 && enabledCount < tools.length;
      const busy = props.busy === true;

      return h('div', { className: 'cts-card', 'data-pack-id': pack !== null ? packId : 'ungrouped', 'data-pack-name': pack !== null ? name : '' },
        h('div', { className: 'cts-listHead' },
          h('div', { className: 'cts-packInfo' },
            h('div', { className: 'cts-packTitleRow' },
              pack !== null
                ? h('span', { className: 'cts-packGlyph', 'aria-hidden': 'true' }, h(PackGlyph))
                : null,
              h('h3', { className: 'cts-packName' }, name),
              h('span', { className: 'cts-badge' }, fmt(t, 'pack.count', { n: tools.length, on: enabledCount })),
              mixed ? h('span', { className: 'cts-badge cts-badgeMixed' }, t('pack.mixed')) : null),
            description !== ''
              ? h('p', { className: 'cts-packDesc', title: description }, description)
              : null),
          pack !== null
            ? h('div', { className: 'cts-packActions' },
              h(Switch, {
                checked: allEnabled,
                disabled: busy || tools.length === 0,
                label: fmt(t, 'pack.toggle', { name }),
                onChange: () => {
                  if (typeof props.onTogglePack === 'function') props.onTogglePack(pack, !allEnabled);
                },
              }),
              h('button', {
                type: 'button',
                className: 'cts-rowAction',
                disabled: busy,
                onClick: () => {
                  if (typeof props.onEditPack === 'function') props.onEditPack(pack);
                },
              }, t('pack.edit')),
              h('button', {
                type: 'button',
                className: 'cts-rowAction cts-rowActionDanger',
                disabled: busy,
                onClick: () => {
                  if (typeof props.onDeletePack === 'function') props.onDeletePack(pack);
                },
              }, t('pack.delete')))
            : null),
        tools.length > 0
          ? h('ul', { className: 'cts-list' },
            tools.map((record, index) => {
              const id = isPlainObject(record) ? asText(record.id, '') : '';
              return h(ToolRow, {
                key: id !== '' ? id : `cts-row-${index}`,
                record,
                t,
                busy: props.isPending(id),
                onTest: props.onTest,
                onEdit: props.onEdit,
                onDelete: props.onDelete,
                onToggle: props.onToggle,
              });
            }))
          : h('p', { className: 'cts-packEmpty' }, pack !== null ? t('pack.empty') : t('pack.ungroupedHint')));
    }

    /**
     * The whole list: one section title, then one card per pack, then the
     * ungrouped remainder (hidden when empty).
     */
    function ToolList(props) {
      const t = props.t;
      const groups = asArray(props.groups);
      let total = 0;
      for (const group of groups) total += asArray(group?.tools).length;
      return h(React.Fragment, null,
        h('div', { className: 'cts-listHeader' },
          h('h2', { className: 'cts-listTitle' }, t('list.heading')),
          h('span', { className: 'cts-listCount' }, fmt(t, 'list.count', { n: total }))),
        h('div', { className: 'cts-groups' },
          groups.map((group, index) => {
            const pack = isPlainObject(group?.pack) ? group.pack : null;
            const key = pack !== null ? asText(pack.id, `pack-${index}`) : 'ungrouped';
            return h(PackCard, {
              key,
              t,
              pack,
              tools: asArray(group?.tools),
              busy: pack !== null && props.isPendingPack(asText(pack.id, '')),
              isPending: props.isPending,
              onTogglePack: props.onTogglePack,
              onEditPack: props.onEditPack,
              onDeletePack: props.onDeletePack,
              onTest: props.onTest,
              onEdit: props.onEdit,
              onDelete: props.onDelete,
              onToggle: props.onToggle,
            });
          })));
    }

    // #endregion
    // #region editor dialog

    /** Editable draft seeded from a record (or from the templates for create). */
    function initialDraft(record, t) {
      const source = isPlainObject(record) ? record : {};
      const parameters = isPlainObject(source.parameters) ? source.parameters : null;
      return {
        name: asText(source.name, ''),
        title: asText(source.title, ''),
        description: asText(source.description, ''),
        parametersText: parameters !== null ? stringifyJson(parameters) : t('editor.template.parameters'),
        codeText: typeof source.code === 'string' ? source.code : t('editor.template.code'),
        dangerous: source.dangerous === true,
        enabled: source.enabled !== false,
        packId: asText(source.packId, ''),
      };
    }

    function EditorDialog(props) {
      const t = props.t;
      const api = props.api;
      const isEdit = props.mode === 'edit';
      const record = isPlainObject(props.record) ? props.record : {};
      const recordId = asText(record.id, '');
      const alive = useAlive();

      const [draft, setDraft] = React.useState(() => initialDraft(record, t));
      const [errors, setErrors] = React.useState({});
      const [hostError, setHostError] = React.useState('');
      const [submitting, setSubmitting] = React.useState(false);
      // Packs the picker can offer. A record pointing at a pack that no longer
      // exists falls back to "no pack" instead of rendering an empty select.
      const packOptions = asArray(props.packs)
        .filter(isPlainObject)
        .filter((pack) => asText(pack.id, '') !== '');
      const packValue = packOptions.some((pack) => asText(pack.id, '') === draft.packId) ? draft.packId : '';

      const update = (field, value) => {
        setDraft((prev) => {
          const next = { ...prev };
          next[field] = value;
          return next;
        });
      };

      const submit = async () => {
        if (submitting) return;
        const found = {};
        const name = draft.name.trim().toLowerCase();
        if (name === '') found.name = 'editor.error.nameRequired';
        else if (!NAME_RE.test(name)) found.name = 'editor.error.nameInvalid';
        if (draft.description.trim() === '') found.description = 'editor.error.descriptionRequired';

        let parameters;
        try {
          const text = draft.parametersText.trim();
          parameters = JSON.parse(text === '' ? '{}' : text);
        } catch {
          found.parameters = 'editor.error.parametersJson';
        }
        if (found.parameters === undefined && !isPlainObject(parameters)) {
          found.parameters = 'editor.error.parametersObject';
        }
        if (draft.codeText.trim() === '') found.code = 'editor.error.codeRequired';
        else if (!/def\s+run\s*\(/.test(draft.codeText)) found.code = 'editor.error.codeEntry';
        if (isEdit && recordId === '') found.name = 'row.broken';

        if (Object.keys(found).length > 0 || !isPlainObject(parameters)) {
          setErrors(found);
          setHostError('');
          return;
        }

        setErrors({});
        setHostError('');
        setSubmitting(true);
        const payload = {
          name,
          title: draft.title.trim(),
          description: draft.description.trim(),
          parameters,
          code: draft.codeText,
          dangerous: draft.dangerous === true,
          enabled: draft.enabled !== false,
          // '' means "no pack"; the Host resolves a pack id (or name) here.
          pack: packValue,
        };
        try {
          const body = isEdit
            ? await api.update({ ...payload, id: recordId })
            : await api.create(payload);
          const tool = isPlainObject(body) && isPlainObject(body.tool) ? body.tool : null;
          if (tool === null) throw new Error(t('editor.error.missingTool'));
          if (typeof props.onSaved === 'function') props.onSaved(tool);
        } catch (error) {
          if (alive.current) setHostError(errorText(error));
        } finally {
          if (alive.current) setSubmitting(false);
        }
      };

      const close = () => {
        if (typeof props.onClose === 'function') props.onClose();
      };

      const fieldError = (key) => (typeof errors[key] === 'string' ? t(errors[key]) : '');

      return h(Dialog, {
        t,
        title: isEdit ? t('editor.title.edit') : t('editor.title.create'),
        description: t('editor.desc'),
        width: 'wide',
        onClose: close,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'cts-ghost', onClick: close, disabled: submitting }, t('editor.cancel')),
          h('button', { type: 'button', className: 'cts-primary', onClick: submit, disabled: submitting },
            submitting ? t('editor.saving') : (isEdit ? t('editor.saveEdit') : t('editor.saveCreate')))),
      },
      h('div', { className: 'cts-grid2' },
        h(Field, {
          label: t('editor.name'),
          hint: t('editor.nameHint'),
          error: fieldError('name'),
          htmlFor: 'cts-field-name',
        },
        h('input', {
          id: 'cts-field-name',
          className: cx('cts-input cts-mono', errors.name !== undefined && 'cts-inputInvalid'),
          value: draft.name,
          placeholder: t('editor.namePlaceholder'),
          autoComplete: 'off',
          spellCheck: false,
          disabled: submitting,
          'data-autofocus': 'true',
          onChange: (event) => update('name', event.target.value),
        })),
        h(Field, {
          label: t('editor.titleField'),
          htmlFor: 'cts-field-title',
        },
        h('input', {
          id: 'cts-field-title',
          className: 'cts-input',
          value: draft.title,
          placeholder: t('editor.titlePlaceholder'),
          autoComplete: 'off',
          disabled: submitting,
          onChange: (event) => update('title', event.target.value),
        }))),
      h(Field, {
        label: t('editor.description'),
        hint: t('editor.descriptionHint'),
        error: fieldError('description'),
        htmlFor: 'cts-field-description',
      },
      h('textarea', {
        id: 'cts-field-description',
        className: cx('cts-textarea', errors.description !== undefined && 'cts-inputInvalid'),
        rows: 2,
        value: draft.description,
        placeholder: t('editor.descriptionPlaceholder'),
        disabled: submitting,
        onChange: (event) => update('description', event.target.value),
      })),
      h(Field, {
        label: t('editor.pack'),
        hint: t('editor.packHint'),
        htmlFor: 'cts-field-pack',
      },
      h('select', {
        id: 'cts-field-pack',
        className: 'cts-input',
        value: packValue,
        disabled: submitting,
        onChange: (event) => update('packId', event.target.value),
      },
      h('option', { value: '' }, t('editor.packNone')),
      packOptions.map((pack) => {
        const packId = asText(pack.id, '');
        return h('option', { key: packId, value: packId }, asText(pack.name, packId));
      }))),
      h(Field, {
        label: t('editor.parameters'),
        hint: t('editor.parametersHint'),
        error: fieldError('parameters'),
        htmlFor: 'cts-field-parameters',
      },
      h('textarea', {
        id: 'cts-field-parameters',
        className: cx('cts-textarea cts-mono', errors.parameters !== undefined && 'cts-inputInvalid'),
        rows: 8,
        value: draft.parametersText,
        spellCheck: false,
        disabled: submitting,
        onChange: (event) => update('parametersText', event.target.value),
      })),
      h(Field, {
        label: t('editor.code'),
        hint: t('editor.codeHint'),
        error: fieldError('code'),
        htmlFor: 'cts-field-code',
      },
      h('textarea', {
        id: 'cts-field-code',
        className: cx('cts-textarea cts-mono', errors.code !== undefined && 'cts-inputInvalid'),
        rows: 13,
        value: draft.codeText,
        spellCheck: false,
        disabled: submitting,
        onChange: (event) => update('codeText', event.target.value),
      })),
      h('div', { className: 'cts-switchRow' },
        h('span', { className: 'cts-switchText' },
          h('span', { className: 'cts-switchLabel' }, t('editor.dangerous')),
          h('span', { className: 'cts-switchHint' }, t('editor.dangerousHint'))),
        h(Switch, {
          checked: draft.dangerous,
          disabled: submitting,
          label: t('editor.dangerous'),
          onChange: (next) => update('dangerous', next),
        })),
      h('div', { className: 'cts-switchRow' },
        h('span', { className: 'cts-switchText' },
          h('span', { className: 'cts-switchLabel' }, t('editor.enabled')),
          h('span', { className: 'cts-switchHint' }, t('editor.enabledHint'))),
        h(Switch, {
          checked: draft.enabled,
          disabled: submitting,
          label: t('editor.enabled'),
          onChange: (next) => update('enabled', next),
        })),
      hostError !== '' ? h('div', { className: 'cts-alert', role: 'alert' }, hostError) : null);
    }

    // #endregion
    // #region test dialog

    /** Sample arguments derived from the record's parameter schema. */
    function defaultArgs(record) {
      try {
        const source = isPlainObject(record) ? record : {};
        const parameters = isPlainObject(source.parameters) ? source.parameters : {};
        const properties = isPlainObject(parameters.properties) ? parameters.properties : {};
        const out = {};
        const keys = Object.keys(properties).slice(0, 40);
        for (const key of keys) {
          const schema = isPlainObject(properties[key]) ? properties[key] : {};
          const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
          if (schema.default !== undefined) out[key] = schema.default;
          else if (enumValues.length > 0) out[key] = enumValues[0];
          else if (schema.type === 'number' || schema.type === 'integer') out[key] = 0;
          else if (schema.type === 'boolean') out[key] = false;
          else if (schema.type === 'array') out[key] = [];
          else if (schema.type === 'object') out[key] = {};
          else if (schema.type === 'null') out[key] = null;
          else out[key] = '';
        }
        return out;
      } catch {
        return {};
      }
    }

    function TestDialog(props) {
      const t = props.t;
      const api = props.api;
      const record = isPlainObject(props.record) ? props.record : {};
      const id = asText(record.id, '');
      const name = asText(record.name, '');
      const displayName = name !== '' ? name : t('row.untitled');
      const alive = useAlive();

      const [argsText, setArgsText] = React.useState(() => stringifyJson(defaultArgs(record)));
      const [running, setRunning] = React.useState(false);
      const [parseError, setParseError] = React.useState('');
      const [transportError, setTransportError] = React.useState('');
      const [outcome, setOutcome] = React.useState(null);

      const close = () => {
        if (typeof props.onClose === 'function') props.onClose();
      };

      const run = async () => {
        if (running) return;
        let args;
        try {
          const text = argsText.trim();
          args = JSON.parse(text === '' ? '{}' : text);
        } catch {
          setParseError(t('test.errorJson'));
          return;
        }
        if (!isPlainObject(args)) {
          setParseError(t('test.errorObject'));
          return;
        }
        if (id === '') {
          setParseError(t('row.broken'));
          return;
        }
        setParseError('');
        setTransportError('');
        setRunning(true);
        try {
          const body = await api.test(id, args);
          if (alive.current) setOutcome(isPlainObject(body) ? body : {});
        } catch (error) {
          if (alive.current) setTransportError(fmt(t, 'test.errorTransport', { message: errorText(error) }));
        } finally {
          if (alive.current) setRunning(false);
        }
      };

      let resultText = '';
      let errorOutput = '';
      let stdout = '';
      let stderr = '';
      let ok = false;
      let durationMs = 0;
      if (isPlainObject(outcome)) {
        ok = outcome.ok === true;
        if (outcome.result !== undefined && outcome.result !== null) resultText = stringifyJson(outcome.result);
        else if (typeof outcome.content === 'string' && outcome.content.trim() !== '') resultText = outcome.content;
        errorOutput = asText(outcome.error, '');
        stdout = asText(outcome.stdout, '');
        stderr = asText(outcome.stderr, '');
        durationMs = typeof outcome.durationMs === 'number' && Number.isFinite(outcome.durationMs)
          ? Math.max(0, Math.round(outcome.durationMs))
          : 0;
      }

      const resultBody = [];
      if (isPlainObject(outcome)) {
        resultBody.push(h('div', { className: 'cts-resultMeta', key: 'meta' },
          h('span', { className: cx('cts-badge', ok ? 'cts-badgeOk' : 'cts-badgeDanger') },
            ok ? t('test.ok') : t('test.failed')),
          h('span', null, fmt(t, 'test.duration', { ms: durationMs }))));
        if (!ok && errorOutput !== '') {
          resultBody.push(h('div', { className: 'cts-section', key: 'error' },
            h('span', { className: 'cts-sectionLabel' }, t('test.errorLabel')),
            h('pre', { className: 'cts-pre cts-preError' }, errorOutput)));
        }
        resultBody.push(h('div', { className: 'cts-section', key: 'result' },
          h('span', { className: 'cts-sectionLabel' }, t('test.result')),
          resultText !== ''
            ? h('pre', { className: 'cts-pre' }, resultText)
            : h('span', { className: 'cts-muted' }, t('test.resultNone'))));
        if (stdout !== '') {
          resultBody.push(h('div', { className: 'cts-section', key: 'stdout' },
            h('span', { className: 'cts-sectionLabel' }, t('test.stdout')),
            h('pre', { className: 'cts-pre' }, stdout)));
        }
        if (stderr !== '') {
          resultBody.push(h('div', { className: 'cts-section', key: 'stderr' },
            h('span', { className: 'cts-sectionLabel' }, t('test.stderr')),
            h('pre', { className: 'cts-pre' }, stderr)));
        }
      }

      return h(Dialog, {
        t,
        title: fmt(t, 'test.title', { name: displayName }),
        description: t('test.desc'),
        width: 'wide',
        onClose: close,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'cts-ghost', onClick: close }, t('test.close')),
          h('button', { type: 'button', className: 'cts-primary', onClick: run, disabled: running },
            running ? t('test.running') : t('test.run'))),
      },
      h(Field, {
        label: t('test.args'),
        hint: t('test.argsHint'),
        error: parseError,
        htmlFor: 'cts-field-args',
      },
      h('textarea', {
        id: 'cts-field-args',
        className: cx('cts-textarea cts-mono', parseError !== '' && 'cts-inputInvalid'),
        rows: 9,
        value: argsText,
        spellCheck: false,
        disabled: running,
        'data-autofocus': 'true',
        onChange: (event) => setArgsText(event.target.value),
      })),
      transportError !== '' ? h('div', { className: 'cts-alert', role: 'alert' }, transportError) : null,
      !isPlainObject(outcome) && transportError === ''
        ? h('p', { className: 'cts-muted' }, t('test.hint'))
        : null,
      resultBody.length > 0 ? h('div', { className: 'cts-result' }, resultBody) : null);
    }

    // #endregion
    // #region delete dialog

    function DeleteDialog(props) {
      const t = props.t;
      const api = props.api;
      const record = isPlainObject(props.record) ? props.record : {};
      const id = asText(record.id, '');
      const name = asText(record.name, '');
      const title = asText(record.title, '') || name || t('row.untitled');
      const alive = useAlive();

      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const close = () => {
        if (typeof props.onClose === 'function') props.onClose();
      };

      const remove = async () => {
        if (busy) return;
        if (id === '') {
          setError(t('row.broken'));
          return;
        }
        setBusy(true);
        setError('');
        try {
          await api.remove(id);
          if (typeof props.onDeleted === 'function') props.onDeleted(id, record);
          close();
        } catch (caught) {
          if (alive.current) setError(fmt(t, 'delete.error', { message: errorText(caught) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      return h(Dialog, {
        t,
        title: t('delete.title'),
        description: t('delete.desc'),
        width: 'narrow',
        onClose: close,
        footer: h(React.Fragment, null,
          h('button', {
            type: 'button',
            className: 'cts-ghost',
            onClick: close,
            disabled: busy,
            'data-autofocus': 'true',
          }, t('delete.cancel')),
          h('button', { type: 'button', className: 'cts-ghost cts-ghostDanger', onClick: remove, disabled: busy },
            busy ? t('delete.deleting') : t('delete.confirm'))),
      },
      h('div', { className: 'cts-confirmTarget' },
        h('span', { className: 'cts-confirmTitle' }, fmt(t, 'delete.target', { title, name: name !== '' ? name : title })),
        name !== '' ? h('code', { className: 'cts-codeText' }, name) : null),
      error !== '' ? h('div', { className: 'cts-alert', role: 'alert' }, error) : null);
    }

    /**
     * Create / edit a tool pack: a display name, a description, and a member
     * checklist. Membership is replaced by the checked tools.
     */
    function PackEditorDialog(props) {
      const t = props.t;
      const api = props.api;
      const isEdit = props.mode === 'edit';
      const pack = isPlainObject(props.pack) ? props.pack : {};
      const packId = asText(pack.id, '');
      const tools = asArray(props.tools).filter(isPlainObject);
      const alive = useAlive();

      /** id → display name, so the checklist can say where a tool lives now. */
      const packNames = (() => {
        const map = {};
        for (const entry of asArray(props.packs)) {
          if (isPlainObject(entry) && asText(entry.id, '') !== '') map[asText(entry.id, '')] = asText(entry.name, '');
        }
        return map;
      })();

      const [draft, setDraft] = React.useState(() => ({
        name: asText(pack.name, ''),
        description: asText(pack.description, ''),
      }));
      const [selected, setSelected] = React.useState(() => {
        const chosen = {};
        for (const tool of tools) {
          if (isPlainObject(tool) && packId !== '' && tool.packId === packId) {
            const name = asText(tool.name, '');
            if (name !== '') chosen[name] = true;
          }
        }
        return chosen;
      });
      const [errors, setErrors] = React.useState({});
      const [hostError, setHostError] = React.useState('');
      const [submitting, setSubmitting] = React.useState(false);

      const update = (field, value) => {
        setDraft((prev) => ({ ...prev, [field]: value }));
      };

      const toggleMember = (name) => {
        setSelected((prev) => {
          const next = { ...prev };
          if (next[name] === true) delete next[name];
          else next[name] = true;
          return next;
        });
      };

      const submit = async () => {
        if (submitting) return;
        const found = {};
        const name = draft.name.trim();
        if (name === '') found.name = 'packEditor.error.nameRequired';
        else if (name.length > 48) found.name = 'packEditor.error.nameTooLong';
        if (Object.keys(found).length > 0) {
          setErrors(found);
          setHostError('');
          return;
        }
        const memberNames = tools
          .map((tool) => asText(tool.name, ''))
          .filter((memberName) => memberName !== '' && selected[memberName] === true);
        setErrors({});
        setHostError('');
        setSubmitting(true);
        try {
          const payload = {
            name,
            description: draft.description.trim(),
            tools: memberNames,
          };
          const body = isEdit
            ? await api.updatePack({ ...payload, id: packId })
            : await api.createPack(payload);
          const saved = isPlainObject(body) && isPlainObject(body.pack) ? body.pack : null;
          if (saved === null) throw new Error(t('packEditor.error.missingPack'));
          if (typeof props.onSaved === 'function') props.onSaved(saved);
        } catch (error) {
          if (alive.current) setHostError(errorText(error));
        } finally {
          if (alive.current) setSubmitting(false);
        }
      };

      const close = () => {
        if (typeof props.onClose === 'function') props.onClose();
      };

      return h(Dialog, {
        t,
        title: isEdit ? t('packEditor.title.edit') : t('packEditor.title.create'),
        description: t('packEditor.desc'),
        width: 'wide',
        onClose: close,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'cts-ghost', onClick: close, disabled: submitting }, t('packEditor.cancel')),
          h('button', { type: 'button', className: 'cts-primary', onClick: submit, disabled: submitting },
            submitting ? t('packEditor.saving') : (isEdit ? t('packEditor.saveEdit') : t('packEditor.saveCreate')))),
      },
      h('div', { className: 'cts-grid2' },
        h(Field, {
          label: t('packEditor.name'),
          hint: t('packEditor.nameHint'),
          error: typeof errors.name === 'string' ? t(errors.name) : '',
          htmlFor: 'cts-field-pack-name',
        },
        h('input', {
          id: 'cts-field-pack-name',
          className: cx('cts-input', errors.name !== undefined && 'cts-inputInvalid'),
          value: draft.name,
          placeholder: t('packEditor.namePlaceholder'),
          autoComplete: 'off',
          disabled: submitting,
          'data-autofocus': 'true',
          onChange: (event) => update('name', event.target.value),
        })),
        h(Field, {
          label: t('packEditor.description'),
          hint: t('packEditor.descriptionHint'),
          htmlFor: 'cts-field-pack-desc',
        },
        h('input', {
          id: 'cts-field-pack-desc',
          className: 'cts-input',
          value: draft.description,
          placeholder: t('packEditor.descriptionPlaceholder'),
          autoComplete: 'off',
          disabled: submitting,
          onChange: (event) => update('description', event.target.value),
        }))),
      h(Field, {
        label: t('packEditor.members'),
        hint: t('packEditor.membersHint'),
      },
      tools.length === 0
        ? h('p', { className: 'cts-checkEmpty' }, t('packEditor.membersEmpty'))
        : h('div', { className: 'cts-checkList' },
          tools.map((tool) => {
            const name = asText(tool.name, '');
            if (name === '') return null;
            const checked = selected[name] === true;
            const description = asText(tool.description, '');
            const otherPackId = asText(tool.packId, '');
            const otherPackName = otherPackId !== '' && otherPackId !== packId
              ? asText(packNames[otherPackId], '')
              : '';
            return h('label', { className: 'cts-checkRow', key: name },
              h('input', {
                type: 'checkbox',
                checked,
                disabled: submitting,
                onChange: () => toggleMember(name),
              }),
              h('span', { className: 'cts-checkText' },
                h('span', { className: 'cts-checkName' }, name),
                description !== ''
                  ? h('span', { className: 'cts-checkDesc' }, description)
                  : null,
                tool.enabled === false
                  ? h('span', { className: 'cts-checkDesc' }, t('packEditor.memberOff'))
                  : null,
                otherPackName !== ''
                  ? h('span', { className: 'cts-checkDesc' }, fmt(t, 'packEditor.memberOther', { pack: otherPackName }))
                  : null));
          }))),
      hostError !== '' ? h('div', { className: 'cts-alert', role: 'alert' }, hostError) : null);
    }

    /** Confirm deleting a pack. Only the grouping goes away. */
    function DeletePackDialog(props) {
      const t = props.t;
      const api = props.api;
      const pack = isPlainObject(props.pack) ? props.pack : {};
      const id = asText(pack.id, '');
      const name = asText(pack.name, '');
      const memberCount = typeof props.memberCount === 'number' && props.memberCount >= 0 ? props.memberCount : 0;
      const alive = useAlive();

      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const close = () => {
        if (typeof props.onClose === 'function') props.onClose();
      };

      const remove = async () => {
        if (busy) return;
        if (id === '') {
          setError(t('row.broken'));
          return;
        }
        setBusy(true);
        setError('');
        try {
          const body = await api.removePack(id);
          if (typeof props.onDeleted === 'function') props.onDeleted(pack, isPlainObject(body) ? body : {});
          close();
        } catch (caught) {
          if (alive.current) setError(fmt(t, 'deletePack.error', { message: errorText(caught) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      return h(Dialog, {
        t,
        title: t('deletePack.title'),
        description: t('deletePack.desc'),
        width: 'narrow',
        onClose: close,
        footer: h(React.Fragment, null,
          h('button', {
            type: 'button',
            className: 'cts-ghost',
            onClick: close,
            disabled: busy,
            'data-autofocus': 'true',
          }, t('deletePack.cancel')),
          h('button', { type: 'button', className: 'cts-ghost cts-ghostDanger', onClick: remove, disabled: busy },
            busy ? t('deletePack.deleting') : t('deletePack.confirm'))),
      },
      h('div', { className: 'cts-confirmTarget' },
        h('span', { className: 'cts-confirmTitle' }, fmt(t, 'deletePack.target', { name })),
        h('span', { className: 'cts-muted' }, fmt(t, 'deletePack.members', { n: memberCount }))),
      error !== '' ? h('div', { className: 'cts-alert', role: 'alert' }, error) : null);
    }

    /**
     * Approval switches for the management operations (create / update / delete).
     * Executing a dangerous tool always asks and is not configurable here.
     */
    function SettingsDialog(props) {
      const t = props.t;
      const api = props.api;
      const alive = useAlive();
      const [draft, setDraft] = React.useState(() => normalizeSettings(props?.settings));
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState('');
      const draftRef = React.useRef(draft);
      draftRef.current = draft;

      const setFlag = (key, next) => {
        setError('');
        setDraft((prev) => ({ ...prev, [key]: next === true }));
      };

      const submit = async () => {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
          const body = await api.saveSettings(draftRef.current);
          if (!alive.current) return;
          const next = isPlainObject(body) && isPlainObject(body.settings) ? body.settings : draftRef.current;
          if (typeof props.onSaved === 'function') props.onSaved(normalizeSettings(next));
        } catch (caught) {
          if (alive.current) setError(fmt(t, 'settings.error', { message: errorText(caught) }));
        } finally {
          if (alive.current) setSaving(false);
        }
      };

      const rows = [
        ['approveCreate', 'settings.approveCreate', 'settings.approveCreateHint'],
        ['approveUpdate', 'settings.approveUpdate', 'settings.approveUpdateHint'],
        ['approveDelete', 'settings.approveDelete', 'settings.approveDeleteHint'],
      ];

      return h(Dialog, {
        t,
        title: t('settings.title'),
        description: t('settings.desc'),
        width: 'narrow',
        onClose: props.onClose,
        footer: [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'cts-ghost',
            onClick: props.onClose,
            disabled: saving,
          }, t('editor.cancel')),
          h('button', {
            key: 'save',
            type: 'button',
            className: 'cts-primary',
            onClick: submit,
            disabled: saving,
          }, saving ? t('settings.saving') : t('settings.save')),
        ],
      },
      h('div', { className: 'cts-settingsBody' },
        h('div', { className: 'cts-settingsList' },
          rows.map(([key, labelKey, hintKey]) => h('div', { className: 'cts-switchRow', key },
            h('span', { className: 'cts-switchText' },
              h('span', { className: 'cts-switchLabel' }, t(labelKey)),
              h('span', { className: 'cts-switchHint' }, t(hintKey))),
            h(Switch, {
              checked: draft[key] === true,
              label: t(labelKey),
              disabled: saving,
              onChange: (next) => setFlag(key, next),
            })))),
        error !== '' ? h('div', { className: 'cts-alert', role: 'alert' }, error) : null));
    }

    // #endregion
    // #region page

    /** Approval switches, mirrored from the Host defaults. */
    const DEFAULT_SETTINGS = { approveCreate: false, approveUpdate: false, approveDelete: true };

    /** Coerce untrusted settings JSON into the three booleans. */
    function normalizeSettings(value) {
      const source = isPlainObject(value) ? value : {};
      const out = {};
      for (const key of ['approveCreate', 'approveUpdate', 'approveDelete']) {
        out[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key];
      }
      return out;
    }

    /** Normalize the list payload; never throw on odd JSON. */
    function normalizeListPayload(body) {
      const source = isPlainObject(body) ? body : {};
      const tools = asArray(source.tools).filter(isPlainObject);
      const packs = asArray(source.packs).filter(isPlainObject);
      const python = isPlainObject(source.python) ? source.python : {};
      const paths = isPlainObject(source.paths) ? source.paths : {};
      let pythonReady = true;
      if (typeof source.pythonReady === 'boolean') pythonReady = source.pythonReady;
      else if (typeof python.ok === 'boolean') pythonReady = python.ok;
      return { tools, packs, python, paths, pythonReady, settings: normalizeSettings(source.settings) };
    }

    const EMPTY_SNAPSHOT = { tools: [], packs: [], python: {}, paths: {}, pythonReady: true, settings: DEFAULT_SETTINGS };

    /**
     * Split tools into one group per pack plus the ungrouped remainder.
     * Membership comes from `tool.packId`, so the grouping always matches what
     * is actually registered; a pack's `tools`/counts fields are not trusted.
     */
    function groupTools(tools, packs) {
      const groups = [];
      const claimed = new Set();
      for (const pack of packs) {
        const id = asText(pack?.id, '');
        if (id === '') continue;
        const members = tools.filter((tool) => asText(tool?.packId, '') === id);
        for (const member of members) claimed.add(asText(member.id, ''));
        groups.push({ pack, tools: members });
      }
      const ungrouped = tools.filter((tool) => !claimed.has(asText(tool.id, '')) && asText(tool.packId, '') === '');
      const orphaned = tools.filter((tool) => !claimed.has(asText(tool.id, '')) && asText(tool.packId, '') !== '');
      // A record pointing at a deleted pack still has to be listed somewhere.
      const rest = ungrouped.concat(orphaned);
      if (rest.length > 0 || groups.length === 0) groups.push({ pack: null, tools: rest });
      return groups;
    }

    function StudioPage(props) {
      const locale = props?.locale;
      const api = props?.api;
      useLocaleRevision(locale);
      const t = makeT(locale);
      const tRef = React.useRef(t);
      tRef.current = t;

      const [phase, setPhase] = React.useState('loading');
      const [snapshot, setSnapshot] = React.useState(EMPTY_SNAPSHOT);
      const [loadError, setLoadError] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [editor, setEditor] = React.useState(null);
      const [tester, setTester] = React.useState(null);
      const [deleting, setDeleting] = React.useState(null);
      const [packEditor, setPackEditor] = React.useState(null);
      const [deletingPack, setDeletingPack] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [pending, setPending] = React.useState([]);
      const pendingRef = React.useRef([]);
      const [pendingPacks, setPendingPacks] = React.useState([]);
      const pendingPacksRef = React.useRef([]);
      const [refreshing, setRefreshing] = React.useState(false);
      const sequenceRef = React.useRef(0);
      const alive = useAlive();

      const load = React.useCallback(async (mode) => {
        if (api === null || api === undefined) return;
        const isRefresh = mode === 'refresh';
        const seq = sequenceRef.current + 1;
        sequenceRef.current = seq;
        setNotice(null);
        if (isRefresh) setRefreshing(true);
        else setPhase('loading');
        try {
          const body = await api.list();
          if (!alive.current || sequenceRef.current !== seq) return;
          setSnapshot(normalizeListPayload(body));
          setPhase('ready');
        } catch (error) {
          if (!alive.current || sequenceRef.current !== seq) return;
          const message = errorText(error);
          if (isRefresh) {
            setNotice({ kind: 'error', text: fmt(tRef.current, 'notice.refreshFailed', { message }) });
          } else {
            setLoadError(message);
            setPhase('error');
          }
        } finally {
          if (alive.current && sequenceRef.current === seq) setRefreshing(false);
        }
      }, [api, alive]);

      React.useEffect(() => {
        load('initial');
      }, [load]);

      const upsertTool = React.useCallback((tool) => {
        if (!isPlainObject(tool)) return;
        const id = asText(tool.id, '');
        if (id === '') return;
        setSnapshot((prev) => {
          const tools = prev.tools.slice();
          let index = -1;
          for (let cursor = 0; cursor < tools.length; cursor += 1) {
            if (isPlainObject(tools[cursor]) && tools[cursor].id === id) {
              index = cursor;
              break;
            }
          }
          if (index >= 0) tools[index] = tool;
          else tools.push(tool);
          return { ...prev, tools };
        });
      }, []);

      const toggleTool = async (record) => {
        const id = isPlainObject(record) ? asText(record.id, '') : '';
        if (id === '' || pendingRef.current.indexOf(id) >= 0) return;
        const nextEnabled = record.enabled === false;
        pendingRef.current = pendingRef.current.concat(id);
        setPending(pendingRef.current);
        setNotice(null);
        try {
          const body = await api.setEnabled(id, nextEnabled);
          if (!alive.current) return;
          if (isPlainObject(body) && isPlainObject(body.tool)) upsertTool(body.tool);
        } catch (error) {
          if (alive.current) {
            setNotice({ kind: 'error', text: fmt(tRef.current, 'notice.toggleFailed', { message: errorText(error) }) });
          }
        } finally {
          pendingRef.current = pendingRef.current.filter((entry) => entry !== id);
          if (alive.current) setPending(pendingRef.current);
        }
      };

      const handleSaved = (tool) => {
        upsertTool(tool);
        setEditor(null);
      };

      const handleDeleted = (id, record) => {
        setSnapshot((prev) => ({
          ...prev,
          tools: prev.tools.filter((item) => !isPlainObject(item) || item.id !== id),
        }));
        const title = asText(record?.title, '') || asText(record?.name, '') || tRef.current('row.untitled');
        setNotice({ kind: 'success', text: fmt(tRef.current, 'notice.deleted', { title }) });
      };

      const upsertPack = React.useCallback((pack) => {
        if (!isPlainObject(pack)) return;
        const id = asText(pack.id, '');
        if (id === '') return;
        setSnapshot((prev) => {
          const packs = prev.packs.slice();
          let index = -1;
          for (let cursor = 0; cursor < packs.length; cursor += 1) {
            if (isPlainObject(packs[cursor]) && packs[cursor].id === id) {
              index = cursor;
              break;
            }
          }
          if (index >= 0) packs[index] = { ...packs[index], ...pack };
          else packs.push(pack);
          return { ...prev, packs };
        });
      }, []);

      /** One-click pack switch: the Host flips each member's own enabled flag. */
      const togglePack = async (pack, nextEnabled) => {
        const id = isPlainObject(pack) ? asText(pack.id, '') : '';
        if (id === '' || pendingPacksRef.current.indexOf(id) >= 0) return;
        pendingPacksRef.current = pendingPacksRef.current.concat(id);
        setPendingPacks(pendingPacksRef.current);
        setNotice(null);
        try {
          const body = await api.setPackEnabled(id, nextEnabled === true);
          if (!alive.current) return;
          for (const tool of asArray(isPlainObject(body) ? body.tools : [])) upsertTool(tool);
          if (isPlainObject(body) && isPlainObject(body.pack)) upsertPack(body.pack);
        } catch (error) {
          if (alive.current) {
            setNotice({ kind: 'error', text: fmt(tRef.current, 'notice.packToggleFailed', { message: errorText(error) }) });
          }
        } finally {
          pendingPacksRef.current = pendingPacksRef.current.filter((entry) => entry !== id);
          if (alive.current) setPendingPacks(pendingPacksRef.current);
        }
      };

      const handlePackSaved = () => {
        setPackEditor(null);
        // Membership lives on the tool records, so re-read the whole list.
        load('refresh');
      };

      const handlePackDeleted = (pack, body) => {
        const id = asText(pack?.id, '');
        const detached = asArray(isPlainObject(body) ? body.tools : []).filter(isPlainObject);
        setSnapshot((prev) => {
          const tools = prev.tools.map((tool) => {
            const match = detached.find((entry) => asText(entry?.id, '') === asText(tool?.id, ''));
            return match === undefined ? tool : match;
          });
          return { ...prev, tools, packs: prev.packs.filter((entry) => asText(entry?.id, '') !== id) };
        });
        const name = asText(pack?.name, '') || '—';
        setNotice({ kind: 'success', text: fmt(tRef.current, 'notice.packDeleted', { name }) });
      };

      const isPending = (id) => id !== '' && pending.indexOf(id) >= 0;
      const isPendingPack = (id) => id !== '' && pendingPacks.indexOf(id) >= 0;

      const groups = groupTools(snapshot.tools, snapshot.packs);

      let body;
      if (phase === 'loading') {
        body = h(LoadingState, { t });
      } else if (phase === 'error') {
        body = h(ErrorState, { t, message: loadError, onRetry: () => load('initial') });
      } else if (snapshot.tools.length === 0 && snapshot.packs.length === 0) {
        body = h(EmptyState, { t, onCreate: () => setEditor({ record: null }) });
      } else {
        body = h(ToolList, {
          t,
          groups,
          isPending,
          isPendingPack,
          onTogglePack: togglePack,
          onEditPack: (pack) => setPackEditor({ pack }),
          onDeletePack: (pack) => setDeletingPack(pack),
          onTest: (record) => setTester(record),
          onEdit: (record) => setEditor({ record }),
          onDelete: (record) => setDeleting(record),
          onToggle: toggleTool,
        });
      }

      const pythonError = asText(snapshot.python.error, '');
      const pythonVersion = asText(snapshot.python.version, '');
      const storePath = asText(snapshot.paths.store, '');
      const showWarning = phase === 'ready' && snapshot.pythonReady === false;

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'cts-root', 'data-dsh-custom-tool-studio': '' },
          h('div', { className: 'cts-scroll' },
            h('div', { className: 'cts-inner' },
              h('div', { className: 'cts-header' },
                h('div', { className: 'cts-heading' },
                  h('h1', { className: 'cts-title' }, t('page.title')),
                  h('p', { className: 'cts-subtitle' }, t('page.subtitle'))),
                h('div', { className: 'cts-headerActions' },
                  h('button', {
                    type: 'button',
                    className: 'cts-ghost',
                    onClick: () => setSettingsOpen(true),
                  }, h(GearGlyph), t('settings.button')),
                  h('button', {
                    type: 'button',
                    className: 'cts-ghost',
                    onClick: () => load('refresh'),
                    disabled: refreshing || phase === 'loading',
                  }, refreshing ? t('page.refreshing') : t('page.refresh')),
                  h('button', {
                    type: 'button',
                    className: 'cts-ghost',
                    onClick: () => setPackEditor({ pack: null }),
                  }, t('page.createPack')),
                  h('button', {
                    type: 'button',
                    className: 'cts-primary',
                    onClick: () => setEditor({ record: null }),
                  }, t('page.create')))),
              showWarning
                ? h('div', { className: 'cts-warn', role: 'status' },
                  h('span', { className: 'cts-warnIcon', 'aria-hidden': 'true' }, h(WarnGlyph)),
                  h('div', { className: 'cts-warnBody' },
                    h('span', { className: 'cts-warnTitle' }, t('python.missing.title')),
                    h('span', { className: 'cts-warnDetail' },
                      pythonError !== '' ? pythonError : t('python.missing.hint'))),
                  h('button', {
                    type: 'button',
                    className: 'cts-ghost cts-warnAction',
                    onClick: () => load('refresh'),
                  }, t('page.refresh')))
                : null,
              notice !== null && typeof notice.text === 'string' && notice.text !== ''
                ? h('div', { className: 'cts-notice', 'data-kind': notice.kind === 'success' ? 'success' : 'error', role: 'status' },
                  h('span', { className: 'cts-noticeText' }, notice.text),
                  h('button', {
                    type: 'button',
                    className: 'cts-noticeClose',
                    onClick: () => setNotice(null),
                    'aria-label': t('notice.dismiss'),
                  }, h(CloseGlyph)))
                : null,
              body,
              phase === 'ready'
                ? h('div', { className: 'cts-footnote' },
                  storePath !== ''
                    ? h('span', { className: 'cts-footnoteItem' },
                      t('footnote.store'),
                      ' ',
                      h('code', { className: 'cts-codeText' }, storePath))
                    : null,
                  pythonVersion !== ''
                    ? h('span', { className: 'cts-footnoteItem' }, fmt(t, 'python.ready', { version: pythonVersion }))
                    : null)
                : null)),
        editor !== null
          ? h(EditorDialog, {
            t,
            api,
            mode: isPlainObject(editor.record) ? 'edit' : 'create',
            record: editor.record,
            packs: snapshot.packs,
            onSaved: handleSaved,
            onClose: () => setEditor(null),
          })
          : null,
        packEditor !== null
          ? h(PackEditorDialog, {
            t,
            api,
            mode: isPlainObject(packEditor.pack) ? 'edit' : 'create',
            pack: packEditor.pack,
            tools: snapshot.tools,
            packs: snapshot.packs,
            onSaved: handlePackSaved,
            onClose: () => setPackEditor(null),
          })
          : null,
        deletingPack !== null
          ? h(DeletePackDialog, {
            t,
            api,
            pack: deletingPack,
            memberCount: (() => {
              const id = asText(deletingPack?.id, '');
              return snapshot.tools.filter((tool) => asText(tool?.packId, '') === id).length;
            })(),
            onDeleted: handlePackDeleted,
            onClose: () => setDeletingPack(null),
          })
          : null,
        tester !== null
          ? h(TestDialog, {
            t,
            api,
            record: tester,
            onClose: () => setTester(null),
          })
          : null,
        deleting !== null
          ? h(DeleteDialog, {
            t,
            api,
            record: deleting,
            onDeleted: handleDeleted,
            onClose: () => setDeleting(null),
          })
          : null,
        settingsOpen
          ? h(SettingsDialog, {
            t,
            api,
            settings: snapshot.settings,
            onSaved: (next) => {
              setSnapshot((prev) => ({ ...prev, settings: normalizeSettings(next) }));
              setSettingsOpen(false);
              setNotice({ kind: 'success', text: t('settings.saved') });
            },
            onClose: () => setSettingsOpen(false),
          })
          : null));
    }

    // #endregion
    // #region plugin entry

    /** Mount the sidebar row, the central page, and the dictionaries. */
    function apply(ctx) {
      const slots = ctx.slots;
      const locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) ?? ctx.locale;
      const t = makeT(locale);

      ctx.effect(() => {
        try {
          return locale.register(NS, { zh, en });
        } catch (error) {
          try {
            console.warn('[custom-tool-studio] dictionary registration failed:', error);
          } catch {
            /* console may be unavailable */
          }
          return () => {};
        }
      }, 'custom-tool-studio: dictionaries');

      const api = new StudioApi(t);
      const disposers = [];
      try {
        disposers.push(slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => t('panel.label'),
        }, SidebarIconMark)));

        disposers.push(slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({
            api,
            locale: (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) ?? ctx.locale,
          }),
        }, StudioPage)));
      } catch (error) {
        try {
          console.warn('[custom-tool-studio] slot registration failed:', error);
        } catch {
          /* console may be unavailable */
        }
      }

      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            /* one stale disposer must not block the others */
          }
        }
      }, 'custom-tool-studio: ui mounts');
    }

    // `__test` exposes the pure components to the offline render harness in the
    // workspace; the module loader only reads `apply` / `inject`.
    return {
      inject: ['slots', 'locale', 'layout'],
      apply,
      __test: {
        SettingsDialog,
        StudioPage,
        ToolList,
        PackCard,
        EditorDialog,
        PackEditorDialog,
        DeletePackDialog,
        groupTools,
        normalizeListPayload,
      },
    };
    // #endregion
  },
});

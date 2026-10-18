/**
 * Approval gate for dangerous custom tools and gated management operations.
 *
 * The gate is one `tools/pre-execute` waterfall listener. When it recognizes a
 * call that needs confirmation it returns an `ask` decision, which the tools
 * pipeline routes through the built-in approval seam (the same seam the
 * built-in Auto review feature delegates to). Everything else delegates with
 * `next()`.
 *
 * Kept in its own module so the decision can be unit tested without a live
 * registry.
 */
import { MANAGE_TOOL_NAME } from './tools.js'

/** Management action → the settings switch that gates it. */
export const APPROVAL_SWITCH = Object.freeze({
  create: 'approveCreate',
  update: 'approveUpdate',
  delete: 'approveDelete',
  // Pack operations reuse the same three switches: a pack is tool metadata,
  // and a delete is a delete whether it removes one tool or a grouping.
  pack_create: 'approveCreate',
  pack_update: 'approveUpdate',
  pack_delete: 'approveDelete',
})

/** Human labels used in the approval prompt. */
const ACTION_LABEL = Object.freeze({
  create: { zh: '创建', en: 'create' },
  update: { zh: '修改', en: 'update' },
  delete: { zh: '删除', en: 'delete' },
  pack_create: { zh: '创建', en: 'create' },
  pack_update: { zh: '修改', en: 'update' },
  pack_delete: { zh: '删除', en: 'delete' },
})

/**
 * Build the `ask` decision for one record, with localized prompt text.
 * @param {{ name: string, title?: string }} record the dangerous tool.
 * @returns {{ kind: 'ask', reason: string, displayReason: { en: string, [locale: string]: string } }}
 */
export function approvalDecision(record) {
  const label = record?.title && record.title !== record.name ? `「${record.title}」(${record.name})` : `「${record.name}」`
  return {
    kind: 'ask',
    reason: `Custom tool "${record.name}" is marked dangerous; every execution requires explicit user approval.`,
    displayReason: {
      en: `Run dangerous custom tool "${record.name}"? Every execution needs your approval.`,
      zh: `运行危险自定义工具${label}？每次执行都需要你确认。`,
    },
  }
}

/**
 * Build the `ask` decision for a gated management operation
 * (create/update/delete of a tool, or of a tool pack).
 * @param {'create'|'update'|'delete'|'pack_create'|'pack_update'|'pack_delete'} action the management action.
 * @param {string} name the tool / pack name the action targets.
 * @param {boolean} known whether the target already exists (delete/update).
 * @param {'tool'|'pack'} [subject] what the action targets.
 * @returns {{ kind: 'ask', reason: string, displayReason: { en: string, [locale: string]: string } }}
 */
export function managementDecision(action, name, known, subject = 'tool') {
  const isPack = subject === 'pack'
  const zh = ACTION_LABEL[action]?.zh ?? action
  const en = ACTION_LABEL[action]?.en ?? action
  const noun = isPack ? '工具包' : '自定义工具'
  const target = name === '' ? noun : `${noun}「${name}」`
  const isDelete = action === 'delete' || action === 'pack_delete'
  const extra = isDelete
    ? (isPack
      ? '。包里的工具会保留为未分组，但这次删除无法撤销'
      : '。删除后记录与脚本副本都会被移除，无法撤销')
    : ''
  return {
    kind: 'ask',
    reason: `${isPack ? 'Tool pack' : 'Custom tool'} ${en} requires approval: the user enabled approval for this operation${known ? ` (${isPack ? 'pack' : 'tool'} "${name}")` : ''}.`,
    displayReason: {
      en: `${en === 'create' ? 'Create' : en === 'update' ? 'Update' : 'Delete'} ${isPack ? 'tool pack' : 'custom tool'}${name === '' ? '' : ` "${name}"`}? Approval is enabled for this operation.`,
      zh: `${zh}${target}？该操作已在设置里开启审批${extra}。`,
    },
  }
}

/**
 * Create the pre-execute listener.
 * @param {{
 *   isDangerous: (toolName: string) => boolean,
 *   findByName: (toolName: string) => { name: string, title?: string, dangerous?: boolean } | undefined,
 *   findPackByName?: (ref: string) => { name: string } | undefined,
 *   getSettings: () => { approveCreate?: boolean, approveUpdate?: boolean, approveDelete?: boolean },
 * }} deps registry lookups and the current approval switches.
 * @returns {(exec: { name?: string, arguments?: unknown }, next: () => Promise<unknown>) => Promise<unknown>}
 */
export function makePreExecuteListener(deps) {
  const settingsOf = () => {
    try {
      const value = deps.getSettings?.()
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  return async function preExecute(exec, next) {
    try {
      const toolName = exec?.name
      if (typeof toolName === 'string') {
        // 1. A dangerous custom tool: every execution needs approval.
        if (deps.isDangerous(toolName)) {
          return approvalDecision(deps.findByName(toolName) ?? { name: toolName })
        }
        if (toolName === MANAGE_TOOL_NAME && exec?.arguments !== null && typeof exec.arguments === 'object') {
          const args = exec.arguments
          const rawName = typeof args.name === 'string' ? args.name.trim() : ''
          const requestedName = rawName.toLowerCase()
          // 2. The management tool's `test` action runs someone else's script,
          //    so testing a dangerous tool is itself a dangerous execution.
          if (args.action === 'test') {
            const target = deps.findByName(requestedName)
            if (target !== undefined && target.dangerous === true) return approvalDecision(target)
            return next()
          }
          // 3. Management operations the user asked to confirm.
          const action = typeof args.action === 'string' ? args.action : ''
          const switchName = APPROVAL_SWITCH[action]
          if (switchName !== undefined && settingsOf()[switchName] === true) {
            if (action.startsWith('pack_')) {
              const ref = typeof args.pack === 'string' && args.pack.trim() !== '' ? args.pack.trim() : rawName
              const existing = deps.findPackByName?.(ref)
              return managementDecision(action, existing?.name ?? ref, existing !== undefined, 'pack')
            }
            const existing = deps.findByName(requestedName)
            return managementDecision(action, existing?.name ?? requestedName, existing !== undefined)
          }
        }
      }
    } catch {
      /* never let the gate break an unrelated call */
    }
    return next()
  }
}

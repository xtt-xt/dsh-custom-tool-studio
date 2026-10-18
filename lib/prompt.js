/**
 * Dynamic prompt context: which custom tool packs exist right now.
 *
 * The unlock tool can list packs on demand, but a conversation that never calls
 * it has no idea a pack exists. This block is registered as a runtime context
 * on the prompt service, so every model step sees the current pack list without
 * spending a tool call — and it follows pack edits immediately because the text
 * is rebuilt on each assembly.
 */

/** One compact line for a pack's member list. */
function packLine(pack, members) {
  const always = pack.alwaysUnlocked === true ? '，始终解锁' : ''
  if (members.length === 0) return `- ${pack.name}（空包${always}）`
  return `- ${pack.name}（${members.length} 个工具${always}）：${members.join('、')}`
}

/**
 * Build the prompt-context block.
 *
 * Returns an empty string when unlock mode is off: every registered tool is
 * already visible then, so a pack list would only add noise.
 *
 * @param {object} state
 * @param {object} state.settings current global settings
 * @param {object[]} state.packs stored packs
 * @param {object[]} state.records stored tool records
 * @returns {string}
 */
export function buildPackContextText(state) {
  const settings = state?.settings ?? {}
  if (settings.unlockMode !== true) return ''

  const records = Array.isArray(state?.records) ? state.records : []
  const packs = Array.isArray(state?.packs) ? state.packs : []
  const enabled = records.filter((record) => record.enabled !== false)

  const membersByPack = new Map(packs.map((pack) => [pack.id, []]))
  const ungrouped = []
  for (const record of enabled) {
    if (typeof record.packId === 'string' && membersByPack.has(record.packId)) {
      membersByPack.get(record.packId).push(record.name)
    } else {
      ungrouped.push(record.name)
    }
  }

  const lines = ['## 自定义工具包（解锁模式已开启）']
  lines.push('当前对话默认只看到 `custom_tool_manage` 与 `custom_tool_unlock`；需要某个包的工具时，先调用 `custom_tool_unlock` 解锁，包里的工具才会出现在下一轮。')

  if (packs.length === 0) {
    lines.push('目前还没有工具包。')
  } else {
    lines.push('可解锁的工具包：')
    for (const pack of packs) {
      lines.push(packLine(pack, membersByPack.get(pack.id) ?? []))
    }
  }

  if (ungrouped.length > 0) {
    if (settings.allowUngroupedUnlock === true) {
      lines.push(`未分组工具（可用 tool 单独解锁）：${ungrouped.join('、')}`)
    } else {
      lines.push(`未分组工具（当前不可单独解锁，需先放进工具包）：${ungrouped.join('、')}`)
    }
  }

  lines.push('`custom_tool_unlock` 的 `action="list"` 可查看实时解锁状态；`alwaysUnlocked` 的包无需解锁。')
  return lines.join('\n')
}

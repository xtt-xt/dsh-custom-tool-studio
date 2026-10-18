import { buildPackContextText } from '../lib/prompt.js'

const fails = []
const check = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

const on = { unlockMode: true, allowUngroupedUnlock: true }
const off = { unlockMode: false, allowUngroupedUnlock: false }

const packs = [
  { id: 'p1', name: 'mcdev-docs', alwaysUnlocked: false },
  { id: 'p2', name: '测试', alwaysUnlocked: true },
  { id: 'p3', name: '空包', alwaysUnlocked: false },
]
const records = [
  { name: 'mcdev_search', packId: 'p1', enabled: true },
  { name: 'mcdev_fetch', packId: 'p1', enabled: true },
  { name: 'off_tool', packId: 'p1', enabled: false },
  { name: 'py_text_stats', packId: '', enabled: true },
]

const text = buildPackContextText({ settings: on, packs, records })
console.log(`---\n${text}\n---`)

check('empty when unlock mode is off', buildPackContextText({ settings: off, packs, records }) === '')
check('empty when state is missing', buildPackContextText() === '')
check('header names the unlock mode', text.includes('自定义工具包'))
check('lists the pack with member names', text.includes('mcdev-docs') && text.includes('mcdev_search') && text.includes('mcdev_fetch'))
check('disabled members are not listed', !text.includes('off_tool'))
check('always-unlocked pack is marked', text.includes('测试（空包，始终解锁）'))
check('empty pack is rendered as an empty pack', text.includes('空包（空包）'))
check('ungrouped tool is listed as single-tool unlockable', text.includes('py_text_stats') && text.includes('tool 单独解锁'))
check('counts match enabled members only', text.includes('mcdev-docs（2 个工具'))

const locked = buildPackContextText({ settings: { unlockMode: true, allowUngroupedUnlock: false }, packs, records })
check('ungrouped hint changes when single-tool unlock is off', locked.includes('不可单独解锁') && !locked.includes('tool 单独解锁'))

const noPacks = buildPackContextText({ settings: on, packs: [], records: [] })
check('empty pack list has its own line', noPacks.includes('还没有工具包'))

const orphan = buildPackContextText({ settings: on, packs, records: [{ name: 'orphan_tool', packId: 'gone', enabled: true }] })
check('a tool whose pack vanished becomes ungrouped', orphan.includes('orphan_tool'))

check('text stays compact', text.length < 900, `${text.length} chars`)

if (fails.length > 0) {
  console.log(`\nFAILED: ${fails.length}`)
  process.exit(1)
}
console.log('\nALL PASS')

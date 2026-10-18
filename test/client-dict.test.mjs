import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const fails = []
const check = (label, condition, extra) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` -> ${extra}`}`)
  if (!condition) fails.push(label)
}

let captured = null
let loaderId = ''
let moduleShape = null

const ReactStub = {
  createElement: (...args) => ({ type: 'el', args }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useSyncExternalStore: () => 0,
}

const localeStub = {
  register(ns, dicts) {
    captured = { ns, dicts }
    return () => {}
  },
  bind() {
    return (key) => key
  },
  getSnapshot: () => ({ active: 'zh', revision: 1 }),
  subscribe: () => () => {},
}

const sandbox = {
  ReactStub,
  window: {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaderId = id
        const module = factory((name) => {
          if (name === 'react') return ReactStub
          throw new Error(`unexpected require: ${name}`)
        })
        moduleShape = module
        const ctx = {
          slots: {
            inject(name, callback) {
              callback()
              return () => {}
            },
            register() {
              return () => {}
            },
          },
          get(name) {
            return name === 'locale' ? localeStub : undefined
          },
          effect(fn) {
            return typeof fn === 'function' ? fn() : undefined
          },
          on() {},
        }
        module.apply(ctx)
      },
    },
    console,
  },
  console,
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('loader id', loaderId === 'dsh-custom-tool-studio', loaderId)
check('module exports apply+inject', typeof moduleShape?.apply === 'function' && Array.isArray(moduleShape?.inject))
check('inject list', JSON.stringify(moduleShape?.inject) === JSON.stringify(['slots', 'locale', 'layout']))
check('dictionaries registered', captured !== null && captured.ns === 'dsh-custom-tool-studio')
const zh = captured?.dicts?.zh ?? {}
const en = captured?.dicts?.en ?? {}
const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
check('zh/en key parity', JSON.stringify(zhKeys) === JSON.stringify(enKeys), `${zhKeys.length} vs ${enKeys.length}`)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  check('missing in en', enKeys.every((key) => key in zh) ? 'ok' : enKeys.filter((key) => !(key in zh)).join(','))
}

// placeholder parity
const placeholders = (text) => (String(text).match(/\{(\w+)\}/g) ?? []).sort().join(',')
const badPlaceholders = zhKeys.filter((key) => placeholders(zh[key]) !== placeholders(en[key]))
check('placeholder parity', badPlaceholders.length === 0, badPlaceholders.join(','))

// every key the code asks for exists
const used = new Set()
for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(match[1])
for (const match of source.matchAll(/\bfmt\(\s*t\s*,\s*'([a-zA-Z0-9_.]+)'/g)) used.add(match[1])
const missing = [...used].filter((key) => !(key in zh))
check('every used key exists', missing.length === 0, missing.join(','))
check('settings keys present', ['settings.button', 'settings.title', 'settings.approveCreate', 'settings.approveUpdate', 'settings.approveDelete', 'settings.save', 'settings.saving', 'settings.error'].every((key) => key in zh))

console.log(`\nzh keys: ${zhKeys.length}, used keys: ${used.size}`)
console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILED: ${fails.join(', ')}`)
process.exit(fails.length === 0 ? 0 : 1)

/**
 * Python execution for custom tools.
 *
 * Contract with the user's script: it must define `def run(args): ...` and
 * return any JSON-serializable value. The host never parses the script's
 * stdout for data — stdout/stderr are captured as logs, and the real result
 * travels through a separate JSON file, so `print()` inside a tool can never
 * corrupt the payload.
 *
 * No stdio pipes are used: the child gets inheritable file descriptors for
 * stdout/stderr and reads/writes plain files. That keeps execution working in
 * every confined environment the Harness may run under.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Runner written next to the store; always executed for a tool call. */
const RUNNER_SOURCE = [
  '"""DSH custom tool runner (generated; do not edit).',
  '',
  'Usage: python runner.py <script.py> <args.json> <result.json>',
  '"""',
  'import importlib.util',
  'import json',
  'import sys',
  'import traceback',
  '',
  '',
  'def _fallback(value):',
  '    try:',
  '        return str(value)',
  '    except Exception:',
  '        return "<unserializable>"',
  '',
  '',
  'def main():',
  '    script_path, args_path, result_path = sys.argv[1], sys.argv[2], sys.argv[3]',
  '    args = {}',
  '    try:',
  '        with open(args_path, "r", encoding="utf-8") as handle:',
  '            loaded = json.load(handle)',
  '        if isinstance(loaded, dict):',
  '            args = loaded',
  '    except Exception:',
  '        args = {}',
  '    try:',
  '        spec = importlib.util.spec_from_file_location("dsh_custom_tool", script_path)',
  '        if spec is None or spec.loader is None:',
  '            raise RuntimeError("cannot load tool script: " + script_path)',
  '        module = importlib.util.module_from_spec(spec)',
  '        spec.loader.exec_module(module)',
  '        entry = getattr(module, "run", None)',
  '        if not callable(entry):',
  '            raise RuntimeError("the tool script must define a callable run(args) function")',
  '        payload = {"ok": True, "result": entry(args)}',
  '    except BaseException:',
  '        payload = {"ok": False, "error": traceback.format_exc(limit=12)}',
  '    try:',
  '        with open(result_path, "w", encoding="utf-8") as handle:',
  '            json.dump(payload, handle, ensure_ascii=False, default=_fallback)',
  '    except Exception:',
  '        with open(result_path, "w", encoding="utf-8") as handle:',
  '            json.dump({"ok": False, "error": "result is not JSON serializable"}, handle, ensure_ascii=False)',
  '    return 0',
  '',
  '',
  'if __name__ == "__main__":',
  '    sys.exit(main())',
  '',
].join('\n')

/** Default per-run budget. */
const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_CUSTOM_TOOL_TIMEOUT_MS) > 0
  ? Number(process.env.DSH_CUSTOM_TOOL_TIMEOUT_MS)
  : 60_000

const MAX_CAPTURE = 8_000
const MAX_CONTENT = 20_000
const KEEP_RUNS = 30

let cachedPython

/**
 * Locate a usable Python interpreter (cached for the process lifetime).
 * @returns {{ ok: boolean, command?: string, version?: string, error?: string, args?: string[] }}
 */
export function detectPython() {
  if (cachedPython !== undefined) return cachedPython
  const probe = 'import sys;print(sys.version.split()[0])'
  const configured = typeof process.env.DSH_CUSTOM_TOOL_PYTHON === 'string' ? process.env.DSH_CUSTOM_TOOL_PYTHON.trim() : ''
  const candidates = []
  if (configured !== '') candidates.push({ command: configured, args: [] })
  candidates.push({ command: 'python', args: [] })
  candidates.push({ command: 'python3', args: [] })
  candidates.push({ command: 'py', args: ['-3'] })
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate.command, [...candidate.args, '-c', probe], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      })
      const version = typeof result.stdout === 'string' ? result.stdout.trim() : ''
      if (result.status === 0 && version !== '') {
        cachedPython = { ok: true, command: candidate.command, args: candidate.args, version }
        return cachedPython
      }
    } catch {
      /* try the next candidate */
    }
  }
  cachedPython = {
    ok: false,
    error: '未检测到可用的 Python。请安装 Python 3 并确保 `python` 在 PATH 中，或设置环境变量 DSH_CUSTOM_TOOL_PYTHON 指向解释器。',
  }
  return cachedPython
}

/** Clip a captured stream, keeping the tail (errors live at the end). */
function clip(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return `…(前 ${value.length - limit} 字符已省略)\n${value.slice(-limit)}`
}

/** Render an arbitrary JSON value as readable text. */
function renderContent(result) {
  let text
  try {
    text = JSON.stringify(result, null, 2)
  } catch {
    text = String(result)
  }
  if (text === undefined) text = 'null'
  return clip(text, MAX_CONTENT)
}

/** Keep the newest `KEEP_RUNS` scratch directories and drop the rest. */
function pruneRuns(runsDir) {
  try {
    const entries = readdirSync(runsDir)
      .map((name) => {
        const path = join(runsDir, name)
        try {
          return { path, time: statSync(path).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((entry) => entry !== undefined)
      .sort((left, right) => right.time - left.time)
    for (const entry of entries.slice(KEEP_RUNS)) rmSync(entry.path, { recursive: true, force: true })
  } catch {
    /* pruning is best effort */
  }
}

/** Write the runner once per process/store. */
function ensureRunner(rootDir) {
  const runnerPath = join(rootDir, 'runner.py')
  try {
    if (!existsSync(runnerPath) || readFileSync(runnerPath, 'utf8') !== RUNNER_SOURCE) {
      writeFileSync(runnerPath, RUNNER_SOURCE, 'utf8')
    }
  } catch {
    /* the runner is also recoverable from the script below */
  }
  return runnerPath
}

/** Run the child process and resolve with its terminal state. */
function waitForExit(child, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    let onAbort
    const finish = (state) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined && signal !== undefined) {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          /* ignore */
        }
      }
      resolve(state)
    }
    const terminate = (reason) => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ code: null, reason })
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => terminate('timeout'), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        terminate('aborted')
        return
      }
      onAbort = () => terminate('aborted')
      try {
        signal.addEventListener('abort', onAbort, { once: true })
      } catch {
        /* ignore */
      }
    }
    child.on('error', (error) => finish({ code: null, reason: `spawn: ${error?.message ?? error}` }))
    child.on('exit', (code, exitSignal) => finish({ code, exitSignal, reason: undefined }))
  })
}

/**
 * Execute one stored tool record.
 * @param {{ name: string, code: string }} record the tool.
 * @param {unknown} args parsed tool arguments handed to `run(args)`.
 * @param {{ rootDir: string, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, result: unknown, content: string, stdout: string, stderr: string, durationMs: number, error?: string }>}
 */
export async function runPython(record, args, options = {}) {
  const startedAt = Date.now()
  const empty = {
    ok: false,
    result: null,
    content: '',
    stdout: '',
    stderr: '',
    durationMs: 0,
    error: undefined,
  }
  const python = detectPython()
  if (!python.ok) {
    return { ...empty, content: python.error, error: python.error, durationMs: Date.now() - startedAt }
  }
  const rootDir = typeof options.rootDir === 'string' ? options.rootDir : ''
  if (rootDir === '') {
    const error = '插件配置缺失：无法确定自定义工具数据目录'
    return { ...empty, content: error, error, durationMs: Date.now() - startedAt }
  }

  const runsDir = join(rootDir, 'runs')
  const runDir = join(runsDir, `r_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`)
  const scriptPath = join(runDir, 'tool.py')
  const argsPath = join(runDir, 'args.json')
  const resultPath = join(runDir, 'result.json')
  const stdoutPath = join(runDir, 'stdout.txt')
  const stderrPath = join(runDir, 'stderr.txt')
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  mkdirSync(runDir, { recursive: true })
  writeFileSync(scriptPath, typeof record.code === 'string' ? record.code : '', 'utf8')
  writeFileSync(argsPath, JSON.stringify(args !== null && typeof args === 'object' ? args : {}), 'utf8')
  const runnerPath = ensureRunner(rootDir)

  let stdoutFd
  let stderrFd
  let state
  try {
    stdoutFd = openSync(stdoutPath, 'w')
    stderrFd = openSync(stderrPath, 'w')
    const child = spawn(python.command, [...(python.args ?? []), runnerPath, scriptPath, argsPath, resultPath], {
      stdio: ['ignore', stdoutFd, stderrFd],
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    state = await waitForExit(child, { timeoutMs, signal: options.signal })
  } catch (error) {
    state = { code: null, reason: `spawn: ${error?.message ?? error}` }
  } finally {
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd === undefined) continue
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }

  const readOr = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  const stdout = clip(readOr(stdoutPath), MAX_CAPTURE)
  const stderr = clip(readOr(stderrPath), MAX_CAPTURE)
  const durationMs = Date.now() - startedAt

  let payload
  try {
    payload = JSON.parse(readOr(resultPath))
  } catch {
    payload = undefined
  }

  let ok = false
  let result = null
  let error
  if (state?.reason === 'timeout') {
    error = `执行超时（上限 ${timeoutMs} ms），进程已终止`
  } else if (state?.reason === 'aborted') {
    error = '执行已取消'
  } else if (state?.reason !== undefined) {
    error = `无法启动 Python：${state.reason}`
  } else if (payload !== undefined && payload?.ok === true) {
    ok = true
    result = payload.result === undefined ? null : payload.result
  } else if (payload !== undefined && payload?.ok === false) {
    error = typeof payload.error === 'string' ? payload.error : '脚本执行失败（未返回错误详情）'
  } else {
    const code = state?.code === null || state?.code === undefined ? 'unknown' : String(state.code)
    error = `Python 进程结束但未产出结果（退出码 ${code}）`
  }

  pruneRuns(runsDir)

  return {
    ok,
    result,
    content: ok ? renderContent(result) : String(error ?? ''),
    stdout,
    stderr,
    durationMs,
    error: ok ? undefined : String(error ?? ''),
  }
}

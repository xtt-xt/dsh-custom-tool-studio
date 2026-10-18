/**
 * Loopback HTTP routes for the custom tool studio page.
 *
 * The page talks to the Host over same-origin `fetch` with document-relative
 * URLs; the Host answers on exact `/api/custom-tool-studio/*` paths and fences
 * every request to the loopback interface, mirroring how shipped local plugins
 * protect their own routes.
 */
import { Buffer } from 'node:buffer'

const PREFIX = '/api/custom-tool-studio'

/** Exact route paths (mirrored, document-relative, in client.js). */
export const ROUTES = {
  list: `${PREFIX}/list`,
  create: `${PREFIX}/create`,
  update: `${PREFIX}/update`,
  delete: `${PREFIX}/delete`,
  setEnabled: `${PREFIX}/set-enabled`,
  test: `${PREFIX}/test`,
  settings: `${PREFIX}/settings`,
  packs: `${PREFIX}/packs`,
  packCreate: `${PREFIX}/pack-create`,
  packUpdate: `${PREFIX}/pack-update`,
  packDelete: `${PREFIX}/pack-delete`,
  packSetEnabled: `${PREFIX}/pack-set-enabled`,
  health: `${PREFIX}/health`,
}

const MAX_BODY = 2_000_000

/** IPv4 127/8 predicate. */
function isIPv4Loopback(value) {
  const parts = String(value).split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket address names the loopback range. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a URL hostname names the loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: loopback socket AND loopback Host header, plus
 * same-origin browser markers. The socket address is authoritative.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const text = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Read and parse a JSON request body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Build every studio route.
 * @param {object} engine shared operations (same ones the agent tool uses).
 * @param {{ logger?: { warn?: (value: unknown) => void } }} [options] logging sink.
 * @returns {Array<{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }>}
 */
export function makeRoutes(engine, options = {}) {
  const logger = options.logger ?? {}

  /** Method + trust fence. */
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${String(req.method)}` })
      return false
    }
    return true
  }

  /** Wrap a handler so every failure becomes a JSON error instead of a hang. */
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = /不存在/.test(message) ? 404 : /已存在|占用/.test(message) ? 409 : 400
      try {
        logger.warn?.(`[custom-tool-studio] ${message}`)
      } catch {
        /* ignore */
      }
      try {
        writeJson(res, status, { error: message })
      } catch {
        /* response already gone */
      }
    }
  }

  return [
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const python = engine.pythonInfo()
        writeJson(res, 200, { ok: true, python, pythonReady: python.ok === true, paths: engine.paths })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.list,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const python = engine.pythonInfo()
        writeJson(res, 200, {
          tools: engine.list(),
          packs: engine.listPacks(),
          python,
          pythonReady: python.ok === true,
          paths: engine.paths,
          settings: engine.getSettings(),
        })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.packs,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, { packs: engine.listPacks() })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.packCreate,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const pack = engine.createPack({
          name: body?.name,
          description: body?.description,
          tools: body?.tools,
          alwaysUnlocked: body?.alwaysUnlocked,
        })
        writeJson(res, 200, { pack })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.packUpdate,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        const pack = engine.updatePack(id, {
          name: body?.name,
          description: body?.description,
          tools: body?.tools,
          alwaysUnlocked: body?.alwaysUnlocked,
        })
        writeJson(res, 200, { pack })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.packDelete,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        const outcome = engine.removePack(id)
        writeJson(res, 200, { deleted: true, pack: outcome.pack, tools: outcome.tools })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.packSetEnabled,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        const outcome = engine.setPackEnabled(id, body?.enabled === true)
        writeJson(res, 200, { pack: outcome.pack, tools: outcome.tools })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.settings,
      handler: handle(async (req, res) => {
        if (req.method === 'GET' && isLoopbackRequest(req)) {
          writeJson(res, 200, { settings: engine.getSettings(), defaults: engine.defaultSettings() })
          return
        }
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        writeJson(res, 200, { settings: engine.setSettings(body) })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.create,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const tool = engine.create(body)
        writeJson(res, 200, { tool })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.update,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        const tool = engine.update(id, body)
        writeJson(res, 200, { tool })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.delete,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        engine.removeRecord(id)
        writeJson(res, 200, { deleted: true })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.setEnabled,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        const tool = engine.setEnabled(id, body?.enabled === true)
        writeJson(res, 200, { tool })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.test,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const record = typeof body?.id === 'string' && body.id !== ''
          ? engine.get(body.id)
          : engine.findByName(typeof body?.name === 'string' ? body.name : '')
        if (record === undefined) throw new Error('工具不存在（可能已被删除）')
        const outcome = await engine.runRecord(record, body?.args ?? {}, {})
        writeJson(res, 200, {
          ok: outcome?.ok === true,
          result: outcome?.result ?? null,
          content: outcome?.content ?? '',
          stdout: outcome?.stdout ?? '',
          stderr: outcome?.stderr ?? '',
          durationMs: outcome?.durationMs ?? 0,
          error: outcome?.error ?? '',
        })
      }),
    },
  ]
}

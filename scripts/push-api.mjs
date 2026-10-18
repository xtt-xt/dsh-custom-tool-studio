/**
 * Push the current git HEAD tree to GitHub through the REST Git Data API.
 *
 * Needed because this machine cannot reach github.com:443 with `git push`,
 * while api.github.com works. Uses one blob per tracked file, so the resulting
 * remote commit has exactly the same tree as the local commit.
 *
 *   $env:GH_TOKEN = '<pat>'; node scripts/push-api.mjs <owner>/<repo> <branch> <messageFile>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [slug, branch = 'main', messageFile] = process.argv.slice(2)
if (!slug) {
  console.error('usage: node push-api.mjs <owner/repo> [branch] [messageFile]')
  process.exit(2)
}
const token = process.env.GH_TOKEN ?? ''
if (token === '') {
  console.error('missing GH_TOKEN')
  process.exit(2)
}
const [owner, repo] = slug.split('/')
const message = (messageFile ? readFileSync(messageFile, 'utf8') : 'chore: publish').replace(/^\uFEFF/, '')

const api = async (path, init) => {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-agent',
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  if (!response.ok) {
    const error = new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status} ${body.message ?? ''}`)
    error.body = body
    throw error
  }
  return body
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const author = {
  name: execFileSync('git', ['log', '-1', '--format=%an'], { encoding: 'utf8' }).trim(),
  email: execFileSync('git', ['log', '-1', '--format=%ae'], { encoding: 'utf8' }).trim(),
  date: new Date().toISOString(),
}

console.log(`files: ${files.length}; author: ${author.name} <${author.email}>`)

const entries = []
for (const path of files) {
  const content = readFileSync(path)
  const blob = await api('/git/blobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${blob.sha.slice(0, 8)} ${path}`)
}

const tree = await api('/git/trees', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tree: entries }),
})
console.log(`tree ${tree.sha}`)

// An empty repository rejects blob/tree creation, so the branch may already
// carry a bootstrap commit; keep it as the parent instead of losing it.
let parent = null
try {
  const head = await api(`/git/ref/heads/${branch}`)
  parent = head.object?.sha ?? null
} catch (error) {
  if (error.body?.status !== 404) throw error
}
console.log(`parent ${parent ?? '(none)'}`)

const commit = await api('/git/commits', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, tree: tree.sha, parents: parent === null ? [] : [parent], author, committer: author }),
})
console.log(`commit ${commit.sha}`)

let ref = null
try {
  ref = await api('/git/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  })
} catch (error) {
  if (error.body?.message !== 'Reference already exists') throw error
  ref = await api(`/git/refs/heads/${branch}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha: commit.sha, force: true }),
  })
}
console.log(`ref ${ref.ref} -> ${ref.object.sha}`)
console.log(`https://github.com/${owner}/${repo}/commit/${commit.sha}`)

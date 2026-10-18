#!/usr/bin/env node
/**
 * Run every offline suite in this directory, one process each.
 *
 *   node test/run.mjs      (or: npm test)
 *
 * Each suite prints PASS/FAIL lines and ends with `ALL PASS`; this runner only
 * aggregates the exit codes and prints one line per suite.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()

let failed = 0
for (const suite of suites) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' })
  const elapsed = Date.now() - started
  if (result.status !== 0) {
    failed += 1
    console.log(`\nFAIL ${suite} (${elapsed} ms)`)
  } else {
    console.log(`\nPASS ${suite} (${elapsed} ms)`)
  }
}

console.log(failed === 0 ? `\nALL SUITES PASS (${suites.length})` : `\nFAILED SUITES: ${failed}/${suites.length}`)
process.exit(failed === 0 ? 0 : 1)

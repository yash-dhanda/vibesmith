import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectVerify, runVerify } from '../main/agent/commands'
import { buildProvider } from '../main/agent/factory'
import { runAgent, systemPromptFor, type AgentEvent } from '../main/agent/loop'
import type { Message } from '../main/agent/provider'
import { ToolBox } from '../main/agent/tools'
import { SkillStore } from '../main/skills'
import { setHost } from '../main/ollamaHost'
import { setRoot } from '../main/project'

// Two hard real-life problems for the Solo agent (the same loop and system prompt as a Solo chat) on the PC's model. Each is judged by a hidden check that runs real code, never by the agent's own report.
// Run: HARD=orders|reconcile EVAL_MODEL=ollama:qwen3-coder:30b EVAL_HOST=http://100.86.69.33:11434 npx vitest run --config vitest.eval.config.ts hard.eval
const HERE = join(process.cwd(), 'src/eval/hard')
const which = process.env.HARD ?? 'orders'
const LOG = `eval-results/hard-${which}${process.env.EVAL_TAG ?? ''}.log`
mkdirSync('eval-results', { recursive: true })
writeFileSync(LOG, '')
const line = (s: string) => (console.log(s), appendFileSync(LOG, s + '\n'))
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

type Problem = { seed: string; goal: string; verify: string; check: (dir: string) => string[] }

const RECONCILE_GOAL = `Write reconcile.js (Node, CommonJS, no npm packages). Usage: node reconcile.js <bank.csv> <ledger.csv>. It writes report.json in the current folder and prints one line: matched=N unmatchedBank=N unmatchedLedger=N duplicates=N

Files: bank.csv has the header id,date,description,amount. ledger.csv has the header ref,date,memo,amount. A field may be in double quotes and may then contain commas, and "" inside quotes means one quote mark. Ignore blank lines.
Dates are YYYY-MM-DD or DD/MM/YYYY (a date with slashes is always day first).
Amounts may look like 1,234.50, ₹2,000.00, $15, -75.25, 0.1 or (500.00). Parentheses mean negative. Work in integer minor units (cents/paise) and never in floating-point money.

Duplicates: a bank row is a duplicate when an EARLIER bank row has the same date, the same amount and the same description (compare the description trimmed, lower-case, with runs of spaces collapsed). Duplicates are listed in "duplicates" and are never matched.
Matching: go through the non-duplicate bank rows in file order. Match each to the not-yet-matched ledger row that has the same amount and a date within 3 calendar days (either direction). If several qualify, take the one with the smallest date gap; on a tie take the one earlier in the ledger file. A ledger row is matched at most once.

report.json is {"matched":[{"bank":"<id>","ledger":"<ref>"}],"unmatchedBank":[ids],"unmatchedLedger":[refs],"duplicates":[ids]}. All ids and refs are strings, each list is in file order (matched in bank file order). Small sample files bank.csv and ledger.csv are in the folder: run your program on them. Do not hard-code any data.`

const ORDERS_GOAL = `The tests in this project fail: run "node test.js". Customers report: tax is wrong on some small amounts, the second page of a list shows the wrong items, items from one shopping cart show up in another, due dates are wrong for customers in California, and tasks come out in the wrong order.
Find the real cause of each failing test in src/ and fix it there. Do not edit test.js. Keep the fixes small and in the existing style. When you are done, "node test.js" must print "all passed", and you must say which tests you ran and what they printed.`

const reconcileCheck = (dir: string): string[] => {
  const bad: string[] = []
  const run = mkdtempSync(join(tmpdir(), 'hard-run-'))
  cpSync(join(HERE, 'hidden-bank.csv'), join(run, 'bank.csv'))
  cpSync(join(HERE, 'hidden-ledger.csv'), join(run, 'ledger.csv'))
  const want = mkdtempSync(join(tmpdir(), 'hard-want-'))
  cpSync(join(run, 'bank.csv'), join(want, 'bank.csv'))
  cpSync(join(run, 'ledger.csv'), join(want, 'ledger.csv'))
  execFileSync(process.execPath, [join(HERE, 'ref-reconcile.cjs'), 'bank.csv', 'ledger.csv'], { cwd: want })
  if (!existsSync(join(dir, 'reconcile.js'))) return ['reconcile.js does not exist']
  let stdout = ''
  try {
    stdout = execFileSync(process.execPath, [join(dir, 'reconcile.js'), 'bank.csv', 'ledger.csv'], { cwd: run, encoding: 'utf8', timeout: 20_000, stdio: 'pipe' })
  } catch (e) {
    return ['crashed on the hidden data: ' + String((e as { stderr?: string }).stderr ?? e).split('\n').slice(0, 3).join(' | ').slice(0, 300)]
  }
  if (!existsSync(join(run, 'report.json'))) return ['no report.json written']
  const got = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8'))
  const exp = JSON.parse(readFileSync(join(want, 'report.json'), 'utf8'))
  for (const k of Object.keys(exp)) if (JSON.stringify(got[k]) !== JSON.stringify(exp[k])) bad.push(`${k}: expected ${JSON.stringify(exp[k])} got ${JSON.stringify(got[k])}`)
  if (!/matched=8 unmatchedBank=1 unmatchedLedger=4 duplicates=2/.test(stdout)) bad.push('summary line wrong: ' + stdout.trim().slice(0, 120))
  return bad
}

const ordersCheck = (dir: string): string[] => {
  const bad: string[] = []
  if (sha(join(dir, 'test.js')) !== sha(join(HERE, 'seed-orders/test.js'))) bad.push('test.js was edited')
  try {
    execFileSync(process.execPath, ['test.js'], { cwd: dir, stdio: 'pipe', timeout: 30_000 })
  } catch (e) {
    bad.push('node test.js still fails: ' + String((e as { stdout?: Buffer }).stdout ?? '').split('\n').filter((l) => l.startsWith('FAIL')).join(' | ').slice(0, 300))
  }
  const hidden = `
    const assert = require('node:assert/strict')
    const { tax, total } = require('./src/pricing'); const { paginate } = require('./src/paginate')
    const { createCart } = require('./src/cart'); const { addBusinessDays } = require('./src/dates'); const { byPriority } = require('./src/sort')
    assert.equal(tax(5, 10), 1); assert.equal(tax(0, 8), 0); assert.equal(total([{ cents: 333, qty: 3 }], { taxPct: 7 }), 1069)
    assert.equal(paginate([], 1, 2).totalPages, 0); assert.deepEqual(paginate([1, 2, 3], 5, 2).items, []); assert.deepEqual(paginate([1, 2, 3, 4], 2, 2).items, [3, 4]); assert.equal(paginate([1, 2, 3, 4], 1, 2).totalPages, 2)
    const a = createCart(); const b = createCart(); a.add(1); assert.deepEqual(b.items, []); const src = [9]; const c = createCart(src); c.add(2); assert.deepEqual(src, [9]); assert.deepEqual(c.items, [9, 2])
    assert.equal(addBusinessDays('2026-03-31', 1), '2026-04-01'); assert.equal(addBusinessDays('2026-02-27', 1), '2026-03-02'); assert.equal(addBusinessDays('2026-03-08', 1), '2026-03-09'); assert.equal(addBusinessDays('2026-03-07', 3), '2026-03-11'); assert.equal(addBusinessDays('2026-03-04', 0), '2026-03-04'); assert.equal(addBusinessDays('2026-12-31', 2), '2027-01-04')
    const t = [{ id: 'a', priority: 2 }, { id: 'b', priority: 2 }, { id: 'c', priority: 10 }, { id: 'd', priority: 9 }]; assert.deepEqual(byPriority(t).map((x) => x.id), ['c', 'd', 'a', 'b']); assert.equal(t[0].id, 'a')`
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
    try {
      execFileSync(process.execPath, ['-e', hidden], { cwd: dir, env: { ...process.env, TZ }, stdio: 'pipe', timeout: 20_000 })
    } catch (e) {
      bad.push(`hidden checks failed in ${TZ}: ` + String((e as { stderr?: Buffer }).stderr ?? '').split('\n').find((l) => /Error|assert|expected|actual/i.test(l))?.slice(0, 200))
    }
  }
  return bad
}

// HARD=custom HARD_SEED=/path/to/project HARD_GOAL="..." : a read-only copy of a real project (no secrets, no node_modules, no .git); no hidden check, you read the trace.
const SKIP = /(^|\/)(\.env[^/]*|node_modules|\.next|\.git|\.forge|\.impeccable|\.secrets?[^/]*|[^/]*\.pem|[^/]*\.key)$/
const PROBLEMS: Record<string, Problem> = {
  custom: { seed: process.env.HARD_SEED ?? '', goal: process.env.HARD_GOAL ?? '', verify: '', check: () => [] },
  reconcile: { seed: 'seed-reconcile', goal: RECONCILE_GOAL, verify: 'node reconcile.js bank.csv ledger.csv', check: reconcileCheck },
  orders: { seed: 'seed-orders', goal: ORDERS_GOAL, verify: 'node test.js', check: ordersCheck },
}

describe.skipIf(!process.env.HARD)('hard problem', () => {
  it(`solo agent solves ${which}`, async () => {
    const p = PROBLEMS[which]
    const MODEL = process.env.EVAL_MODEL ?? 'ollama:qwen3-coder:30b'
    if (process.env.EVAL_HOST) setHost(process.env.EVAL_HOST, 24)
    const provider = buildProvider(MODEL, () => null, { numCtx: 32_768 })
    line(`problem: ${which}   model: ${MODEL}   host: ${process.env.EVAL_HOST ?? 'local'}`)
    const dir = mkdtempSync(join(tmpdir(), 'forge-hard-p-'))
    cpSync(p.seed.startsWith('/') ? p.seed : join(HERE, p.seed), dir, { recursive: true, filter: (src) => !SKIP.test(src) })
    sh(dir, 'init', '-q')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-q', '-m', 'init')
    setRoot(dir)
    const messages: Message[] = [{ role: 'system', content: systemPromptFor({ skills: process.env.HARD_SKILLS ? new SkillStore(join(process.env.HOME ?? '', '.config/forge/skills')).inline() : '' }) }, { role: 'user', content: p.goal }]
    const events: AgentEvent[] = []
    const ctl = new AbortController()
    const tools = new ToolBox(dir)
    tools.maxRead = 20_000
    const verifyCmd = detectVerify(dir)
    const t0 = Date.now()
    let reply = ''
    const s = () => `[${Math.round((Date.now() - t0) / 1000)}s]`
    await runAgent({
      messages, provider, tools, mode: 'full-auto', maxSteps: 60, maxMs: 40 * 60_000, contextLimit: 32_768,
      emit: (e) => {
        events.push(e)
        if (e.type === 'tool') line(`${s()} > ${e.name} ${JSON.stringify(e.args).slice(0, 160)}`)
        else if (e.type === 'tool_result') line(`${s()}     = ${e.text.replace(/\n/g, ' / ').slice(0, 200)}`)
        else if (e.type === 'verify') line(`${s()} VERIFY ${e.ok ? 'PASS' : 'FAIL'} ${e.command}`)
        else if (e.type === 'note') line(`${s()} NOTE ${e.text}`)
        else if (e.type === 'error') line(`${s()} ERROR ${e.message}`)
        else if (e.type === 'delta') reply += e.text
        else if (e.type === 'turn_end') { if (reply.trim()) line(`${s()} SAYS ${reply.trim().replace(/\s+/g, ' ').slice(0, 700)}`); reply = '' }
        else if (e.type === 'done') line(`${s()} DONE ${e.reason} after ${e.steps} steps`)
      },
      approve: async () => true, signal: ctl.signal,
      verify: verifyCmd ? () => runVerify(verifyCmd, dir, ctl.signal) : undefined,
    })
    const tok = events.reduce((n, e) => (e.type === 'usage' ? n + e.input + e.output : n), 0)
    line(`\nseconds=${Math.round((Date.now() - t0) / 1000)} tokens=${tok}`)
    const bad = p.check(dir)
    line(bad.length ? `HIDDEN CHECK: FAIL\n  - ${bad.join('\n  - ')}` : 'HIDDEN CHECK: PASS')
    line('PROJECT FILES: ' + sh(dir, 'status', '--short').replace(/\n/g, ' | '))
    expect(bad).toEqual([])
  }, 3_000_000)
})

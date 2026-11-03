import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Ten small, fixed tasks. Each one is checked by running real code, never by asking a model.
// A check returns null on success or a short reason on failure.
export type Task = { name: string; files: Record<string, string>; goal: string; check: (dir: string) => string | null }

const node = (dir: string, code: string): string | null => {
  try {
    execFileSync(process.execPath, ['-e', code], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 10_000 })
    return null
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string }
    return (err.stderr?.toString() || err.message).split('\n').find((l) => /Error|assert|FAIL/i.test(l))?.slice(0, 160) ?? 'check failed'
  }
}
const out = (dir: string, file: string): string => {
  try {
    return execFileSync(process.execPath, [file], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return '(crashed)'
  }
}
const all = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? all(join(dir, n)).map((f) => join(n, f)) : [n]))
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8')

const TEST_JS = "const { top3 } = require('./sort')\nconst got = JSON.stringify(top3([5, 1, 9, 3, 7]))\nif (got !== '[9,7,5]') {\n  console.error('FAIL: top3 expected [9,7,5], got ' + got)\n  process.exit(1)\n}\nconsole.log('ok')\n"

export const TASKS: Task[] = [
  {
    name: 'fix-wrong-operator',
    files: { 'add.js': 'function add(a, b) {\n  return a - b\n}\n\nmodule.exports = { add }\n' },
    goal: 'add() in add.js returns the wrong result. Fix it.',
    check: (d) => node(d, "const { add } = require('./add.js'); if (add(2, 3) !== 5 || add(-1, 1) !== 0) throw new Error('add wrong')"),
  },
  {
    name: 'rename-function',
    files: { 'calc.js': 'function calc(x) {\n  return x * 2\n}\n\nmodule.exports = { calc }\n', 'main.js': "const { calc } = require('./calc')\nconsole.log(calc(21))\n" },
    goal: 'Rename the function calc to compute everywhere in this project. Keep the behaviour the same.',
    check: (d) => node(d, "const m = require('./calc.js'); if (typeof m.compute !== 'function' || m.calc) throw new Error('not renamed')") ?? (out(d, 'main.js') === '42' ? null : 'main.js no longer prints 42'),
  },
  {
    name: 'add-function',
    files: { 'util.js': 'function sum(a, b) {\n  return a + b\n}\n\nmodule.exports = { sum }\n' },
    goal: 'Add a function isEven(n) to util.js that returns true for even numbers, and export it.',
    check: (d) => node(d, "const u = require('./util.js'); if (u.isEven(4) !== true || u.isEven(7) !== false || u.sum(1, 2) !== 3) throw new Error('isEven wrong')"),
  },
  {
    name: 'fix-failing-test',
    files: {
      'package.json': '{ "name": "demo", "scripts": { "test": "node test.js" } }\n',
      'sort.js': 'function top3(list) {\n  return list.slice().sort((a, b) => b - a).slice(0, 2)\n}\n\nmodule.exports = { top3 }\n',
      'test.js': TEST_JS,
    },
    goal: 'npm test fails. Make it pass without editing test.js.',
    check: (d) => (read(d, 'test.js') !== TEST_JS ? 'test.js was edited' : out(d, 'test.js') === 'ok' ? null : 'tests still fail'),
  },
  {
    name: 'edit-json',
    files: { 'config.json': '{\n  "name": "app",\n  "port": 3000\n}\n' },
    goal: 'In config.json change the port to 8080 and add a key "debug" set to true.',
    check: (d) => {
      try {
        const j = JSON.parse(read(d, 'config.json'))
        return j.port === 8080 && j.debug === true && j.name === 'app' ? null : 'wrong values: ' + JSON.stringify(j)
      } catch {
        return 'config.json is not valid JSON'
      }
    },
  },
  {
    name: 'fix-typo-everywhere',
    files: {
      'src/a.js': '// we recieve a message\nmodule.exports = () => "recieve"\n',
      'src/b.js': 'function onRecieve() {}\nmodule.exports = { note: "do not recieve twice" }\n',
      'README.md': '# demo\nHow we recieve data.\n',
    },
    goal: 'The word "recieve" is misspelled in several places in this project. Fix every occurrence (also in function names).',
    check: (d) => {
      const text = all(d).map((f) => read(d, f)).join('\n')
      return /recieve/i.test(text) ? 'a misspelling is left' : /receive/i.test(text) ? null : 'the words were deleted'
    },
  },
  {
    name: 'default-parameter',
    files: { 'greet.js': "function greet(name) {\n  return 'hello ' + name\n}\n\nmodule.exports = { greet }\n" },
    goal: "Make greet() work when called without an argument, by defaulting the name to 'world'.",
    check: (d) => node(d, "const { greet } = require('./greet.js'); if (greet() !== 'hello world' || greet('bob') !== 'hello bob') throw new Error('greet wrong')"),
  },
  {
    name: 'new-module',
    files: { 'main.js': 'console.log(6 * 7)\n' },
    goal: 'Create math.js that exports a function mul(a, b), and change main.js to use it to print the product of 6 and 7.',
    check: (d) =>
      node(d, "if (require('./math.js').mul(3, 4) !== 12) throw new Error('mul wrong')") ??
      (!/math/.test(read(d, 'main.js')) ? 'main.js does not use math.js' : out(d, 'main.js') === '42' ? null : 'main.js no longer prints 42'),
  },
  {
    name: 'find-and-answer',
    files: {
      'config/limits.js': 'const LIMIT = 42\nconst RETRIES = 3\nmodule.exports = { LIMIT, RETRIES }\n',
      'src/index.js': "const { RETRIES } = require('../config/limits')\nconsole.log(RETRIES)\n",
      'notes.txt': 'The limit is documented somewhere in the config folder.\n',
    },
    goal: 'Find the value of the constant LIMIT in this project and write just that number to answer.txt.',
    check: (d) => (existsSync(join(d, 'answer.txt')) ? (read(d, 'answer.txt').trim() === '42' ? null : `answer.txt says "${read(d, 'answer.txt').trim().slice(0, 40)}"`) : 'answer.txt was not created'),
  },
  {
    name: 'fix-syntax-error',
    files: { 'broken.js': 'function total(items) {\n  let t = 0\n  for (const i of items) {\n    t += i\n  }\n  return t\n\nmodule.exports = { total }\n' },
    goal: 'broken.js has a syntax error. Fix it without changing what total() does.',
    check: (d) => node(d, "const { total } = require('./broken.js'); if (total([1, 2, 3]) !== 6) throw new Error('total wrong')"),
  },
]

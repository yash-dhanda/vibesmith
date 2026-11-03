import { describe, expect, it } from 'vitest'
import type { Provider } from './provider'
import { parseSummaries, summarizeChanges, summaryPrompt } from './summarize'

const f = (path: string) => ({ path, status: 'added' as const, added: 3, removed: 0, excerpt: 'x' })

describe('parseSummaries', () => {
  it('reads "path: sentence" lines, tolerates bullets and backticks, ignores unknown paths', () => {
    const r = parseSummaries('- `index.html`: A page with a counter button.\nstyle.css: Centres everything.\nother.js: nope\nnoise line', ['index.html', 'style.css'])
    expect(r).toEqual({ 'index.html': 'A page with a counter button.', 'style.css': 'Centres everything.' })
  })
})

describe('summarizeChanges', () => {
  it('asks once with every file and parses the reply', async () => {
    let asked = ''
    const p: Provider = { async chat(m, _t, on) { asked = m[0].content; on('a.js: Counts clicks.'); return { content: '', toolCalls: [] } } }
    expect(await summarizeChanges(p, [f('a.js')], new AbortController().signal)).toEqual({ 'a.js': 'Counts clicks.' })
    expect(asked).toBe(summaryPrompt([f('a.js')]))
  })
  it('gives nothing when the model fails', async () => {
    const p: Provider = { async chat() { throw new Error('down') } }
    expect(await summarizeChanges(p, [f('a.js')], new AbortController().signal)).toEqual({})
  })
})

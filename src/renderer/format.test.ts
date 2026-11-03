import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../main/chatStore'
import { exportMarkdown, folderName, formatRate, formatTokens, groupOf, matchesQuery, md, timeAgo, toolTarget, toolVerb } from './format'

describe('groupOf', () => {
  const now = new Date(2026, 10, 3, 15, 0).getTime()
  const at = (daysAgo: number, hour = 9) => new Date(2026, 10, 3 - daysAgo, hour, 0).getTime()
  it('buckets by calendar day, not by 24-hour windows', () => {
    expect(groupOf(at(0, 1), now)).toBe('Today')
    expect(groupOf(at(1, 23), now)).toBe('Yesterday')
    expect(groupOf(at(3), now)).toBe('Previous 7 days')
    expect(groupOf(at(7), now)).toBe('Previous 7 days')
    expect(groupOf(at(8), now)).toBe('Older')
  })
})

describe('folderName / timeAgo / matchesQuery', () => {
  it('takes the last path segment on posix and windows', () => {
    expect(folderName('/home/dev/code/forge')).toBe('forge')
    expect(folderName('/home/dev/code/forge/')).toBe('forge')
    expect(folderName('C:\\Users\\yash\\app')).toBe('app')
    expect(folderName(null)).toBe('No folder')
  })
  it('timeAgo', () => {
    const now = 1_000_000_000
    expect(timeAgo(now - 5_000, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
  it('search matches the title or the folder, ignoring case', () => {
    const c = { title: 'Telegram Bot', project: '/home/dev/code/notifier' }
    expect(matchesQuery(c, 'telegram')).toBe(true)
    expect(matchesQuery(c, 'NOTIF')).toBe(true)
    expect(matchesQuery(c, 'zzz')).toBe(false)
    expect(matchesQuery(c, '   ')).toBe(true)
  })
})

describe('formatTokens / formatRate', () => {
  it('shows millions with two decimals, thousands compactly', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(1_234)).toBe('1.2k')
    expect(formatTokens(48_700)).toBe('49k')
    expect(formatTokens(3_420_000)).toBe('3.42M')
    expect(formatTokens(12_345_678)).toBe('12.3M')
  })
  it('rate', () => {
    expect(formatRate(38.246)).toBe('38.2')
    expect(formatRate(142.9)).toBe('143')
  })
})

describe('tool wording', () => {
  it('verbs and targets', () => {
    expect(toolVerb('create_file', {})).toBe('Created')
    expect(toolVerb('edit_file', { old_text: '' })).toBe('Created')
    expect(toolVerb('edit_file', { old_text: 'x' })).toBe('Edited')
    expect(toolVerb('weird', {})).toBe('weird')
    expect(toolTarget({ pattern: 'foo' })).toBe('foo')
    expect(toolTarget({ command: 'npm test' })).toBe('npm test')
    expect(toolTarget(null)).toBe('')
  })
})

describe('md', () => {
  it('headings, bullets and numbered lists, with bold inside', () => {
    const html = md('### Notes:\n- **Security:** keep it safe\n- Rate limits\n\n1. first\n2. second')
    expect(html).toContain('<h4>Notes:</h4>')
    expect(html).toContain('<ul><li><strong>Security:</strong> keep it safe</li><li>Rate limits</li></ul>')
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>')
  })
  it('keeps the start number of a list that continues after other text', () => {
    expect(md('3. third\n4. fourth')).toContain('<ol start="3">')
  })
  it('code blocks keep their content, show the language, and have a copy button', () => {
    const html = md('Here:\n```python\nprint("<b>hi</b>")\n```\ndone')
    expect(html).toContain('<span>python</span>')
    expect(html).toContain('class="copy"')
    expect(html).toContain('print(&quot;&lt;b&gt;hi&lt;/b&gt;&quot;)')
    expect(html).not.toContain('<b>hi</b>')
  })
  it('an unfinished code fence (mid-stream) still renders as code', () => {
    expect(md('start\n```js\nlet a = 1')).toContain('<pre><code>let a = 1</code></pre>')
  })
  it('inline code is protected from markdown, and html is never injected', () => {
    expect(md('use `**not bold**` here')).toContain('<code>**not bold**</code>')
    const evil = md('<img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3))')
    expect(evil).not.toContain('<img')
    expect(evil).not.toContain('<script')
    expect(evil).not.toContain('href="javascript')
  })
  it('links: only http(s), marked for external opening, quotes cannot break out', () => {
    expect(md('[docs](https://example.com/a?b=1&c=2)')).toContain('<a href="https://example.com/a?b=1&amp;c=2" data-ext="1">docs</a>')
    expect(md('see https://example.com now')).toContain('<a href="https://example.com" data-ext="1">https://example.com</a>')
    expect(md('[x](https://a.com/"onmouseover="alert(1))')).not.toContain('onmouseover="alert')
  })
  it('plain lines keep their line breaks', () => {
    expect(md('one\ntwo')).toBe('<p>one<br>two</p>')
  })
})

describe('exportMarkdown', () => {
  const items: TranscriptItem[] = [
    { type: 'user', text: 'make a bot' },
    { type: 'tool', id: '1', name: 'create_file', args: { path: 'bot.py' }, needsApproval: false },
    { type: 'tool_result', id: '1', text: 'created', ok: true },
    { type: 'tool', id: '2', name: 'run_command', args: { command: 'python bot.py' }, needsApproval: false },
    { type: 'delta', text: 'Made ' },
    { type: 'delta', text: 'bot.py.' },
    { type: 'turn_end' },
    { type: 'verify', command: 'npm test', ok: true, output: '' },
    { type: 'changes', checkpoint: 'c', files: [{ path: 'bot.py', status: 'added', added: 10, removed: 0 }] },
    { type: 'done', reason: 'finished', steps: 2 },
  ]
  it('writes a readable transcript', () => {
    const t = exportMarkdown('Telegram bot', '/p/bot', items)
    expect(t).toBe(
      ['# Telegram bot', '', '_Folder: /p/bot_', '', '## You', '', 'make a bot', '', '- Created `bot.py`', '- Ran `python bot.py`', '', '## Forge', '', 'Made bot.py.', '', '**Check passed:** `npm test`', '', '**1 file changed:** `bot.py`', ''].join('\n'),
    )
  })
})

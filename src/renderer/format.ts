import type { TranscriptItem } from '../main/chatStore'

// Pure helpers, kept apart from the DOM code so they can be unit tested.
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0)
const DAY = 86_400_000

export function groupOf(updatedAt: number, now = Date.now()): string {
  const diff = startOfDay(now) - startOfDay(updatedAt)
  if (diff <= 0) return 'Today'
  if (diff <= DAY) return 'Yesterday'
  if (diff <= 7 * DAY) return 'Previous 7 days'
  return 'Older'
}

export const folderName = (p: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : 'No folder')

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

export const formatRate = (tps: number) => (tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1))

export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export const matchesQuery = (c: { title: string; project: string | null }, q: string): boolean => {
  const needle = q.trim().toLowerCase()
  return !needle || c.title.toLowerCase().includes(needle) || folderName(c.project).toLowerCase().includes(needle)
}

// ---- what the agent did, in words ----
const VERB: Record<string, string> = { list_dir: 'Listed', read_file: 'Read', edit_file: 'Edited', create_file: 'Created', search: 'Searched', run_command: 'Ran' }
export function toolVerb(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (name === 'edit_file' && a.old_text === '') return 'Created'
  return VERB[name] ?? name
}
export const toolTarget = (args: unknown): string => {
  const a = (args ?? {}) as Record<string, unknown>
  return [a.path, a.pattern, a.command].find((v): v is string => typeof v === 'string') ?? ''
}

// ---- markdown-lite: everything is escaped first, so model output can never inject HTML ----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inlineText(s: string): string {
  let t = esc(s)
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-ext="1">$1</a>')
  return t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" data-ext="1">$2</a>')
}
// Code spans are cut out first so nothing inside them is treated as markdown.
const inline = (s: string) => s.split(/(`[^`\n]+`)/).map((p) => (/^`[^`\n]+`$/.test(p) ? `<code>${esc(p.slice(1, -1))}</code>` : inlineText(p))).join('')

function blocks(text: string): string {
  const out: string[] = []
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; start: number; items: string[] } | null = null
  const endPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const endList = () => {
    if (list) out.push(`<${list.kind}${list.kind === 'ol' && list.start !== 1 ? ` start="${list.start}"` : ''}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.kind}>`)
    list = null
  }
  for (const line of text.split('\n')) {
    let m: RegExpExecArray | null
    if (!line.trim()) {
      endPara()
      endList()
    } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      endPara()
      endList()
      const tag = m[1].length <= 2 ? 'h3' : 'h4'
      out.push(`<${tag}>${inline(m[2])}</${tag}>`)
    } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      endPara()
      if (list?.kind !== 'ul') (endList(), (list = { kind: 'ul', start: 1, items: [] }))
      list!.items.push(m[1])
    } else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) {
      endPara()
      if (list?.kind !== 'ol') (endList(), (list = { kind: 'ol', start: Number(m[1]), items: [] }))
      list!.items.push(m[2])
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim() // indented continuation of a list item
    } else {
      endList()
      para.push(line)
    }
  }
  endPara()
  endList()
  return out.join('')
}

export function md(src: string): string {
  return src
    .split('```')
    .map((part, i) => {
      if (i % 2 === 0) return blocks(part)
      const nl = part.indexOf('\n') // first line is the language tag
      const lang = (nl === -1 ? part : part.slice(0, nl)).trim().replace(/[^\w+#.-]/g, '')
      const code = (nl === -1 ? '' : part.slice(nl + 1)).replace(/\n$/, '')
      return `<div class="code"><div class="code-head"><span>${esc(lang || 'code')}</span><button class="copy" type="button">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`
    })
    .join('')
}

// ---- export a chat as a readable markdown document ----
export function exportMarkdown(title: string, project: string | null, items: TranscriptItem[]): string {
  const out: string[] = [`# ${title}`, project ? `\n_Folder: ${project}_` : '']
  let text = ''
  let steps: string[] = []
  const flushText = () => {
    if (text.trim()) out.push(`\n## Forge\n\n${text.trim()}`)
    text = ''
  }
  const flushSteps = () => {
    if (steps.length) out.push('\n' + steps.map((s) => `- ${s}`).join('\n'))
    steps = []
  }
  for (const it of items) {
    if (it.type === 'delta') {
      flushSteps()
      text += it.text
    } else if (it.type === 'turn_end') {
      flushText()
    } else if (it.type === 'user') {
      flushText()
      flushSteps()
      out.push(`\n## You\n\n${it.text}`)
    } else if (it.type === 'tool') {
      flushText()
      steps.push(`${toolVerb(it.name, it.args)} \`${toolTarget(it.args)}\``)
    } else if (it.type === 'verify') {
      flushText()
      flushSteps()
      out.push(`\n**${it.ok ? 'Check passed' : 'Check failed'}:** \`${it.command}\``)
    } else if (it.type === 'changes') {
      flushText()
      flushSteps()
      out.push(`\n**${it.files.length} file${it.files.length === 1 ? '' : 's'} changed:** ${it.files.map((f) => `\`${f.path}\``).join(', ')}`)
    }
  }
  flushText()
  flushSteps()
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

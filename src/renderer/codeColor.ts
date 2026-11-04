// Code colouring and diffs. The computer uses Monaco, loaded on demand. A phone never downloads it (about 7 MB): it gets this small
// highlighter (keywords, strings, comments, numbers by language family) and a plain unified diff.
const isRemote = () => (globalThis as { __forgeRemote?: boolean }).__forgeRemote === true

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
const STR = `"(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'`
const C_KW = 'abstract as async await break case catch chan class const continue default defer delete do else enum export extends false fn for from func function go if impl implements import in instanceof interface let loop map match mod mut new nil null package private protected pub public range return select self static struct super switch this throw trait true try type typeof undefined use var void where while yield'
// Each family: one regex whose groups are 1 comment, 2 string, 3 number, 4 word, 5 extra (tags, properties, variables).
const FAMILIES: Record<string, { re: RegExp; kw: Set<string> }> = {
  c: { re: new RegExp(`(//[^\\n]*|/\\*[\\s\\S]*?\\*/)|(\`(?:\\\\[\\s\\S]|[^\\\\\`])*\`|${STR})|(\\b\\d[\\w.]*)|([A-Za-z_$][\\w$]*)`, 'g'), kw: new Set(C_KW.split(' ')) },
  py: { re: new RegExp(`(#[^\\n]*)|("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|${STR})|(\\b\\d[\\w.]*)|([A-Za-z_]\\w*)`, 'g'), kw: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield'.split(' ')) },
  sh: { re: new RegExp(`(#[^\\n]*)|(${STR})|(\\b\\d+\\b)|([A-Za-z_][\\w-]*)|(\\$\\{?\\w+\\}?)`, 'g'), kw: new Set('if then else elif fi for while do done case esac in function return export local echo exit set cd'.split(' ')) },
  css: { re: new RegExp(`(/\\*[\\s\\S]*?\\*/)|(${STR})|(#[0-9a-fA-F]{3,8}\\b|-?\\d*\\.?\\d+[a-z%]*)|(@[\\w-]+|!important)|([\\w-]+(?=\\s*:))`, 'g'), kw: new Set() },
  html: { re: new RegExp(`(<!--[\\s\\S]*?-->)|(${STR})|((?!))|(</?[\\w-]+|/?>)|([\\w:-]+(?==))`, 'g'), kw: new Set() },
  json: { re: new RegExp(`((?!))|(${STR})|(-?\\b\\d[\\d.eE+-]*)|(\\btrue\\b|\\bfalse\\b|\\bnull\\b)`, 'g'), kw: new Set(['true', 'false', 'null']) },
}
const FAMILY_OF: Record<string, string> = { ts: 'c', tsx: 'c', js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', rs: 'c', go: 'c', java: 'c', c: 'c', h: 'c', cpp: 'c', cs: 'c', kt: 'c', swift: 'c', py: 'py', rb: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', yml: 'sh', yaml: 'sh', toml: 'sh', css: 'css', scss: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', json: 'json' }

export function liteColor(text: string, path: string): string {
  const fam = FAMILIES[FAMILY_OF[path.split('.').pop()?.toLowerCase() ?? ''] ?? '']
  if (!fam) return esc(text)
  let out = '', at = 0
  for (const m of text.matchAll(fam.re)) {
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? (fam.kw.size && !fam.kw.has(m[4]) ? '' : 'k') : m[5] ? 't' : ''
    if (!cls) continue
    out += esc(text.slice(at, m.index)) + `<span class="tk-${cls}">${esc(m[0])}</span>`
    at = m.index! + m[0].length
  }
  return out + esc(text.slice(at))
}

export async function colorize(text: string, path: string): Promise<string> {
  if (isRemote()) return liteColor(text, path)
  return (await import('./teamDiff')).colorizeTeamCode(text, path)
}

export async function mountDiff(host: HTMLElement, diff: string) {
  if (!isRemote()) return (await import('./teamDiff')).mountTeamDiff(host, diff)
  const pre = document.createElement('pre')
  pre.className = 'lite-diff'
  for (const line of diff.split('\n')) {
    const s = document.createElement('span')
    s.className = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''
    s.textContent = line + '\n'
    pre.append(s)
  }
  host.replaceChildren(pre)
}

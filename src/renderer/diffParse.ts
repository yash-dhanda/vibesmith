// Pure parts of the diff review: reading git's unified diff and writing review comments back as one message.

export type DiffLine = { kind: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null }
export type DiffHunk = { header: string; lines: DiffLine[] }
export type DiffFile = { path: string; oldPath: string; status: 'added' | 'deleted' | 'modified' | 'renamed'; binary: boolean; added: number; removed: number; hunks: DiffHunk[] }
export type ReviewComment = { path: string; line: number; side: 'new' | 'old'; text: string; code: string }

// Git quotes a path that has quotes, tabs or backslashes in it.
function unquote(p: string): string {
  if (!p.startsWith('"')) return p
  return p.slice(1, p.endsWith('"') ? -1 : undefined).replace(/\\(?:([0-7]{3})|(.))/g, (_, oct, c) => (oct ? String.fromCharCode(parseInt(oct, 8)) : ({ n: '\n', t: '\t' } as Record<string, string>)[c] ?? c))
}
const stripPrefix = (p: string) => unquote(p).replace(/^[ab]\//, '')

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0, newNo = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // "a/x b/x": split where both halves are the same path; a renamed file is corrected by the rename lines below
      const rest = line.slice(11)
      const mid = rest.indexOf(' b/')
      const path = mid > 0 ? stripPrefix(rest.slice(mid + 1)) : stripPrefix(rest)
      file = { path, oldPath: mid > 0 ? stripPrefix(rest.slice(0, mid)) : path, status: 'modified', binary: false, added: 0, removed: 0, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (hunk) {
      const k = line[0]
      if (k === '+' || k === '-' || k === ' ') {
        const d: DiffLine = k === '+' ? { kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ } : k === '-' ? { kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null } : { kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }
        if (k === '+') file.added++
        else if (k === '-') file.removed++
        hunk.lines.push(d)
        continue
      }
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) {
      oldNo = +m[1]
      newNo = +m[2]
      file.hunks.push((hunk = { header: line, lines: [] }))
    } else if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) (file.status = 'renamed'), (file.oldPath = unquote(line.slice(12)))
    else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10))
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true
    else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = stripPrefix(line.slice(4))
    else if (line.startsWith('--- ') && line !== '--- /dev/null') file.oldPath = stripPrefix(line.slice(4))
  }
  return files
}

// One follow-up message for the crew. The crew's follow-up path keeps 2000 characters, so only as many comments as fit are written;
// `sent` says how many, in order, so the caller can keep the rest.
export function commentsToMessage(comments: ReviewComment[], max = 2000): { text: string; sent: number } {
  let text = 'Review comments on the changes:'
  let sent = 0
  for (const c of comments) {
    const code = c.code.trim().replace(/\s+/g, ' ')
    const entry = `\n- ${c.path}:${c.line} (${c.side} side) — ${c.text.trim()}` + (code ? `\n  > ${code.length > 100 ? code.slice(0, 99) + '…' : code}` : '')
    if (text.length + entry.length > max) {
      if (sent) break
      return { text: (text + entry).slice(0, max), sent: 1 } // one comment alone is too long: it is cut, not dropped
    }
    text += entry
    sent++
  }
  return { text, sent }
}

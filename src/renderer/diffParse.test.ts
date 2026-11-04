import { describe, expect, it } from 'vitest'
import { commentsToMessage, parseUnifiedDiff } from './diffParse'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function f() {
 keep
-old line
+new line
+extra
 tail
@@ -20,2 +21,2 @@
 x
--- not a header, a removed line starting with dashes
+y
\\ No newline at end of file
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF)
  it('finds every file with its status and counts', () => {
    expect(files.map((f) => [f.path, f.status, f.added, f.removed, f.binary])).toEqual([
      ['src/a.ts', 'modified', 3, 2, false],
      ['new.txt', 'added', 2, 0, false],
      ['new name.txt', 'renamed', 0, 0, false],
      ['img.png', 'modified', 0, 0, true],
      ['gone.txt', 'deleted', 0, 1, false],
    ])
    expect(files[2].oldPath).toBe('old name.txt')
  })
  it('numbers lines on both sides', () => {
    const [h1, h2] = files[0].hunks
    expect(h1.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['add', null, 3], ['ctx', 3, 4]])
    expect(h2.lines[1]).toMatchObject({ kind: 'del', text: '-- not a header, a removed line starting with dashes', oldNo: 21 })
    expect(h2.lines.at(-1)).toMatchObject({ kind: 'add', newNo: 22 }) // the "no newline" marker is not a line
  })
  it('copes with empty and non-diff text', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('No changes are available yet.')).toEqual([])
  })
})

describe('commentsToMessage', () => {
  const c = (n: number, text = 'rename this') => ({ path: 'src/a.ts', line: n, side: 'new' as const, text, code: '  const x = 1 ' })
  it('writes path:line, side, comment and the quoted code', () => {
    expect(commentsToMessage([c(12), { ...c(3), side: 'old' }])).toEqual({
      text: 'Review comments on the changes:\n- src/a.ts:12 (new side) — rename this\n  > const x = 1\n- src/a.ts:3 (old side) — rename this\n  > const x = 1',
      sent: 2,
    })
  })
  it('stops before the 2000 characters the crew keeps, and says how many went', () => {
    const many = Array.from({ length: 40 }, (_, i) => c(i + 1, 'a fairly long explanation of what should change on this line'))
    const { text, sent } = commentsToMessage(many)
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(sent).toBeGreaterThan(5)
    expect(sent).toBeLessThan(40)
    expect(commentsToMessage([c(1, 'x'.repeat(5000))]).text.length).toBe(2000)
  })
})

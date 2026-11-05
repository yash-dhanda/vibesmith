// Reference solution, used only to validate the checker. Never copied into the agent's project.
const fs = require('fs')
function parseCsv(text) {
  const rows = []
  let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = [] }
    else f += c
  }
  row.push(f); if (row.some((x) => x.trim() !== '')) rows.push(row)
  return rows
}
const day = (s) => { s = s.trim(); let m; if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5; if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) return Date.UTC(+m[3], +m[2] - 1, +m[1]) / 864e5; throw new Error('bad date ' + s) }
const cents = (s) => { s = s.trim(); let neg = false; if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) } s = s.replace(/[₹$,\s]/g, ''); if (s.startsWith('-')) { neg = !neg; s = s.slice(1) } const [w, fr = ''] = s.split('.'); const v = +w * 100 + +(fr + '00').slice(0, 2); return neg ? -v : v }
const load = (f) => parseCsv(fs.readFileSync(f, 'utf8')).slice(1)
const bank = load(process.argv[2]).map(([id, d, desc, a]) => ({ id, d: day(d), desc: desc.trim().toLowerCase().replace(/\s+/g, ' '), a: cents(a) }))
const led = load(process.argv[3]).map(([ref, d, , a]) => ({ ref, d: day(d), a: cents(a), used: false }))
const seen = new Set(), dups = [], matched = [], ub = []
for (const b of bank) {
  const k = `${b.d}|${b.a}|${b.desc}`
  if (seen.has(k)) { dups.push(b.id); continue }
  seen.add(k)
  let best = null
  for (const l of led) if (!l.used && l.a === b.a && Math.abs(l.d - b.d) <= 3 && (!best || Math.abs(l.d - b.d) < Math.abs(best.d - b.d))) best = l
  if (best) { best.used = true; matched.push({ bank: b.id, ledger: best.ref }) } else ub.push(b.id)
}
const ul = led.filter((l) => !l.used).map((l) => l.ref)
fs.writeFileSync('report.json', JSON.stringify({ matched, unmatchedBank: ub, unmatchedLedger: ul, duplicates: dups }, null, 2))
console.log(`matched=${matched.length} unmatchedBank=${ub.length} unmatchedLedger=${ul.length} duplicates=${dups.length}`)

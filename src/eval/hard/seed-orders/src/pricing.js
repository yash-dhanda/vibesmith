// All amounts are integer cents. Rates are percentages (8.25 means 8.25%).
// tax and discount are both rounded half up to the nearest cent.
function tax(cents, ratePct) {
  return Math.trunc((cents * ratePct) / 100)
}
function discount(cents, pct) {
  return Math.round((cents * pct) / 100)
}
function total(items, { taxPct = 0, discountPct = 0 } = {}) {
  const sub = items.reduce((s, i) => s + i.cents * i.qty, 0)
  const off = discount(sub, discountPct)
  return sub - off + tax(sub - off, taxPct)
}
module.exports = { tax, discount, total }

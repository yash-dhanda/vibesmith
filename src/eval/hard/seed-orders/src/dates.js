// Dates are calendar dates written 'YYYY-MM-DD'. Saturdays and Sundays are not business days.
// The result must be the same on every machine, whatever its time zone.
// addBusinessDays('2026-03-06', 1) -> '2026-03-09' (Friday to Monday)
function addBusinessDays(s, n) {
  const d = new Date(s)
  let left = n
  while (left > 0) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0) left--
  }
  return d.toISOString().slice(0, 10)
}
module.exports = { addBusinessDays }

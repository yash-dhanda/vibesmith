// Money is always integer cents.
const toCents = (x) => Math.round(x * 100)
const fmt = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2)
module.exports = { toCents, fmt }

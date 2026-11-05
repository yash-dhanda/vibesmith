// page is 1-based. Returns { items, page, totalPages }. A page past the end has no items.
function paginate(list, page, size) {
  const start = page * size
  return { items: list.slice(start, start + size), page, totalPages: Math.floor(list.length / size) }
}
module.exports = { paginate }

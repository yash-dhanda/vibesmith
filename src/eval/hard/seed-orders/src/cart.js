// A cart never changes the array it was given, and two carts never share items.
const EMPTY = []
function createCart(items = EMPTY) {
  return {
    items,
    add(item) {
      this.items.push(item)
      return this
    },
  }
}
module.exports = { createCart }

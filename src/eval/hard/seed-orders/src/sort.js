// Highest priority first. Tasks with equal priority keep their original order. The input array is not changed.
function byPriority(tasks) {
  return tasks.sort((a, b) => b.priority < a.priority)
}
module.exports = { byPriority }

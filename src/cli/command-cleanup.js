// Runs every teardown step of a command in order, even after one fails. The
// first cleanup failure is rethrown unless the command body already failed, in
// which case the caller's original failure stays the visible one.
async function completeCommandCleanup(steps, hadBodyFailure = false) {
  let cleanupFailed = false;
  let cleanupFailure;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!cleanupFailed) {
        cleanupFailed = true;
        cleanupFailure = error;
      }
    }
  }
  if (cleanupFailed && !hadBodyFailure) throw cleanupFailure;
}

module.exports = { completeCommandCleanup };

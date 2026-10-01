async function settleRecovery(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('recovery caller did not settle')), 2000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { settleRecovery };

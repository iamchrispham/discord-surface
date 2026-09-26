const CASES = { timeout: 8000 };

function operatorMessage(f, id, channelId) {
  return { ...f.message(id, channelId), authorId: 'operator', isBot: false, attachments: [] };
}

module.exports = { CASES, operatorMessage };

const { runScenario, assertRefused, assertCommitted } = require('./successor-authority-fixture');
require('./successor-authority-parser');
require('./successor-authority-registry');
require('./successor-authority-public-pickup');
require('./successor-authority-refusals');
require('./successor-authority-reuse');
require('./successor-authority-identity');
module.exports = { runScenario, assertRefused, assertCommitted };

const { INVOCATION_STYLES } = require('./handler-discovery-contract');
const { discoverFactory } = require('./handler-discovery-modules');
const { mutatedBindingNames } = require('./handler-discovery-bindings');

module.exports = { INVOCATION_STYLES, discoverFactory, mutatedBindingNames };

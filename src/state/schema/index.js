const { createSchemaCreation } = require('./creation');
const { createSchemaMigration } = require('./migration');
const { createSchemaValidation } = require('./validation');

function createSchemaHandlers(dependencies) {
  return {
    ...createSchemaCreation(dependencies),
    ...createSchemaMigration(dependencies),
    ...createSchemaValidation(dependencies)
  };
}

module.exports = { createSchemaHandlers };

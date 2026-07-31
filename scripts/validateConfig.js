#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ConfigLoader = require('../src/lib/configLoader');
const { resolveSchemaPath } = require('../src/lib/configBootstrap');

/**
 * Validate the config under `projectRoot`. Throws on any problem.
 *
 * Exported and parameterised so the behaviour can actually be tested: asserting
 * on the source text of this file let both original #177 defects be reintroduced
 * in ordinary refactor spellings while the tests stayed green.
 *
 * @param {Object} [options]
 * @param {string} [options.projectRoot] - Root holding config/ (and config-defaults/ in the image)
 * @returns {void} Throws on any problem; there is no warnings channel to return.
 */
function runValidation({ projectRoot = path.join(__dirname, '..') } = {}) {
  const configPath = path.join(projectRoot, 'config', 'config.json');

  // Resolve the schema exactly as index.js does. Looking in `config/` would find
  // nothing under the documented Docker mount (`-v ./config:/app/config:ro`),
  // which replaces that directory with the user's own — so this check silently
  // skipped schema validation and reported success for configs that could not
  // start. The baked copy in config-defaults/ is outside the mount. (#177)
  const schemaPath = resolveSchemaPath(projectRoot);
  const loader = new ConfigLoader(configPath, schemaPath);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Configuration file not found: ${configPath}\n` +
      'See config/config.example.json for a template.'
    );
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // A validator that cannot find its schema must fail loudly. Skipping and
  // printing success is how this reported a config as valid that the service
  // then refused to start. (#177)
  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `Configuration schema not found: ${schemaPath}\n` +
      'Cannot validate without it — refusing to report a result.'
    );
  }

  // Strict on purpose: startup hard-fails on the schema RULES but only warns on
  // unknown keys (#121); an explicit `validate-config` run is stricter still,
  // treating ANY schema mismatch — including unknown/typo'd keys — as a failure,
  // so a pre-ship check surfaces everything at once. (#115, #121)
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  loader.validateConfig(config, schema);
  loader.applyDefaults(config);
  loader.validateLogic(config);
}

module.exports = { runValidation };

// CLI wrapper: process.exit lives here so runValidation() stays testable.
if (require.main === module) {
  try {
    runValidation();
    console.log('✅ Configuration is valid');
  } catch (error) {
    console.error('❌ Configuration is invalid:');
    console.error(error.message);
    process.exit(1);
  }
}

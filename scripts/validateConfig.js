#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ConfigLoader = require('../src/lib/configLoader');

const configPath = path.join(__dirname, '..', 'config/config.json');
const schemaPath = path.join(__dirname, '..', 'config/config.schema.json');
const loader = new ConfigLoader(configPath, schemaPath);

try {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}\nSee config/config.example.json for a template.`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Strict on purpose: unlike startup (where schema validation is advisory during
  // the grace period), an explicit `validate-config` run treats any schema
  // mismatch as a failure so problems are caught before they ship. (#115)
  if (fs.existsSync(schemaPath)) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    loader.validateConfig(config, schema);
  }
  loader.applyDefaults(config);
  loader.validateLogic(config);

  console.log('✅ Configuration is valid');
} catch (error) {
  console.error('❌ Configuration is invalid:');
  console.error(error.message);
  process.exit(1);
}

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

  // Strict on purpose: startup hard-fails on the schema RULES but only warns on
  // unknown keys (#121); an explicit `validate-config` run is stricter still,
  // treating ANY schema mismatch — including unknown/typo'd keys — as a failure,
  // so a pre-ship check surfaces everything at once. (#115, #121)
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

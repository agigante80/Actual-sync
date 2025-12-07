#!/usr/bin/env node
const ConfigLoader = require('../src/lib/configLoader');
const path = require('path');
const loader = new ConfigLoader(
  path.join(__dirname, '..', 'config/config.json'),
  path.join(__dirname, '..', 'config/config.schema.json')
);
loader.load();
console.log('Configuration is valid');

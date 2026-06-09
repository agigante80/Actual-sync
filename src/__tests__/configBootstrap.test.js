/**
 * Unit tests for configBootstrap (first-run config seeding). (#96)
 */
const fs = require('fs');
const path = require('path');
const { resolveDefaultsDir, ensureConfig } = require('../lib/configBootstrap');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

describe('configBootstrap', () => {
    let tmp;
    const EXAMPLE = JSON.stringify({ servers: [], sync: {} }, null, 2);

    beforeEach(() => { tmp = createTempDir(); });
    afterEach(() => { cleanupTempDir(tmp); });

    const mkdir = (name) => {
        const d = path.join(tmp, name);
        fs.mkdirSync(d, { recursive: true });
        return d;
    };

    describe('ensureConfig()', () => {
        test('T1: returns configExists and writes nothing when config.json is present', () => {
            const configDir = mkdir('config');
            const defaultsDir = mkdir('defaults');
            fs.writeFileSync(path.join(configDir, 'config.json'), '{}');
            fs.writeFileSync(path.join(defaultsDir, 'config.example.json'), EXAMPLE);

            const result = ensureConfig({ configDir, defaultsDir });

            expect(result).toEqual({ configExists: true, seeded: false });
            expect(fs.existsSync(path.join(configDir, 'config.example.json'))).toBe(false);
        });

        test('T2: seeds config.example.json into an empty config dir', () => {
            const configDir = mkdir('config');
            const defaultsDir = mkdir('defaults');
            fs.writeFileSync(path.join(defaultsDir, 'config.example.json'), EXAMPLE);

            const result = ensureConfig({ configDir, defaultsDir });

            expect(result).toEqual({ configExists: false, seeded: true });
            const dest = path.join(configDir, 'config.example.json');
            expect(fs.existsSync(dest)).toBe(true);
            expect(fs.readFileSync(dest, 'utf8')).toBe(EXAMPLE);
        });

        test('T2b: no source example → no throw, no write, not seeded', () => {
            const configDir = mkdir('config');
            const defaultsDir = mkdir('defaults'); // intentionally has no config.example.json

            let result;
            expect(() => { result = ensureConfig({ configDir, defaultsDir }); }).not.toThrow();

            expect(result).toEqual({ configExists: false, seeded: false });
            expect(fs.readdirSync(configDir)).toHaveLength(0);
        });

        test('T3: never overwrites an existing config.example.json', () => {
            const configDir = mkdir('config');
            const defaultsDir = mkdir('defaults');
            fs.writeFileSync(path.join(defaultsDir, 'config.example.json'), EXAMPLE);
            const existing = '{"servers":["DO NOT OVERWRITE"]}';
            fs.writeFileSync(path.join(configDir, 'config.example.json'), existing);

            const result = ensureConfig({ configDir, defaultsDir });

            expect(result).toEqual({ configExists: false, seeded: false });
            expect(fs.readFileSync(path.join(configDir, 'config.example.json'), 'utf8')).toBe(existing);
        });
    });

    describe('resolveDefaultsDir()', () => {
        test('T4: prefers config-defaults when present, else falls back to config', () => {
            const root = mkdir('root');
            const configDir = path.join(root, 'config');
            fs.mkdirSync(configDir);
            fs.writeFileSync(path.join(configDir, 'config.example.json'), EXAMPLE);

            // Only config/ has the example → resolves to config/
            expect(resolveDefaultsDir(root)).toBe(configDir);

            // Add config-defaults/ with the example → it is preferred
            const defaultsDir = path.join(root, 'config-defaults');
            fs.mkdirSync(defaultsDir);
            fs.writeFileSync(path.join(defaultsDir, 'config.example.json'), EXAMPLE);
            expect(resolveDefaultsDir(root)).toBe(defaultsDir);
        });
    });
});

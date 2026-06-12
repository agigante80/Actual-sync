/**
 * First-run config bootstrap.
 *
 * In a container the user's bind mount shadows <root>/config, hiding the
 * image-baked config.example.json / config.schema.json. So the image bakes a
 * copy at <root>/config-defaults (see Dockerfile), and on first run we seed an
 * example into the (empty) mounted config dir so the user has a template to
 * fill in — rather than facing a blank dir and a cryptic "not found" error. (#96)
 */
const fs = require('fs');
const path = require('path');

// Project root: <root>/src/lib/configBootstrap.js → <root>
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * Directory holding the bundled config defaults (example + schema).
 * Prefers <root>/config-defaults (survives the volume mount in a container),
 * falling back to <root>/config (dev / npm, where it isn't mounted over).
 * @param {string} [root] project root to resolve against
 * @returns {string} absolute path to the defaults directory
 */
function resolveDefaultsDir(root = PROJECT_ROOT) {
    const candidates = [path.join(root, 'config-defaults'), path.join(root, 'config')];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'config.example.json'))) {
            return dir;
        }
    }
    return candidates[candidates.length - 1];
}

/**
 * Ensure a usable config exists. If config.json is missing, seed
 * config.example.json into the config dir from the bundled defaults — without
 * ever overwriting an existing file. Never throws: a missing source or an
 * unwritable dir degrades to { seeded: false } so the caller can still guide
 * the user.
 *
 * @param {object} opts
 * @param {string} opts.configDir   directory where config.json should live
 * @param {string} [opts.defaultsDir] override for the bundled defaults dir
 * @returns {{ configExists: boolean, seeded: boolean }}
 */
function ensureConfig({ configDir, defaultsDir = resolveDefaultsDir() }) {
    if (fs.existsSync(path.join(configDir, 'config.json'))) {
        return { configExists: true, seeded: false };
    }

    const exampleSrc = path.join(defaultsDir, 'config.example.json');
    const exampleDest = path.join(configDir, 'config.example.json');

    if (fs.existsSync(exampleSrc) && !fs.existsSync(exampleDest)) {
        try {
            fs.mkdirSync(configDir, { recursive: true });
            fs.copyFileSync(exampleSrc, exampleDest);
            return { configExists: false, seeded: true };
        } catch {
            // Read-only mount / permissions — degrade gracefully.
            return { configExists: false, seeded: false };
        }
    }

    return { configExists: false, seeded: false };
}

module.exports = { resolveDefaultsDir, ensureConfig };

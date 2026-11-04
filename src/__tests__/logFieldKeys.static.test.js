/**
 * Static check (M2, #437): every key of an object-literal metadata argument to
 * a logger call must be registered in src/lib/logFields.js. A key that is not
 * registered is dropped at runtime, and a call that only runs in production
 * would never fail a test. Spread elements and computed keys cannot be checked
 * here; the runtime harness covers those.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const { FIELDS } = require('../lib/logFields');

const SRC = path.join(__dirname, '..');
const LEVEL_METHODS = new Set(['info', 'warn', 'error', 'debug', 'security']);
// The metadata is the second argument; for this.log(level, msg, meta) the
// third (a two-argument log(msg, meta) wrapper also puts it second).
const OBJECT_OF = (callee, args) => {
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return null;
    // logger[compat.level](msg, meta): the level is computed, the shape is the same.
    if (callee.computed && /logger|log$/i.test(calleeRoot(callee.object))) return args[1];
    if (callee.computed || callee.property.type !== 'Identifier') return null;
    const name = callee.property.name;
    if (!/logger|log$/i.test(calleeRoot(callee.object))) return null;
    if (LEVEL_METHODS.has(name)) return args[1];
    if (name === 'log') return args.length >= 3 ? args[2] : args[1];
    return null;
};

function calleeRoot(node) {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'ThisExpression') return 'thislog';
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && node.property.type === 'Identifier') {
        return node.property.name === 'logger' || /log$/i.test(node.property.name) ? node.property.name : '';
    }
    return '';
}

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach((c) => c && typeof c === 'object' && walk(c, visit));
        else if (child && typeof child === 'object') walk(child, visit);
    }
}

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(full);
        return e.name.endsWith('.js') ? [full] : [];
    });
}

function unregisteredKeys() {
    const found = [];
    for (const file of sourceFiles(SRC)) {
        const ast = parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', errorRecovery: true });
        walk(ast.program, (node) => {
            if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
            const meta = OBJECT_OF(node.callee, node.arguments);
            if (!meta || meta.type !== 'ObjectExpression') return;
            for (const prop of meta.properties) {
                if (prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') continue;
                if (prop.computed) continue;
                const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
                if (!Object.prototype.hasOwnProperty.call(FIELDS, key)) {
                    found.push(`${path.relative(SRC, file)}:${prop.loc.start.line} ${key}`);
                }
            }
        });
    }
    return found;
}

test('every literal metadata key in a logger call is registered in logFields.js', () => {
    expect(unregisteredKeys()).toEqual([]);
});

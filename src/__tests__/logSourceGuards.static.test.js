/**
 * Source guards (#450, D9). Two rules that no runtime test can enforce for a
 * call site that only runs in production:
 *
 *  1. No `console.*` outside the console bridge, the logger's own console sink
 *     and the browser script served by dashboard.js. Everything else logs
 *     through the logger so redaction, the field allowlist and CWE-117
 *     escaping apply.
 *  2. The first argument of a logger call is a string literal (or a template
 *     literal without interpolation, or a conditional of those). A message
 *     built from data is a leak channel the field allowlist never sees.
 *
 * The third guard of D9, "every logged key is registered in logFields.js",
 * lives in logFieldKeys.static.test.js.
 *
 * Existing exceptions are listed below with the reason. Adding to a list needs
 * a reviewer's agreement; removing a stale entry is required (the guards fail
 * on an entry that no longer matches anything).
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// ---- Guard 1: console ------------------------------------------------------
const CONSOLE_ALLOWED = {
    // The bridge wraps the global console on purpose (#426).
    'src/lib/consoleBridge.js': 'the console bridge itself',
    // The logger's console sink: its own output, and the last-resort reports of
    // a sink that failed (they cannot go through the logger that just failed).
    'src/lib/logger.js': 'the logger console sink and its sink-failure reports',
    // Served to the browser as a client script; its console is the browser's.
    'src/services/dashboard.js': 'browser script served to the dashboard'
    // bootstrapLogger.js writes with fs.writeSync(2, ...), not console, so it needs no entry.
};

// ---- Guard 2: first argument ----------------------------------------------
// Keyed by "file :: source text of the first argument". Each is a message that
// is not a literal today. None interpolates a payee, amount, secret or account
// name (checked 2026-11-04). Pass-through wrappers forward a message their
// caller already had to write as a literal.
const MESSAGE_ALLOWED = {
    'src/lib/bootstrapLogger.js :: r.message': 'replays a buffered bootstrap record',
    "src/lib/configLoader.js :: `⚠️ ${message}\\n` + `CONFIG_STRICT is off: downgraded to a warning — fix these; they hard-fail once the escape hatch is removed. ` + `(CONFIG_STRICT only affects schema validation, not the business-logic checks below.)`": "bootstrap: schema validation text: schema paths and rule messages, no config values",
    "src/lib/configLoader.js :: `⚠️ Configuration has ${unknownKeys.length === 1 ? 'an unknown property' : 'unknown properties'} ` + `(advisory — likely a typo; unknown keys are ignored, not fatal):\\n${unknownKeys.join('\\n')}`": "bootstrap: unknown config key names",
    "src/lib/configLoader.js :: `⚠️ Warning: Server \"${server.name}\" uses unencrypted HTTP connection.\\n` + ` Consider using HTTPS for production: ${server.url}`": "bootstrap: server name and url from config; the bootstrap redact() masks user:pass@ and ?token=",
    "src/lib/configLoader.js :: `⚠️ Warning: Server \"${server.name}\" has a weak password (< 8 characters).\\n` + ` Consider using a stronger password for security.`": "bootstrap: server name from config, never the password",
    "src/lib/configLoader.js :: `⚠️ Warning: Server \"${server.name}\" appears to use a default/example password.\\n` + ` Please change to a secure password before production use.`": "bootstrap: server name from config, never the password",
    "src/lib/configLoader.js :: `⚠️ Warning: the same budget (url + syncId) is configured more than once: ${groups.join('; ')}.\\n` + ` It will be synced multiple times (duplicate bank-syncs, notifications and dashboard entries). Remove the duplicate entry.`": "bootstrap: server names from config",
    "src/lib/configLoader.js :: `⚠️ Warning: multiple servers share the same data directory: ${dupDirs.join(', ')}.\\n` + ` Each server needs its own dataDir to avoid budget-cache collisions.`": "bootstrap: dataDir paths from config (operator paths, pre-logger startup output)",
    "src/lib/configLoader.js :: `⚠️ Warning: healthCheck.host is set to \"${hcHost}\".\\n` + ` In containers use \"0.0.0.0\" — a specific host IP may not be bindable (EADDRNOTAVAIL) and the dashboard will be unreachable.`": "bootstrap: healthCheck.host from config",
    "src/lib/configLoader.js :: `scheduleAlerts template (server \"${server.name}\") fails on a channel that is not configured; ` + `dashboard rules without a channels restriction will be skipped at sync: ${allChannels.template.message}`": "bootstrap: server name and the template validation text of operator-written config",
    "index.js :: warning": "bootstrap: startup validation warnings built in index.js from literals and package names",
    "index.js :: error": "bootstrap: startup validation errors; includes fs and JSON.parse messages on config.json, which can quote a short snippet near a syntax error (known, pre-existing: an unquoted password in config.json can appear in that snippet; not fixed here)",
    'src/lib/crashHandlers.js :: message': 'crash handler picks one of its own constants',
    'src/lib/logger.js :: message': 'the level methods forward their caller\'s message',
    'src/lib/logger.js :: event': 'security(): the event name is the message, one of the caller\'s constants',
    'src/lib/logger.js :: `Performance: ${operationName}`': 'timer label from startTimer callers: a server name or an account id (syncService.js), no names or financial data',
    'src/lib/scheduleAlertsStep.js :: warning.message': 'built in scheduleAlerts.evaluate from fixed text and numeric config only; no rule id (a derived id is a slug of the schedule name), schedule name or error text (#450)',
    'src/lib/syncQueue.js :: message': 'the queue forwards its owner\'s message',
    'src/services/syncHistory.js :: `Migrated sync_history: added ${column} column`': 'column name from the migration list',
    'src/syncService.js :: message': 'queue and late-call wrappers forward their message',
    'src/syncService.js :: timezoneWarning': 'text from describeTimezoneFallback: the TZ environment value only',
    'src/syncService.js :: `Starting ${syncType} sync for server: ${name}`': 'server name is operator config, syncType is a constant',
    'src/syncService.js :: `${signal} received, shutting down gracefully...`': 'signal name from the OS'
};

const LEVEL_METHODS = new Set(['info', 'warn', 'error', 'debug', 'security']);

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
        if (e.isDirectory()) {
            return ['__tests__', 'node_modules', 'vendor'].includes(e.name) ? [] : sourceFiles(full);
        }
        return e.name.endsWith('.js') ? [full] : [];
    });
}

const productionFiles = () => [...sourceFiles(SRC), path.join(ROOT, 'index.js')].filter(f => fs.existsSync(f));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const parse = (code) => parser.parse(code, { sourceType: 'unambiguous', errorRecovery: true });

function rootName(node) {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'ThisExpression') return 'thislog';
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && node.property.type === 'Identifier') {
        return node.property.name === 'logger' || /log$/i.test(node.property.name) ? node.property.name : '';
    }
    return '';
}

/** The message argument of a logger call, or null when the call is not one. */
function messageArg(call) {
    const callee = call.callee;
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return null;
    // The bootstrap logger (#442) is imported as `bootstrap`; its calls are
    // replayed into the real logger, so they are checked too (#450 review M1).
    if (!/logger|log$|^bootstrap$/i.test(rootName(callee.object))) return null;
    const args = call.arguments;
    if (callee.computed) return args[0] || null; // logger[level](msg, meta)
    if (callee.property.type !== 'Identifier') return null;
    if (LEVEL_METHODS.has(callee.property.name)) return args[0] || null;
    // this.log(level, msg, meta) has the level first, also with two arguments
    // (Logger.log(level, message)); log(msg, meta) does not (#450 review L1).
    if (callee.property.name === 'log') {
        const levelFirst = args.length >= 3 ||
            (args[0] && args[0].type === 'StringLiteral' && /^(ERROR|WARN|INFO|DEBUG)$/i.test(args[0].value));
        return (levelFirst ? args[1] : args[0]) || null;
    }
    return null;
}

function isLiteralMessage(node) {
    if (node.type === 'StringLiteral') return true;
    if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
    if (node.type === 'ConditionalExpression') return isLiteralMessage(node.consequent) && isLiteralMessage(node.alternate);
    // A literal split over lines with +.
    if (node.type === 'BinaryExpression' && node.operator === '+') return isLiteralMessage(node.left) && isLiteralMessage(node.right);
    return false;
}

describe('logging source guards (#450)', () => {
    test('no console.* outside the bridge, the logger sink and the dashboard script', () => {
        const used = new Set();
        const violations = [];
        for (const file of productionFiles()) {
            const code = fs.readFileSync(file, 'utf8');
            walk(parse(code).program, (node) => {
                const isConsole = (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
                    node.object.type === 'Identifier' && node.object.name === 'console';
                if (!isConsole) return;
                if (CONSOLE_ALLOWED[rel(file)]) { used.add(rel(file)); return; }
                violations.push(`${rel(file)}:${node.loc.start.line} console.${node.property.name || '?'}`);
            });
        }
        expect(violations).toEqual([]);
        // an exception that no longer matches must be removed
        expect(Object.keys(CONSOLE_ALLOWED).filter(f => !used.has(f))).toEqual([]);
    });

    test('the first argument of every logger call is a string literal', () => {
        const used = new Set();
        const violations = [];
        for (const file of productionFiles()) {
            const code = fs.readFileSync(file, 'utf8');
            walk(parse(code).program, (node) => {
                if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
                const arg = messageArg(node);
                if (!arg || isLiteralMessage(arg)) return;
                // Keyed by the whole argument with whitespace collapsed: a key on
                // the first line only would let data added on a later line of a
                // split message pass unnoticed (#450 round 2).
                const key = `${rel(file)} :: ${code.slice(arg.start, arg.end).replace(/\s+/g, ' ').trim()}`;
                if (MESSAGE_ALLOWED[key]) { used.add(key); return; }
                violations.push(`${rel(file)}:${arg.loc.start.line} ${code.slice(arg.start, arg.end)}`);
            });
        }
        expect(violations).toEqual([]);
        expect(Object.keys(MESSAGE_ALLOWED).filter(k => !used.has(k))).toEqual([]);
    });

    test('the guards detect a violation (self-check on synthetic source)', () => {
        const code = 'console.log(x); logger.info(`id ${payee}`); logger.warn(a ? "x" : "y"); this.log("INFO", msg, {}); ' +
            'bootstrap.warn(`w ${payee}`); logger.log("WARN", `p ${payee}`); logger.info("a" + "b");';
        const bad = [];
        walk(parse(code).program, (node) => {
            if (node.type === 'CallExpression') {
                const arg = messageArg(node);
                if (arg && !isLiteralMessage(arg)) bad.push(code.slice(arg.start, arg.end));
            }
        });
        expect(bad).toEqual(['`id ${payee}`', 'msg', '`w ${payee}`', '`p ${payee}`']);
    });
});

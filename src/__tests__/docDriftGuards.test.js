/**
 * Doc↔code drift guards (#130).
 *
 * Small text-parsing tests that LOCK known invariants so doc rot fails CI at PR
 * time, not just when the manual code-health-auditor runs. The auditor finds new
 * classes of drift; these guards stop the known ones from coming back.
 *
 * All guards are FORWARD-direction only (everything the docs advertise must exist
 * in code), never the reverse — the README is curated, not an exhaustive mirror,
 * so a bidirectional guard would fail on a healthy tree. Extraction is anchored
 * to real tokens (URLs, backtick paths, badge URLs) to avoid prose false
 * positives. (Lessons from actual-mcp-server #234.)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const README = read('README.md');
// User-facing surfaces that advertise endpoints and must not drift. The Docker
// Hub / GHCR descriptions are published docs too — a /prometheus typo there 404s
// for every image user, so the endpoint guard scans them alongside the README.
const PUBLISHED_DOCS = ['README.md', 'docker/description/long.md', 'docker/description/short.md']
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    .map((rel) => `\n# ${rel}\n${read(rel)}`)
    .join('\n');
const HEALTHCHECK = read('src/services/healthCheck.js');
const NOTIFIER = read('src/services/notificationService.js');
const TELEGRAM = read('src/services/telegramBot.js');
const TESTING = read('docs/TESTING.md');

describe('published-docs endpoint guard (#130)', () => {
    // Every HTTP route the app actually registers.
    const routes = new Set(
        [...HEALTHCHECK.matchAll(/this\.app\.(?:get|post|use)\(\s*['"](\/[^'"]+)['"]/g)].map(
            (m) => m[1]
        )
    );

    // Every endpoint path the published docs reference, via a service URL or a
    // Prometheus metrics_path. (Would have caught the `/prometheus` drift in both
    // the README and the Docker Hub description.)
    const referenced = new Set();
    for (const m of PUBLISHED_DOCS.matchAll(/localhost:3000(\/[A-Za-z0-9/_-]*)/g)) {
        if (m[1] && m[1] !== '/') referenced.add(m[1]);
    }
    for (const m of PUBLISHED_DOCS.matchAll(/metrics_path:\s*['"]?(\/[A-Za-z0-9/_-]+)/g)) {
        referenced.add(m[1]);
    }

    it('finds routes in the app and references in the docs', () => {
        expect(routes.size).toBeGreaterThan(0);
        expect(referenced.size).toBeGreaterThan(0);
    });

    it.each([...referenced])('documented endpoint %s is registered in the Express app', (p) => {
        expect([...routes]).toContain(p);
    });
});

describe('advertised notification channels guard (#130, generalizes #128)', () => {
    // Each known channel -> a source file and a symbol that must exist if the
    // channel is advertised. An advertised channel with NO mapping fails the
    // test (that is the #128/Teams class: docs promise what code never built).
    // Match the actual send symbol, not just a mention of the word — otherwise a
    // channel whose send path was deleted (leaving comments/config keys behind)
    // would still read as "implemented", the exact drift this guards against.
    const IMPL = {
        telegram: () => /sendTelegram/.test(NOTIFIER) || /sendMessage/.test(TELEGRAM),
        email: () => /sendFormattedEmail|emailTransporter/.test(NOTIFIER),
        slack: () => /sendSlack/i.test(NOTIFIER),
        discord: () => /sendDiscord/i.test(NOTIFIER),
        ntfy: () => /sendNtfy/.test(NOTIFIER),
        webhook: () => /sendGenericWebhooks/.test(NOTIFIER),
    };

    function keyFor(channel) {
        const c = channel.toLowerCase();
        if (c.includes('telegram')) return 'telegram';
        if (c.includes('email')) return 'email';
        if (c.includes('slack')) return 'slack';
        if (c.includes('discord')) return 'discord';
        if (c.includes('ntfy')) return 'ntfy';
        if (c.includes('webhook')) return 'webhook';
        return null;
    }

    // Pull the channel list out of the headline "Notifies ... via X, Y, Z" line.
    const line = README.split('\n').find((l) => /\*\*Notifies\*\*.*\bvia\b/.test(l));
    const advertised = (line || '')
        .replace(/.*\bvia\b/, '')
        .split(/,|\bor\b|\band\b/)
        .map((s) => s.replace(/[^A-Za-z ]/g, '').trim())
        .filter(Boolean);

    it('extracts the advertised channel list from the README', () => {
        expect(line).toBeTruthy();
        expect(advertised.length).toBeGreaterThanOrEqual(5);
    });

    it.each(advertised)('advertised channel "%s" has an implementation', (channel) => {
        const key = keyFor(channel);
        // A null key means the README advertises a channel we have no impl for.
        expect(key).not.toBeNull();
        expect(IMPL[key]()).toBe(true);
    });
});

describe('no hardcoded / rotting metrics guard (#130)', () => {
    const docs = { 'README.md': README, 'docs/TESTING.md': TESTING };

    // Patterns that previously rotted; they must stay out of the docs (numbers
    // live on the live badges / Security tab / coverage report instead).
    const FORBIDDEN = [
        [/Security Score:\s*\d+\s*\/\s*100/i, 'static security score (use the Security tab)'],
        [/OWASP[^\n]*\d+\s*%/i, 'static OWASP percentage'],
        [/containerization\s*\(\s*\d+\s*MB/i, 'hardcoded Docker image size (use the image-size badge)'],
        [/Tests:\s+\d+\s+passed/, 'hardcoded test count (use the Tests badge)'],
        [/\d+\.\d+%\s+statements/i, 'hardcoded coverage % (use the Coverage badge)'],
    ];

    for (const [file, content] of Object.entries(docs)) {
        for (const [re, what] of FORBIDDEN) {
            it(`${file} has no ${what}`, () => {
                expect(content).not.toMatch(re);
            });
        }
    }

    it('README node-version badge matches package.json engines.node', () => {
        const engines = require(path.join(ROOT, 'package.json')).engines.node;
        const badge = README.match(/badge\/node-([^"')\s]+)/);
        expect(badge).toBeTruthy();
        const raw = badge[1].slice(0, badge[1].lastIndexOf('-')); // strip trailing -color
        const decoded = decodeURIComponent(raw.replace(/--/g, '-'));
        expect(decoded).toBe(engines);
    });
});

/**
 * Config-option drift guard (#169).
 *
 * The advertised-channels guard above catches a documented CHANNEL with no
 * implementation. It could not catch `notifyOnSuccess`, which was documented and
 * schema-described as gating sync notifications while being read nowhere on the
 * dispatch path — option-level drift that went unnoticed for the setting's whole
 * lifetime, across 23 documented locations. These guards close that gap.
 */
describe('documented notification options exist in the schema (#169)', () => {
    const SCHEMA = JSON.parse(read('config/config.schema.json'));
    const NOTIF = SCHEMA.properties.notifications;
    const NOTIFICATIONS_DOC = read('docs/NOTIFICATIONS.md');
    const EXAMPLE = JSON.parse(read('config/config.example.json'));

    const enumAt = (node) => node && node.enum;

    it('notifications.notifyOnSuccess is declared as the global default', () => {
        expect(enumAt(NOTIF.properties.notifyOnSuccess)).toEqual(['always', 'errors_only', 'never']);
    });

    // Every sink the notification service dispatches to must accept the override,
    // or the docs describing "per-channel control" are lying for that sink.
    const OBJECT_CHANNELS = ['email', 'telegram', 'ntfy'];
    for (const channel of OBJECT_CHANNELS) {
        it(`notifications.${channel} accepts a notifyOnSuccess override`, () => {
            expect(enumAt(NOTIF.properties[channel].properties.notifyOnSuccess))
                .toEqual(['always', 'errors_only', 'never']);
        });
    }

    const ARRAY_CHANNELS = ['slack', 'discord', 'generic'];
    for (const channel of ARRAY_CHANNELS) {
        it(`notifications.webhooks.${channel}[] accepts a per-entry notifyOnSuccess`, () => {
            expect(enumAt(NOTIF.properties.webhooks.properties[channel].items.properties.notifyOnSuccess))
                .toEqual(['always', 'errors_only', 'never']);
        });

        // Defect B: the senders have always honoured `enabled`, but the slack and
        // discord item schemas declared only name/url under
        // additionalProperties:false, so setting it failed validation outright.
        it(`notifications.webhooks.${channel}[] declares the enabled flag the code reads`, () => {
            const props = NOTIF.properties.webhooks.properties[channel].items.properties;
            expect(props.enabled).toBeDefined();
            expect(props.enabled.type).toBe('boolean');
        });
    }

    it('every notifyOnSuccess value used in a docs JSON snippet is a schema enum member', () => {
        const allowed = NOTIF.properties.notifyOnSuccess.enum;
        // Only JSON-ish assignments, so the /notify command vocabulary ("errors")
        // discussed in prose is not mistaken for a config value.
        const used = [...NOTIFICATIONS_DOC.matchAll(/"notifyOnSuccess"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
        expect(used.length).toBeGreaterThan(0);
        for (const value of used) expect(allowed).toContain(value);
    });

    it('the example config demonstrates the option it documents', () => {
        expect(EXAMPLE.notifications.notifyOnSuccess).toBeDefined();
        const perChannel = [
            EXAMPLE.notifications.email?.notifyOnSuccess,
            EXAMPLE.notifications.telegram?.notifyOnSuccess,
            EXAMPLE.notifications.ntfy?.notifyOnSuccess,
            ...(EXAMPLE.notifications.webhooks?.generic || []).map(w => w.notifyOnSuccess)
        ].filter(Boolean);
        expect(perChannel.length).toBeGreaterThan(0);
    });
});

/**
 * The claim that started #168: the README stated notifications fire only on
 * failures, in two places ~700 lines apart, while every success also notified.
 * Lock the corrected wording so the drift cannot quietly return.
 */
describe('README does not claim notifications are failure-only (#169)', () => {
    it('the "What It Does" notify line does not say "of failures"', () => {
        const line = README.split('\n').find((l) => /\*\*Notifies\*\*/.test(l));
        expect(line).toBeTruthy();
        expect(line).not.toMatch(/\bof failures\b/i);
    });

    it('the Notifications section intro does not say "on sync failures"', () => {
        expect(README).not.toMatch(/can send notifications on sync failures/i);
    });

    it('the thresholds blurb does not claim all notifications are threshold-gated', () => {
        expect(README).not.toMatch(/^Notifications are sent only when thresholds are exceeded:/m);
    });
});

/**
 * The Dockerfile copies all of `scripts/` into the runtime image, because
 * `validateConfig.js` is needed there — `npm run validate-config` in the
 * container is the documented pre-upgrade check (#177). That same COPY also
 * shipped the mutation runner, a tool whose entire job is overwriting source
 * files in place.
 *
 * This is a text assertion over a config file, which is weaker than a
 * behavioural test — but `.dockerignore` has no runtime behaviour to observe
 * without building an image, and the both-directions form below has real teeth:
 * excluding all of `scripts/` to satisfy the first half breaks the second.
 */
describe('only operator tooling ships in the production image (#180, #183)', () => {
    const DOCKERIGNORE = read('.dockerignore');
    const entries = DOCKERIGNORE.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

    /** Build-time or release-time only; useless or actively confusing in a container. */
    const MUST_NOT_SHIP = [
        ['scripts/mutationTest.js', 'rewrites source files in place'],
        ['scripts/mutations.js', 'the catalog of source edits that runner applies'],
        ['scripts/generateDashboardScreenshots.js', 'requires puppeteer, a devDependency the image omits'],
        ['scripts/generate-badges.js', 'writes to .github/badges, which does not exist in the image'],
        ['scripts/version-bump.js', 'rewrites VERSION, package.json and package-lock.json']
    ];

    /** Genuinely useful inside the container; excluding these breaks documented commands. */
    const MUST_SHIP = [
        ['scripts/validateConfig.js', 'npm run validate-config, the documented pre-upgrade check (#177)'],
        ['scripts/listAccounts.js', 'npm run list-accounts'],
        ['scripts/viewHistory.js', 'npm run history']
    ];

    it.each(MUST_NOT_SHIP)('excludes %s — %s', (file) => {
        expect(entries).toContain(file);
    });

    it.each(MUST_SHIP)('does not exclude %s — %s', (file) => {
        // The other direction, and the one with teeth: it is what stops the
        // lazy "ignore all of scripts/" fix from satisfying the checks above.
        expect(entries).not.toContain(file);
    });

    it('never excludes the scripts directory wholesale', () => {
        for (const pattern of ['scripts', 'scripts/', 'scripts/*', 'scripts/**']) {
            expect(entries).not.toContain(pattern);
        }
    });

    it('names files that actually exist, so the lists cannot rot', () => {
        for (const [f] of [...MUST_NOT_SHIP, ...MUST_SHIP]) {
            expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
        }
    });

    it('accounts for every script in the tree, so a new one is a deliberate choice', () => {
        // Without this a script added later is silently neither listed nor
        // considered, and the next over-broad COPY goes unnoticed.
        const onDisk = fs.readdirSync(path.join(ROOT, 'scripts'))
            .filter((f) => f.endsWith('.js'))
            .map((f) => `scripts/${f}`)
            .sort();
        const classified = [...MUST_NOT_SHIP, ...MUST_SHIP].map(([f]) => f).sort();
        expect(onDisk).toEqual(classified);
    });
});

/**
 * Every advertised notification channel must be testable from the dashboard (#182).
 *
 * The route handled four channels while the schema defined six, so a
 * misconfigured ntfy topic or generic webhook could not be verified at all —
 * the only thing that would exercise it was the real failure it existed to
 * report. Adding the two cases fixes today; this stops the next channel from
 * repeating it.
 *
 * Derived from the schema rather than a hardcoded list, so a channel added to
 * `config.schema.json` without a matching `case` fails here.
 */
describe('every notification channel is testable from the dashboard (#182)', () => {
    const schema = JSON.parse(read('config/config.schema.json'));
    const notif = schema.properties.notifications.properties;

    // `webhooks.telegram` is a legacy alias for the top-level telegram channel
    // (#174), not a channel of its own, so it needs no case of its own.
    const LEGACY_ALIASES = new Set(['telegram']);

    const channels = [
        ...['email', 'telegram', 'ntfy'].filter((k) => notif[k]),
        ...Object.keys(notif.webhooks?.properties || {}).filter((k) => !LEGACY_ALIASES.has(k))
    ];

    // The `case 'x':` labels in the test-notification switch.
    const route = HEALTHCHECK.slice(HEALTHCHECK.indexOf("post('/api/dashboard/test-notification'"));
    const handled = [...route.slice(0, route.indexOf('\n    });')).matchAll(/case '([a-z]+)'/g)].map((m) => m[1]);

    it('derives a plausible channel list from the schema', () => {
        // Guards the guard: an empty list would make the assertions below vacuous.
        expect(channels).toEqual(expect.arrayContaining(['email', 'telegram', 'ntfy', 'slack', 'discord', 'generic']));
    });

    it('found the route and its case labels', () => {
        expect(handled.length).toBeGreaterThanOrEqual(6);
    });

    it.each(['email', 'telegram', 'ntfy', 'slack', 'discord', 'generic'])(
        'handles the %s channel', (channel) => {
            expect(handled).toContain(channel);
        });

    it('has a case for every channel the schema defines', () => {
        expect(channels.filter((c) => !handled.includes(c))).toEqual([]);
    });

    it('names every supported channel in the invalid-channel message', () => {
        // Otherwise the error tells a user their channel is unsupported when it
        // is merely absent from the switch.
        const message = route.match(/Invalid channel\. Use: ([^'"]+)/)?.[1] || '';
        for (const channel of channels) expect(message).toContain(channel);
    });

    // The route is only half of it. "Testable from the dashboard" means a user
    // can click something — an endpoint nobody can reach from the UI leaves the
    // reported symptom exactly as it was.
    describe('the dashboard UI offers a button per channel', () => {
        const DASHBOARD = read('src/services/dashboard.html');
        const buttons = [...DASHBOARD.matchAll(/testNotification\('([a-z]+)'\)/g)].map((m) => m[1]);

        it('found the test-notification buttons at all', () => {
            expect(buttons.length).toBeGreaterThanOrEqual(6);
        });

        it.each(['email', 'telegram', 'ntfy', 'slack', 'discord', 'generic'])(
            'has a %s button', (channel) => {
                expect(buttons).toContain(channel);
            });

        it('has a button for every channel the schema defines', () => {
            expect(channels.filter((c) => !buttons.includes(c))).toEqual([]);
        });

        it('offers no button for a channel the route cannot handle', () => {
            // The inverse rot: a button that always 400s is worse than none.
            expect(buttons.filter((b) => !handled.includes(b))).toEqual([]);
        });
    });
});

/**
 * No host-absolute paths anywhere in the repo.
 *
 * A path like /home/<someone>/projects/thing is true on exactly one machine. In
 * documentation it is an instruction nobody else can follow; in a script it is a
 * silent breakage on every other checkout. Both had crept into `.claude/` docs.
 *
 * Only *host home* directories are flagged. Container-absolute paths (/app/data,
 * /app/logs) are correct and deliberate here, so the pattern is deliberately
 * narrow rather than "anything starting with a slash".
 *
 * Write `$HOME`, `~`, `$(git rev-parse --show-toplevel)`, or a named variable
 * instead. The patterns are assembled from fragments so this guard does not
 * match its own source.
 */
describe('no machine-specific absolute paths in the repo', () => {
    const HOME_DIR_PATTERNS = [
        { label: 'Linux home', re: new RegExp('/' + 'home' + '/[A-Za-z0-9._-]+/') },
        { label: 'macOS home', re: new RegExp('/' + 'Users' + '/[A-Za-z0-9._-]+/') },
        { label: 'Windows profile', re: new RegExp('[A-Za-z]:\\\\' + 'Users' + '\\\\[A-Za-z0-9._-]+') }
    ];

    // This file names the patterns it forbids, so it cannot scan itself.
    const SELF = path.relative(ROOT, __filename);
    // Never worth reading as text, and the biggest files in the tree.
    const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip|gz)$/i;
    // Deliberate exception, for the case this guard is wrong about: a genuine
    // container path under /home. Mirrors the `config-guard: skip` convention
    // already used by configSnippets.js.
    const ALLOW_MARKER = 'host-path-guard: allow';

    // Collected, not thrown. A throw out here is a *suite load error*, which
    // jest reports as zero failed tests — the exact false-green this repo
    // fixed in the mutation runner (#177). Surface it as a failing assertion.
    let listError = null;
    let tracked = [];
    try {
        tracked = require('child_process')
            .execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
            .split('\0')
            .filter(Boolean)
            .filter((f) => f !== SELF);
    } catch (err) {
        listError = err;
    }

    /**
     * Extracted so the scanning itself is testable. Inline, the loop could stop
     * detecting anything and every assertion here would still pass — the whole
     * describe would go vacuously green.
     *
     * @returns {string[]} one entry per offending line
     */
    const scanText = (rel, text) => {
        const found = [];
        text.split('\n').forEach((line, i) => {
            if (line.includes(ALLOW_MARKER)) return;
            for (const { label, re } of HOME_DIR_PATTERNS) {
                if (re.test(line)) found.push(`${rel}:${i + 1} (${label}) ${line.trim().slice(0, 120)}`);
            }
        });
        return found;
    };

    const offenders = [];
    for (const rel of tracked) {
        if (BINARY.test(rel)) continue;
        let text;
        try {
            text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        } catch {
            continue; // unreadable or vanished
        }
        if (text.includes('\0')) continue; // binary without a telling extension
        offenders.push(...scanText(rel, text));
    }

    it('could list the tracked files at all', () => {
        // If this fails, every other assertion here is meaningless rather than passing.
        expect(listError && listError.message).toBeNull();
    });

    it('finds no hardcoded home directory in any tracked file', () => {
        expect(offenders).toEqual([]);
    });

    it('actually scans a meaningful number of files, so an empty pass means something', () => {
        // A broken `git ls-files` would make the guard above vacuously true.
        expect(tracked.length).toBeGreaterThan(50);
    });

    it('reports a violation when scanning text that contains one', () => {
        // Exercises the scan, not just the regexes. Without this the loop could
        // stop detecting anything and every other assertion would still pass.
        const bad = 'intro line\nsee /' + 'home' + '/someuser/proj/x for details\ntail';
        const found = scanText('docs/fake.md', bad);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('docs/fake.md:2');
    });

    it('honours the opt-out marker, so a genuine exception is not a dead end', () => {
        const excused = 'see /' + 'home' + '/someuser/proj/x  <!-- ' + ALLOW_MARKER + ' -->';
        expect(scanText('docs/fake.md', excused)).toEqual([]);
    });

    it('leaves clean text alone', () => {
        expect(scanText('docs/fake.md', '/app/data\n$HOME/x\n~/y')).toEqual([]);
    });

    it('would catch a hardcoded home directory if one were introduced', () => {
        // Proves the patterns discriminate rather than never matching anything.
        const samples = ['/' + 'home' + '/someone/repo/x.js', '/' + 'Users' + '/someone/repo/x.js'];
        for (const s of samples) {
            expect(HOME_DIR_PATTERNS.some(({ re }) => re.test(s))).toBe(true);
        }
        // And that it leaves legitimate container paths alone.
        for (const ok of ['/app/data', '/app/logs', '/app/config/config.json', '/usr/local/bin/entrypoint.sh']) {
            expect(HOME_DIR_PATTERNS.some(({ re }) => re.test(ok))).toBe(false);
        }
    });
});

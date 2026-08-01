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
describe('the mutation tooling stays out of the production image (#180)', () => {
    const DOCKERIGNORE = read('.dockerignore');
    const entries = DOCKERIGNORE.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

    it.each(['scripts/mutationTest.js', 'scripts/mutations.js'])(
        'excludes %s, which rewrites source files', (file) => {
            expect(entries).toContain(file);
        });

    it('still ships validateConfig.js, which the container genuinely needs', () => {
        // Guards the lazy fix: ignoring `scripts` wholesale would satisfy the
        // check above and break `npm run validate-config` in the container.
        expect(entries).not.toContain('scripts');
        expect(entries).not.toContain('scripts/');
        expect(entries).not.toContain('scripts/*');
        expect(entries).not.toContain('scripts/validateConfig.js');
    });

    it('names files that actually exist, so the exclusions cannot rot', () => {
        for (const f of ['scripts/mutationTest.js', 'scripts/mutations.js', 'scripts/validateConfig.js']) {
            expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
        }
    });
});

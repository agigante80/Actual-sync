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
const HEALTHCHECK = read('src/services/healthCheck.js');
const NOTIFIER = read('src/services/notificationService.js');
const TELEGRAM = read('src/services/telegramBot.js');
const TESTING = read('docs/TESTING.md');

describe('README endpoint guard (#130)', () => {
    // Every HTTP route the app actually registers.
    const routes = new Set(
        [...HEALTHCHECK.matchAll(/this\.app\.(?:get|post|use)\(\s*['"](\/[^'"]+)['"]/g)].map(
            (m) => m[1]
        )
    );

    // Every endpoint path the README references, via a service URL or a
    // Prometheus metrics_path. (Would have caught the `/prometheus` drift.)
    const referenced = new Set();
    for (const m of README.matchAll(/localhost:3000(\/[A-Za-z0-9/_-]*)/g)) {
        if (m[1] && m[1] !== '/') referenced.add(m[1]);
    }
    for (const m of README.matchAll(/metrics_path:\s*['"]?(\/[A-Za-z0-9/_-]+)/g)) {
        referenced.add(m[1]);
    }

    it('finds routes in the app and references in the README', () => {
        expect(routes.size).toBeGreaterThan(0);
        expect(referenced.size).toBeGreaterThan(0);
    });

    it.each([...referenced])('README endpoint %s is registered in the Express app', (p) => {
        expect([...routes]).toContain(p);
    });
});

describe('advertised notification channels guard (#130, generalizes #128)', () => {
    // Each known channel -> a source file and a symbol that must exist if the
    // channel is advertised. An advertised channel with NO mapping fails the
    // test (that is the #128/Teams class: docs promise what code never built).
    const IMPL = {
        telegram: () => /telegram/i.test(NOTIFIER) || /sendMessage|bot/i.test(TELEGRAM),
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
                const hit = content.match(re);
                expect(hit ? `${file}: "${hit[0]}"` : null).toBeNull();
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

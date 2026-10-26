/**
 * Container hardening defaults (#253).
 *
 * docker-compose.yml is the shipped default. It publishes the dashboard port
 * on 127.0.0.1 only, drops every capability except the three the PUID/PGID
 * entrypoint needs (CHOWN, SETUID, SETGID; each proven by a container run)
 * and sets no-new-privileges. The README and Docker Hub compose snippets,
 * the Unraid template's extra parameters and the CI smoke script carry the
 * same settings, so a relaxation in one place cannot go unnoticed in the
 * others.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const CAPS = ['CHOWN', 'SETGID', 'SETUID'];

/** Every actual-sync service in the compose blocks of a markdown file. */
function servicesFromMarkdown(file) {
    const blocks = [...read(file).matchAll(/```ya?ml\n([\s\S]*?)```/g)].map(m => m[1]);
    const services = blocks
        .filter(b => /^\s+actual-sync:/m.test(b) && /image:\s+\S*actual-sync/.test(b))
        .map(b => yaml.load(b).services['actual-sync']);
    expect(services.length).toBeGreaterThanOrEqual(1);
    return services;
}

function expectHardened(service, label) {
    expect(service.cap_drop).toEqual(['ALL']);
    expect([...service.cap_add].sort()).toEqual(CAPS);
    expect(service.security_opt).toContain('no-new-privileges:true');
    expect(service.ports).toHaveLength(1);
    expect(String(service.ports[0])).toMatch(/^127\.0\.0\.1:\d+:3000$/);
    expect(service.privileged).toBeUndefined();
    void label;
}

describe('container hardening defaults (#253)', () => {
    const compose = yaml.load(read('docker-compose.yml'));
    const service = compose.services['actual-sync'];

    it('docker-compose.yml publishes 3000 on localhost only, drops caps and forbids new privileges', () => {
        expectHardened(service, 'docker-compose.yml');
    });

    it('docker-compose.yml keeps read_only an opt-in (PUID/PGID other than 1001 needs a writable /etc)', () => {
        expect(service.read_only).toBeUndefined();
    });

    it('README compose examples carry the same settings', () => {
        const services = servicesFromMarkdown('README.md');
        expect(services).toHaveLength(2);
        for (const s of services) expectHardened(s, 'README.md');
    });

    it('Docker Hub description compose example carries the same settings', () => {
        for (const s of servicesFromMarkdown('docker/description/long.md')) expectHardened(s, 'long.md');
    });

    it('README docker run example carries the same settings', () => {
        const runs = [...read('README.md').matchAll(/docker run -d \\\n([\s\S]*?)actual-sync:latest/g)].map(m => m[1]);
        expect(runs).toHaveLength(3);
        for (const run of runs) {
            expect(run).toContain('--cap-drop ALL');
            for (const cap of CAPS) expect(run).toContain(`--cap-add ${cap}`);
            expect(run).toContain('--security-opt no-new-privileges:true');
            expect(run).toMatch(/-p 127\.0\.0\.1:3000:3000/);
        }
    });

    it('Unraid template adds the same capability and privilege flags, keeps the WebUI on the LAN', () => {
        const xml = read('unraid/actual-sync.xml');
        const extra = xml.match(/<ExtraParams>([^<]*)<\/ExtraParams>/);
        expect(extra).not.toBeNull();
        expect(extra[1]).toContain('--cap-drop ALL');
        for (const cap of CAPS) expect(extra[1]).toContain(`--cap-add ${cap}`);
        expect(extra[1]).toContain('--security-opt no-new-privileges:true');
        expect(extra[1]).not.toContain('--read-only');
        expect(xml).toContain('<Privileged>false</Privileged>');
        expect(xml).toContain('<WebUI>http://[IP]:[PORT:3000]/dashboard</WebUI>');
    });

    it('the CI smoke script starts the image with the same flags', () => {
        const script = read('scripts/docker-hardened-smoke.sh');
        expect(script).toContain('--cap-drop ALL');
        const added = [...script.matchAll(/--cap-add (\w+)/g)].map(m => m[1]).sort();
        expect(added).toEqual(CAPS);
        expect(script).toContain('--security-opt no-new-privileges:true');
        expect(script).toMatch(/-p "127\.0\.0\.1:\$\{PORT\}:3000"/);
    });

    it('the CI docker-test job runs the smoke script', () => {
        const ci = yaml.load(read(path.join('.github', 'workflows', 'ci-cd.yml')));
        const steps = ci.jobs['docker-test'].steps.map(s => s.run || '').join('\n');
        expect(steps).toContain('scripts/docker-hardened-smoke.sh');
    });
});

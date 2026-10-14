/**
 * Dependabot cooldown policy (#251).
 *
 * The npm VERSION-update entry and the github-actions entry carry a cooldown
 * (a minimum release age). The npm SECURITY-update entry (the one without
 * `target-branch` and with `open-pull-requests-limit: 0`) must NOT: waiting on
 * a known advisory increases exposure. This pins that asymmetry so nobody
 * "fixes" it later.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const config = yaml.load(fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'dependabot.yml'), 'utf8'));
const npm = config.updates.filter(u => u['package-ecosystem'] === 'npm');
const versionEntry = npm.find(u => u['target-branch'] === 'development');
const securityEntry = npm.find(u => u['open-pull-requests-limit'] === 0);
const actionsEntry = config.updates.find(u => u['package-ecosystem'] === 'github-actions');
const dockerEntry = config.updates.find(u => u['package-ecosystem'] === 'docker');

describe('dependabot cooldown (#251)', () => {
    it('locates the three entries', () => {
        expect(versionEntry).toBeDefined();
        expect(securityEntry).toBeDefined();
        expect(actionsEntry).toBeDefined();
        expect(versionEntry).not.toBe(securityEntry);
    });

    it('delays npm version updates, majors longer than patch and minor', () => {
        const c = versionEntry.cooldown;
        expect(c['default-days']).toBeGreaterThanOrEqual(1);
        expect(c['semver-major-days']).toBeGreaterThanOrEqual(c['semver-minor-days']);
        expect(c['semver-patch-days']).toBeGreaterThanOrEqual(1);
    });

    it('delays github-actions updates', () => {
        expect(actionsEntry.cooldown['default-days']).toBeGreaterThanOrEqual(1);
    });

    it('never delays npm security updates', () => {
        expect(securityEntry.cooldown).toBeUndefined();
    });
});

describe('dependabot docker base image (#362)', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

    it('tracks the Dockerfile on development with a cooldown', () => {
        expect(dockerEntry).toBeDefined();
        expect(dockerEntry.directory).toBe('/');
        expect(dockerEntry['target-branch']).toBe('development');
        expect(dockerEntry.cooldown['default-days']).toBeGreaterThanOrEqual(1);
    });

    it('never proposes a new Node major', () => {
        expect(dockerEntry.ignore).toEqual(expect.arrayContaining([
            { 'dependency-name': 'node', 'update-types': ['version-update:semver-major'] }
        ]));
    });

    it('pins every base image by digest so there is something to bump', () => {
        const froms = dockerfile.split('\n').filter(l => /^FROM\s/.test(l));
        expect(froms.length).toBeGreaterThan(0);
        for (const line of froms) expect(line).toMatch(/node:22-alpine@sha256:[0-9a-f]{64}(\s|$)/);
    });
});

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

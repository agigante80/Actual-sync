/**
 * The PreToolUse guard that refuses to write a machine-specific home directory
 * into a repo file (`.claude/hooks/no-host-paths.sh`).
 *
 * It is a shared, tracked artifact that runs on every Write/Edit, so "I piped a
 * few payloads through it once" is not coverage. These drive the real script
 * with the real payload shape.
 *
 * Two failure directions matter equally. A guard that stops catching violations
 * is useless; a guard that blocks legitimate writes gets deleted, which is
 * worse. The allow-cases below are the ones that would cause that.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, '.claude', 'hooks', 'no-host-paths.sh');

/** Fragments, so this file never trips the guard it is testing. */
const LINUX_HOME = '/' + 'home' + '/someuser/proj';
const MAC_HOME = '/' + 'Users' + '/someuser/proj';
const WIN_HOME = 'C:\\' + 'Users' + '\\someuser\\proj';

/** Run the hook with a synthetic payload; returns the parsed decision or null. */
function runHook(payload) {
    const res = spawnSync('bash', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT }
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0); // the hook must never crash the tool call
    if (!res.stdout.trim()) return null;
    return JSON.parse(res.stdout).hookSpecificOutput;
}

const write = (file, content) => ({ tool_name: 'Write', tool_input: { file_path: file, content } });
const inRepo = (rel) => path.join(ROOT, rel);

describe('the host-path PreToolUse guard', () => {
    it('is present and executable', () => {
        // Everything below would pass vacuously against a missing script.
        expect(spawnSync('bash', ['-n', HOOK]).status).toBe(0);
    });

    describe('blocks a machine-specific path written into the repo', () => {
        it.each([
            ['a Linux home directory', LINUX_HOME],
            ['a macOS home directory', MAC_HOME],
            ['a Windows user profile', WIN_HOME]
        ])('denies %s', (_label, offending) => {
            const out = runHook(write(inRepo('docs/example.md'), `see ${offending} for details`));
            expect(out).not.toBeNull();
            expect(out.permissionDecision).toBe('deny');
            expect(out.permissionDecisionReason).toMatch(/machine-specific/);
        });

        it('denies the new_string of an Edit, not just a whole-file Write', () => {
            const out = runHook({
                tool_name: 'Edit',
                tool_input: { file_path: inRepo('docs/example.md'), old_string: 'a', new_string: LINUX_HOME }
            });
            expect(out.permissionDecision).toBe('deny');
        });

        it('names the offending file so the message is actionable', () => {
            const out = runHook(write(inRepo('docs/example.md'), LINUX_HOME));
            expect(out.permissionDecisionReason).toContain('docs/example.md');
        });
    });

    describe('leaves legitimate writes alone', () => {
        it('allows container-absolute paths, which are correct in this project', () => {
            expect(runHook(write(inRepo('docs/x.md'), '/app/data /app/logs /usr/local/bin/entrypoint.sh')))
                .toBeNull();
        });

        it('allows $HOME and ~ forms, which are the fix being recommended', () => {
            expect(runHook(write(inRepo('docs/x.md'), 'export E="$HOME/docker/x"; cd ~/docker/x')))
                .toBeNull();
        });

        it('ignores files outside the repo, where local paths are legitimate', () => {
            // Scratchpads and /tmp are where throwaway scripts live.
            expect(runHook(write('/tmp/scratch/run.sh', `cd ${LINUX_HOME}`))).toBeNull();
        });

        it('ignores tools that are not writes', () => {
            expect(runHook({ tool_name: 'Bash', tool_input: { command: `ls ${LINUX_HOME}` } })).toBeNull();
            expect(runHook({ tool_name: 'Read', tool_input: { file_path: inRepo('docs/x.md') } })).toBeNull();
        });

        it('does not block an edit to its own source', () => {
            // The script names the patterns it forbids. If it matched itself it
            // would be unmaintainable — nobody could ever edit it again.
            const src = require('fs').readFileSync(HOOK, 'utf8');
            expect(runHook(write(HOOK, src))).toBeNull();
        });
    });

    describe('resolves symlinks before deciding a file is outside the repo', () => {
        // This repo is reachable at two paths on the dev machine, one a symlink
        // to the other. A plain prefix match fails OPEN for the alias — the
        // guard misses precisely where the setup is unusual. Build a real
        // symlink rather than relying on that machine's layout.
        let aliasDir;

        beforeAll(() => {
            aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-path-alias-'));
            fs.symlinkSync(ROOT, path.join(aliasDir, 'repo'), 'dir');
        });
        afterAll(() => aliasDir && fs.rmSync(aliasDir, { recursive: true, force: true }));

        it('catches a violation arriving through a symlink to this repo', () => {
            const viaAlias = path.join(aliasDir, 'repo', 'docs', 'example.md');
            // Guard the guard: a plain string prefix check would NOT match here,
            // which is exactly why symlink resolution is required.
            expect(viaAlias.startsWith(ROOT)).toBe(false);

            const out = runHook(write(viaAlias, LINUX_HOME));
            expect(out).not.toBeNull();
            expect(out.permissionDecision).toBe('deny');
        });

        it('still ignores a symlink that points outside the repo', () => {
            const outside = path.join(aliasDir, 'loose.md');
            expect(runHook(write(outside, LINUX_HOME))).toBeNull();
        });
    });
});

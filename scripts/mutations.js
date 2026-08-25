/**
 * Mutation catalog.
 *
 * Each entry reintroduces the ORIGINAL defect of a fix we shipped. Running the
 * suite against it must FAIL. A mutation that survives means the fix is not
 * protected by any test — a green suite that would not notice the bug coming
 * back.
 *
 * This exists because three consecutive code-review rounds on #177 each found a
 * fix that no test actually guarded: source-text assertions that passed against
 * a reintroduced bug, a parity regex satisfied by a leftover import, and a
 * heuristic whose branch could be deleted with the suite still green. Reading a
 * test and judging it plausible does not answer "would this catch the bug?" —
 * only reintroducing the bug does.
 *
 * Adding a mutation is how you prove a new fix is covered. `anchor` must be text
 * that exists verbatim in `file`; `mutant` replaces it. `tests` is an optional
 * jest path pattern used by --fast.
 */
module.exports = [
    // ---- #169: notifyOnSuccess gates every channel --------------------------
    {
        id: '169-gate-ignored', ticket: '#169',
        desc: '`never` no longer mutes a channel',
        file: 'src/services/notificationService.js',
        anchor: "    if (mode === 'never') return false;",
        mutant: "    if (mode === 'never') return true;",
        tests: 'notificationService'
    },
    {
        id: '169-errors-only-suppresses-failure', ticket: '#169',
        desc: 'errors_only drops failures too (the invariant that must never break)',
        file: 'src/services/notificationService.js',
        anchor: "    if (mode === 'errors_only') return status !== 'success';",
        mutant: "    if (mode === 'errors_only') return false;",
        tests: 'notificationService'
    },
    {
        id: '169-partial-not-error', ticket: '#169',
        desc: 'partial treated as success rather than an error signal',
        file: 'src/services/notificationService.js',
        anchor: "    if (mode === 'errors_only') return status !== 'success';",
        mutant: "    if (mode === 'errors_only') return status === 'failure';",
        tests: 'notificationService'
    },
    {
        id: '169-bypass-ignored', ticket: '#169',
        desc: 'dashboard test notifications no longer bypass the gate',
        file: 'src/services/notificationService.js',
        anchor: '      bypassThresholds || this.shouldNotifyChannel(channel, status, entry);',
        mutant: '      this.shouldNotifyChannel(channel, status, entry);',
        tests: 'notificationService'
    },
    {
        id: '169-entry-tier-lost', ticket: '#169',
        desc: 'per-webhook-entry override ignored',
        file: 'src/services/notificationService.js',
        anchor: '      entry?.notifyOnSuccess ??',
        mutant: '      undefined ??',
        tests: 'notificationService'
    },

    // ---- #171: honest delivery reporting ------------------------------------
    {
        id: '171-always-sent', ticket: '#171',
        desc: 'notifySync claims success even when nothing was delivered',
        file: 'src/services/notificationService.js',
        anchor: '      // sync outcome itself was already reported.\n'
            + '      const outcome = this._deliveryOutcome(results);\n\n'
            + '      if (outcome.delivered === 0) {',
        mutant: '      // sync outcome itself was already reported.\n'
            + '      const outcome = this._deliveryOutcome(results);\n\n'
            + '      if (false) {',
        tests: 'notificationService'
    },
    {
        id: '171-truthy-failure-counted', ticket: '#171',
        desc: 'a truthy {success:false} email/ntfy result counted as delivered',
        file: 'src/services/notificationService.js',
        anchor: "      const ok = typeof value === 'object' ? value.success !== false : Boolean(value);",
        mutant: '      const ok = Boolean(value);',
        tests: 'notificationService'
    },
    {
        id: '171-ratelimit-charged-early', ticket: '#171',
        desc: 'an undelivered failure burns the rate-limit budget, suppressing the next one',
        file: 'src/services/notificationService.js',
        anchor: '      // sync outcome itself was already reported.\n'
            + '      const outcome = this._deliveryOutcome(results);',
        mutant: "      if (status === 'failure') { this.updateRateLimitTracking(serverName); }\n"
            + '      const outcome = this._deliveryOutcome(results);',
        tests: 'notificationService'
    },

    // ---- #172: poll-error suppression ---------------------------------------
    {
        id: '172-error-every-tick', ticket: '#172',
        desc: 'an unrecoverable poll error is logged at ERROR on every tick again',
        file: 'src/services/telegramBot.js',
        anchor: '      if (key === this.lastPollErrorKey) {',
        mutant: '      if (false) {',
        tests: 'telegramBot'
    },

    // ---- #173: version consistency ------------------------------------------
    {
        id: '173-package-version', ticket: '#173',
        desc: 'prometheus reads package.json instead of resolveVersion()',
        file: 'src/services/prometheusService.js',
        anchor: '    this.appInfo.labels(resolveVersion(), process.version).set(1);',
        mutant: "    this.appInfo.labels(require('../../package.json').version, process.version).set(1);",
        tests: 'prometheusService'
    },

    // ---- #174: legacy telegram webhooks -------------------------------------
    {
        id: '174-legacy-unreachable', ticket: '#174',
        desc: 'webhooks.telegram fallback unreachable again',
        file: 'src/services/notificationService.js',
        anchor: '    const telegram = this.config.telegram?.enabled\n      ? this.config.telegram\n'
            + '      : (legacyEntry ? { ...legacyEntry, enabled: true } : this.config.telegram);',
        mutant: '    const telegram = this.config.telegram || legacyEntry;',
        tests: 'notificationService'
    },

    // ---- #177: a trustworthy pre-flight -------------------------------------
    {
        id: '177-hardcoded-path-segmented', ticket: '#177',
        desc: 'validateConfig rebuilds the schema path with path.join segments',
        file: 'scripts/validateConfig.js',
        anchor: '  const schemaPath = resolveSchemaPath(projectRoot);',
        mutant: "  const schemaPath = path.join(projectRoot, 'config', 'config.schema.json');",
        tests: 'configExamplesGuard'
    },
    {
        id: '177-hardcoded-path-template', ticket: '#177',
        desc: 'validateConfig rebuilds the schema path with a template literal',
        file: 'scripts/validateConfig.js',
        anchor: '  const schemaPath = resolveSchemaPath(projectRoot);',
        mutant: '  const schemaPath = `${projectRoot}/config/config.schema.json`;',
        tests: 'configExamplesGuard'
    },
    {
        id: '177-silent-skip', ticket: '#177',
        desc: 'a missing schema is silently skipped and success reported',
        file: 'scripts/validateConfig.js',
        anchor: '  if (!fs.existsSync(schemaPath)) {',
        mutant: '  if (false) {',
        tests: 'configExamplesGuard'
    },
    {
        id: '177-index-hardcoded', ticket: '#177',
        desc: 'index.js rebuilds the schema path, leaving the import behind',
        file: 'index.js',
        anchor: '    const schemaFile = resolveSchemaPath(__dirname);',
        mutant: "    const schemaFile = path.join(__dirname, 'config', 'config.schema.json');",
        tests: 'configExamplesGuard'
    },
    {
        id: '177-helper-hardcoded', ticket: '#177',
        desc: 'the shared helper itself stops consulting the defaults dir',
        file: 'src/lib/configBootstrap.js',
        anchor: "    return path.join(resolveDefaultsDir(root), 'config.schema.json');",
        mutant: "    return path.join(root, 'config', 'config.schema.json');",
        tests: 'configExamplesGuard'
    },
    {
        id: '177-extractor-notif-branch', ticket: '#177',
        desc: 'notifications-level snippet lifting removed',
        file: 'src/__tests__/helpers/configSnippets.js',
        anchor: '            } else if (keys.some(k => notifKeys.has(k))) {',
        mutant: '            } else if (false) {',
        tests: 'configExamplesGuard'
    },
    {
        id: '177-extractor-server-branch', ticket: '#177',
        desc: 'server-level snippet lifting removed',
        file: 'src/__tests__/helpers/configSnippets.js',
        anchor: '            } else if (keys.some(k => serverKeys.has(k))) {',
        mutant: '            } else if (false) {',
        tests: 'configExamplesGuard'
    },
    {
        id: '177-extractor-wrapper-branch', ticket: '#177',
        desc: "typo'd-wrapper heuristic removed",
        file: 'src/__tests__/helpers/configSnippets.js',
        anchor: '            } else if (keys.length === 1 && looksLikeSection(parsed[keys[0]])) {',
        mutant: '            } else if (false) {',
        tests: 'configExamplesGuard'
    },
    {
        id: '177-extractor-looks-like-section', ticket: '#177',
        desc: 'looksLikeSection stops discriminating, so any single-key wrapper is treated as config',
        file: 'src/__tests__/helpers/configSnippets.js',
        anchor: "    const looksLikeSection = (v) => v && typeof v === 'object' && !Array.isArray(v) &&\n"
            + '        Object.keys(v).some(k => notifKeys.has(k) || serverKeys.has(k) || topLevel.has(k));',
        mutant: '    const looksLikeSection = () => true;',
        tests: 'configExamplesGuard'
    },
    {
        id: '177-extractor-array-guard', ticket: '#177',
        desc: 'the non-object/array guard weakens, letting an array of config objects through',
        file: 'src/__tests__/helpers/configSnippets.js',
        anchor: "            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;",
        mutant: '            if (!parsed) continue;',
        tests: 'configExamplesGuard'
    },
    {
        id: '177-skip-marker-global', ticket: '#177',
        desc: 'the config-guard skip marker loses its anchor and swallows every later block',
        file: 'src/__tests__/helpers/configSnippets.js',
        anchor: 'const SKIP_MARKER = /<!--\\s*config-guard:\\s*skip\\s*-->\\s*$/;',
        mutant: 'const SKIP_MARKER = /<!--\\s*config-guard:\\s*skip\\s*-->/;',
        tests: 'configExamplesGuard'
    },
    // ---- #169: fixes found in later review rounds ---------------------------
    {
        id: '169-warn-on-success', ticket: '#169',
        desc: 'enabledChannelCount ignores the status gate, warning on every successful sync',
        file: 'src/services/notificationService.js',
        anchor: "          const level = this.enabledChannelCount(allow) > 0 ? 'warn' : 'debug';",
        mutant: "          const level = this.enabledChannelCount() > 0 ? 'warn' : 'debug';",
        tests: 'notificationService'
    },
    {
        id: '169-muted-warning-gone', ticket: '#169',
        desc: 'the startup warning naming muted channels stops firing',
        file: 'src/services/notificationService.js',
        anchor: '    const muted = this.mutedChannels();',
        mutant: '    const muted = [];',
        tests: 'notificationService'
    },
    {
        id: '169-muted-warning-callsite', ticket: '#169',
        desc: 'the constructor computes muted channels but never warns about them',
        file: 'src/services/notificationService.js',
        anchor: '    if (muted.length > 0) {',
        mutant: '    if (false) {',
        tests: 'notificationService'
    },
    {
        id: '169-notify-not-propagated', ticket: '#169',
        desc: '/notify stops reaching the dispatch path, so the mode applies to the bot alone',
        file: 'src/services/telegramBot.js',
        anchor: '      notificationService.config.telegram.notifyOnSuccess = this.config.notifyOnSuccess;',
        mutant: '      void notificationService;',
        tests: 'telegramBot'
    },
    {
        id: '169-persisted-overrides-config', ticket: '#169',
        desc: 'a persisted /notify value wins over an explicit config value again',
        file: 'src/services/telegramBot.js',
        anchor: '          if (this.config.notifyOnSuccessFromConfig) {',
        mutant: '          if (false) {',
        tests: 'telegramBot'
    },
    {
        id: '169-sync-confirmation-back', ticket: '#169',
        desc: "the inverted /sync confirmation returns, so `never` sends MORE than `always`",
        file: 'src/services/telegramBot.js',
        anchor: '      await syncBank(server, { isAutomated: false, retryAttempt: 0 });',
        mutant: '      await syncBank(server, { isAutomated: false, retryAttempt: 0 });\n'
            + "      if (this.config.notifyOnSuccess === 'never') {\n"
            + '        await this.sendMessage(`✅ Sync completed for ${serverName}`);\n'
            + '      }',
        tests: 'telegramBot'
    },

    // ---- #171: schema rule behind the undeliverable-email case ---------------
    {
        id: '171-email-not-required', ticket: '#171',
        desc: 'an enabled email channel no longer needs from/to, so it can never deliver',
        file: 'config/config.schema.json',
        anchor: '            "required": ["from", "to"],',
        mutant: '            "required": [],',
        tests: 'configLoader'
    },

    // ---- #177: the runner's own scoring -------------------------------------
    // These mutate the mutation runner itself. That works because jest re-reads
    // the file from disk, while the running runner keeps its own copy in the
    // require cache. Their guards live in mutationRunner.test.js and NOT in
    // mutationCatalog.test.js, which the runner excludes from the scored suite —
    // a guard placed there would score every one of these as SURVIVED.
    {
        id: '177-mutant-load-error-scored', ticket: '#177',
        desc: 'a suite that fails to LOAD is scored, so a guarded defect reads as SURVIVED',
        file: 'scripts/mutationTest.js',
        anchor: '    if (result.loadErrors > 0) {\n        throw new Error(',
        mutant: '    if (false) {\n        throw new Error(',
        tests: 'mutationRunner'
    },
    {
        id: '177-baseline-load-error-ignored', ticket: '#177',
        desc: 'the baseline prints green while whole test files failed to import',
        file: 'scripts/mutationTest.js',
        anchor: '    if (result.loadErrors > 0) {\n        return ',
        mutant: '    if (false) {\n        return ',
        tests: 'mutationRunner'
    },
    {
        id: '177-baseline-success-ignored', ticket: '#177',
        desc: "jest's own success flag is dropped from the baseline check",
        file: 'scripts/mutationTest.js',
        anchor: '    if (!result.success) {\n        return \'jest reported the run as unsuccessful',
        mutant: '    if (false) {\n        return \'jest reported the run as unsuccessful',
        tests: 'mutationRunner'
    },
    {
        id: '177-recover-ignores-lock', ticket: '#177',
        desc: '--recover proceeds during a live run, inverting that run\'s verdict',
        file: 'scripts/mutationTest.js',
        anchor: '    if (owner && owner !== String(self)) {',
        mutant: '    if (false) {',
        tests: 'mutationRunner'
    },
    {
        id: '177-reverted-mutant-benign', ticket: '#177',
        desc: 'a mutant reverted mid-run is read as the benign failed-write case',
        file: 'scripts/mutationTest.js',
        anchor: "    return mutantWritten ? 'contaminated' : 'never-mutated';",
        mutant: "    return 'never-mutated';",
        tests: 'mutationRunner'
    },
    {
        id: '177-eperm-read-as-dead', ticket: '#177',
        desc: 'a live lock owner belonging to another user is treated as dead',
        file: 'scripts/mutationTest.js',
        anchor: "        return err.code !== 'ESRCH';",
        mutant: '        return false;',
        tests: 'mutationRunner'
    },
    {
        id: '177-runner-crash-exits-1', ticket: '#177',
        desc: 'an internal crash exits 1, indistinguishable from "mutations survived"',
        file: 'scripts/mutationTest.js',
        anchor: "        console.error('If a file was left mutated: npm run test:mutation -- --recover');\n"
            + '        return 2;',
        mutant: "        console.error('If a file was left mutated: npm run test:mutation -- --recover');\n"
            + '        return 1;',
        tests: 'mutationRunner'
    },
    // Unwiring: each decision above is a pure function, so deleting its call
    // site leaves every unit test green. These prove the call sites exist.
    {
        id: '177-readreport-unwired', ticket: '#177',
        desc: 'runSuite stops normalising through readReport, losing success and load errors',
        file: 'scripts/mutationTest.js',
        anchor: "        return readReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')));",
        mutant: "        const r = JSON.parse(fs.readFileSync(reportFile, 'utf8'));\n"
            + '        return { ran: r.numTotalTests, failed: r.numFailedTests };',
        tests: 'mutationRunner'
    },
    {
        id: '177-recover-lock-unwired', ticket: '#177',
        desc: 'recover() no longer consults the lock before writing',
        file: 'scripts/mutationTest.js',
        anchor: '    const refusal = recoveryRefusal(liveLockOwner(), process.pid);',
        mutant: '    const refusal = null;',
        tests: 'mutationRunner'
    },
    {
        id: '177-baseline-check-unwired', ticket: '#177',
        desc: 'main() computes no baseline problem, so any baseline is accepted',
        file: 'scripts/mutationTest.js',
        anchor: '        const problem = baselineProblem(baseline);',
        mutant: '        const problem = null;',
        tests: 'mutationRunner'
    },
    {
        id: '177-score-unwired', ticket: '#177',
        desc: 'the verdict goes back to raw failed-count, skipping the load-error refusal',
        file: 'scripts/mutationTest.js',
        anchor: '                verdict = scoreMutant(runSuite(fast ? m.tests : null));',
        mutant: "                verdict = runSuite(fast ? m.tests : null).failed > 0 ? 'caught' : 'survived';",
        tests: 'mutationRunner'
    },
    {
        id: '177-poststate-unwired', ticket: '#177',
        desc: 'the file-state check is inlined again without the mutantWritten case',
        file: 'scripts/mutationTest.js',
        anchor: '                const state = postRunState({ now, original, mutated, mutantWritten });',
        mutant: "                const state = now === mutated ? 'mutant-intact'\n"
            + "                    : (now === original ? 'never-mutated' : 'contaminated');",
        tests: 'mutationRunner'
    },

    // ---- #178/#179/#180: round-8 deferrables --------------------------------
    {
        id: '178-predictable-report-path', ticket: '#178',
        desc: 'the jest report goes back to a pid-named path a stale file can occupy',
        file: 'scripts/mutationTest.js',
        anchor: "    return fs.mkdtempSync(path.join(os.tmpdir(), 'actual-sync-mutation-'));",
        mutant: '    const dir = path.join(os.tmpdir(), `mutation-report-${process.pid}`);\n'
            + '    fs.mkdirSync(dir, { recursive: true });\n'
            + '    return dir;',
        tests: 'mutationRunner'
    },
    {
        id: '178-report-dir-unwired', ticket: '#178',
        desc: 'runSuite stops allocating a fresh directory and writes into a shared one',
        file: 'scripts/mutationTest.js',
        anchor: '    const reportDir = makeReportDir();',
        mutant: '    const reportDir = os.tmpdir();',
        tests: 'mutationRunner'
    },
    {
        id: '179-fast-baselines-full-suite', ticket: '#179',
        desc: '--fast scores scoped runs while baselining only the full suite',
        file: 'scripts/mutationTest.js',
        anchor: '    if (!fast) return [null];',
        mutant: '    return [null];',
        tests: 'mutationRunner'
    },
    {
        id: '179-baseline-targets-unwired', ticket: '#179',
        desc: 'main ignores the chosen baseline targets and assumes the full suite',
        file: 'scripts/mutationTest.js',
        anchor: '        for (const target of baselineTargets(selected, fast)) {',
        mutant: '        for (const target of [null]) {',
        tests: 'mutationRunner'
    },
    {
        id: '180-runner-ships-in-image', ticket: '#180',
        desc: 'the file-mutating runner is shipped inside the production image again',
        file: '.dockerignore',
        anchor: 'scripts/mutationTest.js\nscripts/mutations.js',
        mutant: '# scripts/mutationTest.js\n# scripts/mutations.js',
        tests: 'docDriftGuards'
    },

    // ---- machine-specific path guards ---------------------------------------
    {
        id: 'paths-hook-symlink-blind', ticket: '#180',
        desc: 'the write guard stops resolving symlinks, so an aliased repo path escapes it',
        file: '.claude/hooks/no-host-paths.sh',
        anchor: 'file_r="$(resolve "$(dirname -- "$file")")/$(basename -- "$file")"',
        mutant: 'file_r="$file"',
        tests: 'hostPathHook'
    },
    {
        id: 'paths-hook-edit-ignored', ticket: '#180',
        desc: 'the write guard only inspects whole-file writes, so an Edit slips a path through',
        file: '.claude/hooks/no-host-paths.sh',
        anchor: "content=\"$(jqr '[.tool_input.content, .tool_input.new_string,",
        mutant: "content=\"$(jqr '[.tool_input.content,",
        tests: 'hostPathHook'
    },
    {
        id: 'paths-guard-marker-always-skips', ticket: '#180',
        desc: 'every line is treated as carrying the opt-out marker, so the guard finds nothing',
        file: 'src/__tests__/docDriftGuards.test.js',
        anchor: '            if (line.includes(ALLOW_MARKER)) return;',
        mutant: '            if (true) return;',
        tests: 'docDriftGuards'
    },

    // ---- #176: the dead-class-method gate -----------------------------------
    {
        id: '176-dead-method-scan-blind', ticket: '#176',
        desc: 'the dead-method scan stops marking anything dead, so the gate passes on everything',
        file: 'src/__tests__/deadMethodGuard.test.js',
        anchor: '            if (refs === 0) { dead.add(m); grew = true; }',
        mutant: '            if (false) { dead.add(m); grew = true; }',
        tests: 'deadMethodGuard'
    },
    {
        id: '176-dead-family-not-collapsed', ticket: '#176',
        desc: 'a one-line dead method keeps propping up its helpers, so a dead family survives',
        file: 'src/__tests__/deadMethodGuard.test.js',
        anchor: 'dead.has(d) && d.file === f && n >= d.line && n <= d.end',
        mutant: 'dead.has(d) && d.file === f && n > d.line && n <= d.end',
        tests: 'deadMethodGuard'
    },
    {
        id: '176-allowlist-swallows-findings', ticket: '#176',
        desc: 'the reviewed-kept list is treated as matching everything, hiding real findings',
        file: 'src/__tests__/deadMethodGuard.test.js',
        anchor: '    return found.filter((m) => !reviewed.has(m.key));',
        mutant: '    return found.filter(() => false);',
        tests: 'deadMethodGuard'
    },

    // ---- #182: every channel testable from the dashboard --------------------
    {
        id: '182-ntfy-untestable-again', ticket: '#182',
        desc: 'the ntfy case is unreachable, so a misconfigured topic cannot be verified',
        file: 'src/services/healthCheck.js',
        anchor: "          case 'ntfy': {",
        mutant: "          case 'ntfy-unreachable': {",
        tests: 'healthCheck'
    },
    {
        id: '182-ntfy-disabled-counted', ticket: '#182',
        desc: 'a disabled ntfy channel is treated as configured and reports success',
        file: 'src/services/healthCheck.js',
        anchor: '            if (!ntfyCfg?.enabled || !ntfyCfg?.url) {',
        mutant: '            if (false) {',
        tests: 'healthCheck'
    },
    {
        id: '182-generic-all-disabled-counted', ticket: '#182',
        desc: 'an all-disabled generic webhook array counts as configured (#169 regression)',
        file: 'src/services/healthCheck.js',
        anchor: '              .filter(w => w.url && w.enabled !== false);',
        mutant: '              .filter(w => w.url);',
        tests: 'healthCheck'
    },
    {
        id: '182-generic-gate-applied', ticket: '#182',
        desc: 'the test send is gated by notifyOnSuccess, so errors_only silently skips it',
        file: 'src/services/healthCheck.js',
        anchor: '              .sendGenericWebhooks(buildTestNotification().generic);',
        mutant: '              .sendGenericWebhooks(buildTestNotification().generic, () => true);',
        tests: 'healthCheck'
    },
    {
        id: '182-parity-gate-blind', ticket: '#182',
        desc: 'the channel-parity gate derives no channels, so it passes on anything',
        file: 'src/__tests__/docDriftGuards.test.js',
        anchor: "        ...['email', 'telegram', 'ntfy'].filter((k) => notif[k]),",
        mutant: '        ...[].filter((k) => notif[k]),',
        tests: 'docDriftGuards'
    },

    // ---- #183: release-time scripts stay out of the image -------------------
    {
        id: '183-version-bump-ships', ticket: '#183',
        desc: 'version-bump.js ships again, able to rewrite the container package manifests',
        file: '.dockerignore',
        anchor: 'scripts/version-bump.js',
        mutant: '# scripts/version-bump.js',
        tests: 'docDriftGuards'
    },
    {
        id: '183-scripts-excluded-wholesale', ticket: '#183',
        desc: 'scripts/ is ignored wholesale, taking validate-config and the operator tools with it',
        file: '.dockerignore',
        anchor: 'scripts/generateDashboardScreenshots.js\nscripts/generate-badges.js\nscripts/version-bump.js',
        mutant: 'scripts',
        tests: 'docDriftGuards'
    },

    // ---- #188: notification activity on the dashboard -----------------------
    {
        id: '188-stats-endpoint-blind', ticket: '#188',
        desc: 'the notifications endpoint stops reporting what the service measured',
        file: 'src/services/healthCheck.js',
        anchor: '          ...this.notificationService.getStats(),',
        mutant: '          ...{},',
        tests: 'healthCheck'
    },
    {
        id: '188-ratelimit-denominator-lost', ticket: '#188',
        desc: 'the configured ceiling is dropped, so "remaining" has nothing to count down from',
        file: 'src/services/healthCheck.js',
        anchor: '          rateLimit: this.notificationService.config?.rateLimit',
        mutant: '          rateLimit: undefined',
        tests: 'healthCheck'
    },
    {
        id: '188-panel-never-loads', ticket: '#188',
        desc: 'the endpoint exists but the dashboard never calls it — the #182 mistake again',
        file: 'src/services/dashboard.html',
        anchor: '            loadNotificationStats();\n            try {',
        mutant: '            try {',
        tests: 'docDriftGuards'
    },

    // ---- #187: secret redaction on the path that actually writes ------------
    // There were no redaction mutations at all before this. Breaking secret
    // masking is the one failure here that puts a credential in a log file, so
    // it is the last thing that should rely on tests nobody has scored.
    {
        id: '187-message-not-masked', ticket: '#187',
        desc: 'a secret embedded in the log MESSAGE reaches console and file unmasked',
        file: 'src/lib/logger.js',
        anchor: '            safeMessage = this.maskSecrets(message);',
        mutant: '            safeMessage = message;',
        tests: 'logger'
    },
    {
        id: '187-meta-not-redacted', ticket: '#187',
        desc: 'metadata is written without redaction, so a password field lands in the log',
        file: 'src/lib/logger.js',
        anchor: '            safeMeta = this.redact(meta);',
        mutant: '            safeMeta = meta;',
        tests: 'logger'
    },
    {
        id: '187-context-not-redacted', ticket: '#187',
        desc: 'the logger context bypasses redaction',
        file: 'src/lib/logger.js',
        anchor: '            safeContext = this.redact(this.context);',
        mutant: '            safeContext = this.context;',
        tests: 'logger'
    },
    {
        id: '187-file-line-unredacted', ticket: '#187',
        desc: 'the FILE line is serialized from raw values while the console stays masked',
        file: 'src/lib/logger.js',
        anchor: '                const fileLine = this.safeSerialize(level, safeMessage, safeContext, safeMeta, this.fileFormat);',
        mutant: '                const fileLine = this.safeSerialize(level, message, this.context, meta, this.fileFormat);',
        tests: 'logger'
    },

    // ---- #207/#208: the drift reporter's false all-clears -------------------
    //
    // Every one of these was a real defect found in review AFTER the tool
    // shipped, and every one made it report "no drift" for something inert.
    // That is the single failure mode this tool is not allowed to have, so each
    // fix gets a mutation proving a test would notice it coming back.
    {
        id: '208-describe-blind-to-unreachable-tags', ticket: '#208',
        desc: 'the latest tag is resolved with `git describe`, which only sees tags reachable from HEAD',
        file: 'scripts/defaultBranchDrift.js',
        anchor: "        latestTag = git(['tag', '--list', 'v*', '--sort=-v:refname'], root)",
        mutant: "        latestTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'], root)",
        tests: 'defaultBranchDrift'
    },
    {
        id: '207-parse-failure-reads-as-clean', ticket: '#207',
        desc: 'an unparseable workflow returns [] instead of null, so "cannot read it" is indistinguishable from "no triggers"',
        file: 'scripts/defaultBranchDrift.js',
        anchor: '        return null;\n    }\n    if (!doc || typeof doc !== \'object\') return [];',
        mutant: '        return [];\n    }\n    if (!doc || typeof doc !== \'object\') return [];',
        tests: 'defaultBranchDrift'
    },
    {
        id: '207-base-side-denylist-again', ticket: '#207',
        desc: 'the base-side scan reverts to the three-name deny-list while the head side uses the allow-list',
        file: 'scripts/defaultBranchDrift.js',
        anchor: '        const reasons = workflowDriftReasons(baseText);',
        mutant: '        const reasons = extractDefaultBranchOnlyTriggers(baseText);',
        tests: 'defaultBranchDrift'
    },

    // ---- #205: re-testing a retargeted PR against its new base --------------
    //
    // The defect is a stale green: a PR retargeted from main to development
    // keeps the check it earned against main and can be merged untested. The
    // runtime behaviour was verified by hand on scratch PR #214; what these
    // mutations protect is the wiring that can rot silently afterwards, since
    // the happy path still looks fine with any of them applied.
    {
        id: '205-no-retest-trigger', ticket: '#205',
        desc: 'the close/reopen that re-triggers CI is removed, so a retargeted PR keeps main\'s check',
        file: '.github/workflows/retarget-dependabot.yml',
        anchor: 'if ! gh pr close "$PR" --repo "$REPO" >/dev/null; then',
        mutant: 'if ! true; then',
        tests: 'retargetRetest'
    },
    {
        id: '205-failsafe-order-inverted', ticket: '#205',
        desc: 'the red status is posted after the close instead of before it, so a crash mid-way leaves the stale green showing',
        file: '.github/workflows/retarget-dependabot.yml',
        anchor: '            post_status "failure" "Base moved to development; awaiting a re-run. The existing check was computed against main."\n',
        mutant: '',
        tests: 'retargetRetest'
    },
    {
        id: '205-closed-pr-exits-green', ticket: '#205',
        desc: 'a PR left closed after a failed reopen no longer fails the job, so a security PR can be silently abandoned',
        file: '.github/workflows/retarget-dependabot.yml',
        anchor: 'reopened. Reopen it by hand — a closed security PR may not be recreated by Dependabot."\n              FAILED=1',
        mutant: 'reopened. Reopen it by hand — a closed security PR may not be recreated by Dependabot."\n              FAILED=0',
        tests: 'retargetRetest'
    },

    // ---- #213: a funding guard that could not fail --------------------------
    //
    // The guard asserted every sponsor link it FOUND was correct, and found none
    // on three of four surfaces — so deleting the link from the Docker Hub
    // description left the suite green (verified: 108/108). That is the exact
    // regression it was written for: #199 shipped a stale Buy Me a Coffee link
    // to every image user.
    {
        id: '213-sponsor-link-deleted', ticket: '#213',
        desc: 'the sponsor link is dropped from the published Docker Hub description again',
        file: 'docker/description/long.md',
        anchor: '- ❤️ Sponsor: https://github.com/sponsors/agigante80',
        mutant: '- ❤️ Sponsor: (removed)',
        tests: 'docDriftGuards'
    },

    // ---- #210: the re-test must be proven, not assumed ----------------------
    //
    // Shipped as part of #205 and immediately wrong: the green "re-tested"
    // status was posted on a successful reopen alone. A CONFLICTING PR produces
    // no CI run at all, and conflicting is the normal state of a retargeted PR
    // — so the marker claimed a re-test that had not happened.
    {
        id: '210-status-cleared-without-evidence', ticket: '#210',
        desc: 'the green re-tested status is posted on a successful reopen alone, with no run to back it',
        file: '.github/workflows/retarget-dependabot.yml',
        anchor: 'if [ "$RETESTED" -eq 1 ]; then',
        mutant: 'if true; then',
        tests: 'retargetRetest'
    },
    {
        id: '210-existence-not-freshness', ticket: '#210',
        desc: 'any run on the head SHA counts as evidence, including the PR\'s original main-based run',
        file: '.github/workflows/retarget-dependabot.yml',
        anchor: 'if [ "$LATEST" -gt "$RUNS_BEFORE" ]; then',
        mutant: 'if [ "$LATEST" -gt 0 ]; then',
        tests: 'retargetRetest'
    },

    // ---- #169: the README claim that started #168 ---------------------------
    {
        id: '169-readme-failure-only', ticket: '#169',
        desc: 'the README claims notifications fire only on failures again',
        file: 'README.md',
        anchor: '- **Notifies** you of sync results via Telegram',
        mutant: '- **Notifies** you of failures via Telegram',
        tests: 'docDriftGuards'
    }
];

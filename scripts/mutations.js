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
        anchor: '        .then(() => syncBank(server, { isAutomated: false, retryAttempt: 0 }))',
        mutant: '        .then(() => syncBank(server, { isAutomated: false, retryAttempt: 0 }))\n'
            + "        .then(() => this.config.notifyOnSuccess === 'never'\n"
            + '          && this.sendMessage(`✅ Sync completed for ${serverName}`))',
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
        file: 'scripts/no-host-paths.sh',
        anchor: 'file_r="$(resolve "$(dirname -- "$file")")/$(basename -- "$file")"',
        mutant: 'file_r="$file"',
        tests: 'hostPathHook'
    },
    {
        id: 'paths-hook-edit-ignored', ticket: '#180',
        desc: 'the write guard only inspects whole-file writes, so an Edit slips a path through',
        file: 'scripts/no-host-paths.sh',
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
        file: 'src/services/dashboard.js',
        anchor: '    loadNotificationStats();\n    loadConfigAudit();\n    try {',
        mutant: '    loadConfigAudit();\n    try {',
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

    {
        id: '213-nonyaml-treated-as-workflow', ticket: '#213',
        desc: 'the runtime scan drops its .yml filter, so a README under .github/workflows/ is reported as unparseable',
        file: 'scripts/defaultBranchDrift.js',
        anchor: "    relPath.startsWith(WORKFLOW_PREFIX) && /\\.ya?ml$/.test(relPath);",
        mutant: "    relPath.startsWith(WORKFLOW_PREFIX);",
        tests: 'defaultBranchDrift'
    },
    {
        id: '213-dedupe-compares-joined', ticket: '#213',
        desc: 'the base-side dedupe compares joined strings again, so a two-category workflow prints its reasons twice',
        file: 'scripts/defaultBranchDrift.js',
        anchor: '            } else if (!sameReasons(headReasons, reasons)) {',
        mutant: '            } else if (!sides.includes(why)) {',
        tests: 'defaultBranchDrift'
    },
    {
        id: '213-dedupe-suppresses-real-drift', ticket: '#213',
        desc: 'the dedupe over-matches and hides a genuinely different base copy',
        file: 'scripts/defaultBranchDrift.js',
        anchor: '    if (a.length !== b.length) return false;',
        mutant: '    return true;',
        tests: 'defaultBranchDrift'
    },

    // ---- #205/#210/#216: the retarget re-test ------------------------------
    //
    // These anchored in the workflow's YAML until #217 moved the decision into
    // scripts/retargetRetest.js. They now mutate real code, and the guards that
    // catch them assert the status ACTUALLY WRITTEN rather than which strings sit
    // near which line — which is what let the previous defects keep moving one
    // indent level out of reach.
    {
        id: "205-no-retest-trigger", ticket: "#205",
        desc: "the close/reopen that re-triggers CI is removed, so a retargeted PR keeps main's check",
        file: "scripts/retargetRetest.js",
        anchor: "        gh(['pr', 'close', String(pr), '--repo', repo]);",
        mutant: "        void 0;",
        tests: 'retargetRetest'
    },
    {
        id: "205-failsafe-order-inverted", ticket: "#205",
        desc: "the red status is no longer posted before the close, so a crash mid-way leaves a stale green showing",
        file: "scripts/retargetRetest.js",
        anchor: "    postStatus('failure',\n        'Base moved to development; awaiting a re-run. '\n        + 'The existing check was computed against main.');\n",
        mutant: "",
        tests: 'retargetRetest'
    },
    {
        id: "205-closed-pr-exits-green", ticket: "#205",
        desc: "a PR left closed after a failed reopen no longer fails the job, so a security PR can be silently abandoned",
        file: "scripts/retargetRetest.js",
        anchor: "            closed: true,\n            reopened: false,\n            failed: true,",
        mutant: "            closed: true,\n            reopened: false,\n            failed: false,",
        tests: 'retargetRetest'
    },
    {
        id: "210-status-cleared-without-evidence", ticket: "#210",
        desc: "the decision ignores what was observed, so green is posted on a successful reopen alone",
        file: "scripts/retargetRetest.js",
        anchor: "    const decision = decideOutcome({ snapshotOk, newRunFound });",
        mutant: "    const decision = decideOutcome({ snapshotOk: true, newRunFound: true });",
        tests: 'retargetRetest'
    },
    {
        id: "210-existence-not-freshness", ticket: "#210",
        desc: "any run on the head SHA counts as evidence, including the PR's original main-based run",
        file: "scripts/retargetRetest.js",
        anchor: "            if (latest !== null && latest > runsBefore) {",
        mutant: "            if (latest !== null && latest > 0) {",
        tests: 'retargetRetest'
    },
    {
        id: "210-snapshot-fails-open", ticket: "#210",
        desc: "an unusable run snapshot defaults to 0 instead of failing closed",
        file: "scripts/retargetRetest.js",
        anchor: "    if (!Array.isArray(parsed)) return null;",
        mutant: "    if (!Array.isArray(parsed)) return 0;",
        tests: 'retargetRetest'
    },
    {
        id: "210-any-workflow-counts", ticket: "#210",
        desc: "the run query drops its ci-cd.yml scope, so a CodeQL run passes for a skipped suite",
        file: "scripts/retargetRetest.js",
        anchor: "                '--workflow', CI_WORKFLOW, '--limit', '100', '--json', 'databaseId']));",
        mutant: "                '--limit', '100', '--json', 'databaseId']));",
        tests: 'retargetRetest'
    },
    {
        id: "210-unverified-reported-as-conflict", ticket: "#210",
        desc: "a failed snapshot is reported as 'no run appeared' rather than 'could not verify'",
        file: "scripts/retargetRetest.js",
        anchor: "    if (!snapshotOk) {\n        return {\n            outcome: OUTCOME.UNVERIFIED,",
        mutant: "    if (false) {\n        return {\n            outcome: OUTCOME.UNVERIFIED,",
        tests: 'retargetRetest'
    },
    {
        id: "216-no-run-posts-success", ticket: "#216",
        desc: "the no-run outcome is written as a GREEN status",
        file: "scripts/retargetRetest.js",
        anchor: "        outcome: OUTCOME.NO_RUN,\n        state: 'failure',",
        mutant: "        outcome: OUTCOME.NO_RUN,\n        state: 'success',",
        tests: 'retargetRetest'
    },
    {
        id: "216-unverified-posts-success", ticket: "#216",
        desc: "the could-not-verify outcome is written as a GREEN status",
        file: "scripts/retargetRetest.js",
        anchor: "            // diagnosing it would be right half the time.\n            state: 'failure',",
        mutant: "            // diagnosing it would be right half the time.\n            state: 'success',",
        tests: 'retargetRetest'
    },
    {
        id: "216-decision-not-written", ticket: "#216",
        desc: "the decision is computed but never written, so the PR keeps whatever status it had",
        file: "scripts/retargetRetest.js",
        anchor: "    postStatus(decision.state, decision.description);",
        mutant: "    void decision;",
        tests: 'retargetRetest'
    },
    {
        id: "216-unverified-names-a-cause", ticket: "#216",
        desc: "the could-not-verify note diagnoses an API failure, which is right only half the time",
        file: "scripts/retargetRetest.js",
        anchor: "+ '**could not verify** whether a run started \u2014 the run snapshot was unusable, '",
        mutant: "+ '**could not verify** whether a run started \u2014 the GitHub API call failed, '",
        tests: 'retargetRetest'
    },

    {
        id: '217-annotations-on-stdout', ticket: '#217',
        desc: 'annotations go to stdout, which the workflow captures as the PR comment body — losing them from the log and pasting them publicly',
        file: 'scripts/retargetRetest.js',
        anchor: "    log = console.error,",
        mutant: "    log = console.log,",
        tests: 'retargetRetest'
    },

    // ---- #245: trust proxy was never applied ---------------------------------
    {
        id: '245-trust-proxy-ignored', ticket: '#245',
        desc: 'healthCheck.trustProxy is accepted but never set, so clients behind a proxy share one rate-limit bucket',
        file: 'src/services/healthCheck.js',
        anchor: "      this.app.set('trust proxy', options.trustProxy);",
        mutant: '      // trust proxy not applied',
        tests: 'healthCheck'
    },

    // ---- #266: timezone hardcoded to Europe/Madrid ---------------------------
    {
        id: '266-timezone-config-ignored', ticket: '#266',
        desc: 'the configured timezone is ignored and the process zone is always used',
        file: 'src/lib/timezone.js',
        anchor: "    if (cfg && cfg.timezone) return cfg.timezone;",
        mutant: "    if (cfg && false) return cfg.timezone;",
        tests: 'timezone'
    },
    {
        id: '266-timezone-process-zone-unvalidated', ticket: '#266',
        desc: 'a blank or invalid process TZ is returned unvalidated instead of falling back to UTC',
        file: 'src/lib/timezone.js',
        anchor: "    return isValidTimezone(processZone) ? processZone : 'UTC';",
        mutant: "    return processZone;",
        tests: 'timezone'
    },
    {
        id: '266-timezone-unvalidated', ticket: '#266',
        desc: 'an unknown timezone name passes config validation',
        file: 'src/lib/configLoader.js',
        anchor: "if (config.timezone !== undefined && !isValidTimezone(config.timezone)) {",
        mutant: "if (false) {",
        tests: 'timezone'
    },
    {
        id: '266-telegram-timezone-fixed', ticket: '#266',
        desc: 'Telegram replies ignore the configured timezone',
        file: 'src/services/telegramBot.js',
        anchor: "    return resolveTimezone(this.config);",
        mutant: "    return 'UTC';",
        tests: 'telegramBot'
    },

    // ---- #273: auto-retry never fired because syncBank never rejected --------
    {
        id: '273-sync-result-not-returned', ticket: '#273',
        desc: 'runSyncBank swallows its outcome again (returns undefined), so the retry policy never sees a failure',
        file: 'src/syncService.js',
        anchor: "    return { status: syncOutcome };",
        mutant: "    return undefined;",
        tests: 'autoRetry'
    },
    {
        id: '273-failure-status-ignored', ticket: '#273',
        desc: 'the retry policy no longer treats a returned failure status as a failure',
        file: 'src/lib/autoRetry.js',
        anchor: "failed = result?.status === 'failure';",
        mutant: "failed = false;",
        tests: 'autoRetry'
    },
    {
        id: '273-sigterm-not-registered', ticket: '#273',
        desc: 'the SIGTERM handler is no longer registered, so docker stop kills a running sync',
        file: 'src/syncService.js',
        anchor: "process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));",
        mutant: "// SIGTERM handler removed",
        tests: 'autoRetry'
    },
    {
        id: '273-shutdown-gate-open', ticket: '#273',
        desc: 'shutdown no longer closes the gate, so syncs queued after the signal still start',
        file: 'src/lib/shutdownGate.js',
        anchor: "        closed = true;",
        mutant: "        closed = false;",
        tests: 'shutdownGate'
    },

    // ---- #278: trustProxy shape bypassed validation in non-strict mode -------
    {
        id: '278-trust-proxy-shape-unchecked', ticket: '#278',
        desc: 'a non-integer or object trustProxy passes logic validation, so CONFIG_STRICT=false lets 1.5 trust 2 hops',
        file: 'src/lib/configLoader.js',
        anchor: "        if (!trustProxyShapeOk) {",
        mutant: "        if (false && !trustProxyShapeOk) {",
        tests: 'configLoader'
    },

    // ---- #248: trivy-action ran from a floating branch ----------------------
    {
        id: '248-trivy-floating-branch', ticket: '#248',
        desc: 'the Trivy image scan runs aquasecurity/trivy-action@master again',
        file: '.github/workflows/ci-cd.yml',
        anchor: '      - name: Run Trivy vulnerability scanner\n        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25  # v0.36.0',
        mutant: '      - name: Run Trivy vulnerability scanner\n        uses: aquasecurity/trivy-action@master',
        tests: 'workflowPins'
    },

    // ---- #265: syncs share one Actual API session ---------------------------
    {
        id: '265-sync-bypasses-queue', ticket: '#265',
        desc: 'syncBank calls runSyncBank directly, so two syncs can run at once again',
        file: 'src/syncService.js',
        anchor: '    return shutdownGate.run(server.name, () => runSyncBank(server, options));',
        mutant: '    return runSyncBank(server, options);',
        tests: 'syncQueue'
    },

    // ---- #264: Dismiss read a field that does not exist -----------------------
    {
        id: '264-dismiss-wrong-field', ticket: '#264',
        desc: 'dismiss-error reads this.serverStatuses (undefined) again, so every dismiss is a 500',
        file: 'src/services/healthCheck.js',
        anchor: '        const serverStatuses = this.status.serverStatuses;',
        mutant: '        const serverStatuses = this.serverStatuses;',
        tests: 'healthCheck'
    },

    // ---- #263: e2e harness seams and the string-error dashboard bug ---------
    {
        id: '263-port-zero-ignored', ticket: '#263',
        desc: 'port 0 falls back to 3000 again, so the e2e fixtures can no longer get an OS-assigned free port',
        file: 'src/services/healthCheck.js',
        anchor: 'this.port = options.port ?? 3000;',
        mutant: 'this.port = options.port || 3000;',
        tests: 'healthCheckPort'
    },
    {
        id: '263-now-ignored', ticket: '#263',
        desc: 'the injected clock is ignored, so status.startTime always reads the real clock again',
        file: 'src/services/healthCheck.js',
        anchor: "this.now = options.now || (() => new Date());",
        mutant: 'this.now = () => new Date();',
        tests: 'healthCheckPort'
    },
    {
        id: '263-rate-limit-max-ignored', ticket: '#263',
        desc: 'the rate limiter goes back to a hardcoded 60, so the e2e fixtures cannot drive more requests than that',
        file: 'src/services/healthCheck.js',
        anchor: 'max: this.rateLimitMax, // requests per minute per IP (60 unless a test overrides it)',
        mutant: 'max: 60, // requests per minute per IP',
        tests: 'healthCheckPort'
    },
    {
        id: '263-sync-error-string-dropped', ticket: '#263',
        desc: 'updateSyncStatus reads only error.message again, so a plain string error becomes "Unknown error"',
        file: 'src/services/healthCheck.js',
        anchor: "    const errorText = typeof syncResult.error === 'string'\n      ? syncResult.error\n      : syncResult.error?.message;",
        mutant: '    const errorText = syncResult.error?.message;',
        tests: 'healthCheck'
    },
    {
        id: '263-synchistory-now-ignored', ticket: '#263',
        desc: 'SyncHistoryService ignores the injected clock, so recorded timestamps and day-window queries use the real clock again',
        file: 'src/services/syncHistory.js',
        anchor: 'this.now = options.now || (() => new Date());',
        mutant: 'this.now = () => new Date();',
        tests: 'syncHistory'
    },

    // ---- #272: a hung Actual API call blocked the queue forever ------------------
    {
        id: '272-download-unbounded', ticket: '#272',
        desc: 'downloadBudget is called without a timer, so a server that never answers hangs the queue again',
        file: 'src/lib/actualTimeouts.js',
        anchor: '        wrapped[method] = (...args) => withTimeout(',
        mutant: "        wrapped[method] = method === 'downloadBudget' ? (...args) => api[method](...args) : (...args) => withTimeout(",
        tests: 'actualTimeouts'
    },
    {
        id: '272-timeout-retried', ticket: '#272',
        desc: 'a download timeout falls into the retry path, doubling the hang and clearing the cache',
        file: 'src/syncService.js',
        anchor: '            if (error instanceof PhaseTimeoutError) throw error;',
        mutant: '',
        tests: 'syncQueue'
    },
    {
        id: '272-running-never-cleared', ticket: '#272',
        desc: 'the queue keeps reporting a finished sync as running',
        file: 'src/lib/syncQueue.js',
        anchor: '                if (this.active === entry) this.active = null;',
        mutant: '',
        tests: 'syncQueue'
    },
    {
        id: '272-status-hides-running', ticket: '#272',
        desc: 'the dashboard status stops naming the sync holding the queue',
        file: 'src/services/healthCheck.js',
        anchor: '        runningSync: this.safeRunningSync(),',
        mutant: '        runningSync: null,',
        tests: 'healthCheck'
    },
    {
        id: '272-retry-swallows-timeout', ticket: '#272',
        desc: 'a timed-out retry download is treated as a corrupt cache and retried again',
        file: 'src/syncService.js',
        anchor: '                if (err instanceof PhaseTimeoutError) throw err; // same reason as above (#272)',
        mutant: '',
        tests: 'syncQueue'
    },
    {
        id: '272-entry-swallows-timeout', ticket: '#272',
        desc: 'a loadBudget timeout is skipped as "not a budget directory"',
        file: 'src/syncService.js',
        anchor: '                    if (entryErr instanceof PhaseTimeoutError) throw entryErr;',
        mutant: '',
        tests: 'syncQueue'
    },
    {
        id: '272-workaround-swallows-timeout', ticket: '#272',
        desc: 'the loadBudget workaround carries on with no budget after a timeout',
        file: 'src/syncService.js',
        anchor: '            if (loadErr instanceof PhaseTimeoutError) throw loadErr;',
        mutant: '',
        tests: 'syncQueue'
    },
    {
        id: '272-late-call-untracked', ticket: '#272',
        desc: 'a timed-out call is forgotten, so it can land inside the next sync',
        file: 'src/lib/actualTimeouts.js',
        anchor: '            if (lateCalls) lateCalls.add(call, { phase });',
        mutant: '',
        tests: 'actualTimeouts'
    },
    {
        id: '272-no-busy-check', ticket: '#272',
        desc: 'a sync opens the session while an earlier late call still runs',
        file: 'src/syncService.js',
        anchor: '        if (!prepared.ok) {',
        mutant: '        if (false) {',
        tests: 'syncQueue'
    },
    {
        id: '272-shutdown-unguarded', ticket: '#272',
        desc: 'a sync refused as busy still shuts down the session the late call is using',
        file: 'src/syncService.js',
        anchor: '        if (sessionOpened) {',
        mutant: '        if (true) {',
        tests: 'syncQueue'
    },
    {
        id: '272-never-abandoned', ticket: '#272',
        desc: 'a call that never settles blocks every later sync until restart',
        file: 'src/lib/actualTimeouts.js',
        anchor: '    return { ok: false, abandoned: lateCalls.abandon() };',
        mutant: '    return { ok: false, abandoned: lateCalls.size };',
        tests: 'actualTimeouts'
    },
    {
        id: '272-abandon-keeps-calls', ticket: '#272',
        desc: 'abandon reports the calls dropped but keeps tracking them',
        file: 'src/lib/actualTimeouts.js',
        anchor: '        this.pending.clear();',
        mutant: '',
        tests: 'actualTimeouts'
    },

    // ---- #284: hung-call hardening follow-ups --------------------------------------
    {
        id: '284-drain-leaks-waiter', ticket: '#284',
        desc: 'a drain that gives up stays registered as a waiter',
        file: 'src/lib/actualTimeouts.js',
        anchor: '        this.waiters.delete(wake);',
        mutant: '',
        tests: 'actualTimeouts'
    },
    {
        id: '284-no-settle-log', ticket: '#284',
        desc: 'a late call settling is not logged',
        file: 'src/lib/actualTimeouts.js',
        anchor: '            this.logSettled(meta, outcome, Date.now() - addedAt);',
        mutant: '',
        tests: 'actualTimeouts'
    },
    {
        id: '284-account-drain-skipped', ticket: '#284',
        desc: 'the account loop starts the next account while a timed-out bank sync still runs',
        file: 'src/syncService.js',
        anchor: 'sessionStuck = !(await lateActualCalls.drain(phaseTimeoutMs));',
        mutant: 'sessionStuck = false;',
        tests: 'syncQueue'
    },
    {
        id: '284-stuck-loop-continues', ticket: '#284',
        desc: 'the account loop carries on after a bank sync that never settles',
        file: 'src/syncService.js',
        anchor: '                if (sessionStuck) {',
        mutant: '                if (false) {',
        tests: 'syncQueue'
    },
    {
        id: '284-final-sync-overlaps', ticket: '#284',
        desc: 'a stuck bank sync no longer skips the final file sync and schedule alerts, so they overlap it',
        file: 'src/syncService.js',
        anchor: '        if (sessionStuckAfterLoop) {',
        mutant: '        if (false) {',
        tests: 'syncQueue'
    },
    {
        id: '284-late-success-lost', ticket: '#284',
        desc: 'a bank sync that succeeds during the drain is still reported failed',
        file: 'src/syncService.js',
        anchor: "if (!sessionStuck && lateBankSync === 'ok') {",
        mutant: 'if (false) {',
        tests: 'syncQueue'
    },
    {
        id: '284-late-success-double-counted', ticket: '#284',
        desc: 'a bank sync that succeeds during the drain is counted succeeded and then also failed',
        file: 'src/syncService.js',
        anchor: "                                accountName: account.name\n                            });\n                            continue;\n                        }\n                        // It finished during the drain and failed",
        mutant: "                                accountName: account.name\n                            });\n                        }\n                        // It finished during the drain and failed",
        tests: 'syncLateBankSync'
    },
    {
        id: '284-stuck-final-sync-runs', ticket: '#284',
        desc: 'the final file sync runs even when a bank sync is stuck (the else branch is always taken)',
        file: 'src/syncService.js',
        anchor: "        } else {\n            serverLogger.info('Starting final file sync');",
        mutant: "        } {\n            serverLogger.info('Starting final file sync');",
        tests: 'syncLateBankSync'
    },
    {
        id: '284-late-failure-masked', ticket: '#284',
        desc: 'a late bank sync failure is reported with the timeout message, so a late "No new transactions" is a failure',
        file: 'src/syncService.js',
        anchor: "failure = lateBankError;",
        mutant: "failure = bankSyncError;",
        tests: 'syncLateBankSync'
    },
    {
        id: '284-running-sync-not-rendered', ticket: '#284',
        desc: 'the dashboard never shows the sync holding the queue',
        file: 'src/services/dashboard.js',
        anchor: '        if (runningSyncEl) runningSyncEl.textContent = formatRunningSync(data.runningSync);',
        mutant: '',
        tests: 'dashboard'
    },
    {
        id: '284-running-sync-blank', ticket: '#284',
        desc: 'the running-sync text is always empty',
        file: 'src/services/dashboard.js',
        anchor: '    return `Syncing: ${running.key}${since}`;',
        mutant: "    return '';",
        tests: 'dashboard'
    },

    // ---- #242: /ws/logs streamed to anyone ----------------------------------
    {
        id: '242-ws-no-verify', ticket: '#242',
        desc: 'the /ws/logs server is built without verifyClient, so any client gets the log stream',
        file: 'src/services/healthCheck.js',
        anchor: '          perMessageDeflate: false,\n          verifyClient: (info, done) => this.verifyWsClient(info, done)',
        mutant: '          perMessageDeflate: false',
        tests: 'healthCheck'
    },
    {
        id: '242-ws-origin-unchecked', ticket: '#242',
        desc: 'the handshake skips the Origin check, reopening Cross-Site WebSocket Hijacking',
        file: 'src/services/healthCheck.js',
        anchor: "    if (info.origin && !this.isAllowedOrigin(info.origin, req.headers.host)) {",
        mutant: "    if (false) {",
        tests: 'healthCheck'
    },
    {
        id: '242-ws-ticket-reusable', ticket: '#242',
        desc: 'a consumed ticket stays valid, so a leaked ticket URL grants the stream forever',
        file: 'src/lib/dashboardCredentials.js',
        anchor: '    this.tickets.delete(ticket);\n    return this.now() <= expiry;',
        mutant: '    return this.now() <= expiry;',
        tests: 'dashboardCredentials'
    },
    {
        id: '280-ws-ticket-spent-late', ticket: '#280',
        desc: 'the handshake only looks the ticket up instead of spending it first, so a refused handshake leaves it valid',
        file: 'src/services/healthCheck.js',
        anchor: '      ticketOk = Boolean(ticket) && this.wsTickets.consume(ticket);',
        mutant: '      ticketOk = Boolean(ticket) && this.wsTickets.tickets.has(ticket);',
        tests: 'healthCheck'
    },
    {
        id: '280-ws-cap-ignores-trustproxy', ticket: '#280',
        desc: 'the per-address cap uses the TCP peer address and ignores healthCheck.trustProxy',
        file: 'src/services/healthCheck.js',
        anchor: '    return probe.ip || req.socket.remoteAddress;',
        mutant: '    return req.socket.remoteAddress;',
        tests: 'healthCheck'
    },
    {
        id: '280-ws-origin-ignores-port', ticket: '#280',
        desc: 'same-origin compares hostname only, so a different port on the same host passes',
        file: 'src/services/healthCheck.js',
        anchor: '    if (host && parsed.host === host) return true;',
        mutant: "    if (host && parsed.hostname === host.split(':')[0]) return true;",
        tests: 'healthCheck'
    },
    {
        id: '280-stale-socket-close-reschedules', ticket: '#280',
        desc: 'a replaced socket closing late still schedules a retry, orphaning the live socket',
        file: 'src/services/dashboard.js',
        anchor: '        sock.onclose = () => {\n            if (sock !== ws) return;\n',
        mutant: '        sock.onclose = () => {\n',
        tests: 'dashboard'
    },
    {
        id: '280-ws-connect-guard-removed', ticket: '#280',
        desc: 'connectWebSocket no longer returns when a socket is open or connecting, so a late retry orphans a socket',
        file: 'src/services/dashboard.js',
        anchor: '    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;\n',
        mutant: '',
        tests: 'dashboard'
    },
    {
        id: '280-ws-pong-clock-not-reset', ticket: '#280',
        desc: 'a new socket keeps the stale lastPingTime, so after one keep-alive timeout every socket closes at its first tick',
        file: 'src/services/dashboard.js',
        anchor: '            lastPingTime = Date.now();\n            addLogEntry',
        mutant: '            addLogEntry',
        tests: 'dashboard'
    },
    {
        id: '246-basic-auth-short-circuits', ticket: '#246',
        desc: 'a wrong username skips the password comparison, a timing signal for valid usernames',
        file: 'src/lib/dashboardCredentials.js',
        anchor: '    const passOk = safeEqual(password, authConfig.password);',
        mutant: '    const passOk = userOk && safeEqual(password, authConfig.password);',
        tests: 'dashboardCredentials'
    },
    {
        id: '281-basic-auth-splits-every-colon', ticket: '#281',
        desc: 'the password is cut at its first colon, so a password containing one never logs in',
        file: 'src/lib/dashboardCredentials.js',
        anchor: '    const password = sep === -1 ? undefined : credentials.slice(sep + 1);',
        mutant: "    const password = sep === -1 ? undefined : credentials.slice(sep + 1).split(':')[0];",
        tests: 'dashboardCredentials'
    },

    {
        id: '242-ws-header-oracle', ticket: '#242',
        desc: 'the handshake accepts an Authorization header again, an unthrottled password oracle',
        file: 'src/services/healthCheck.js',
        anchor: '    if (ticketOk) return done(true);\n',
        mutant: '    if (ticketOk) return done(true);\n    if (checkCredentials(req.headers, authConfig).ok) return done(true);\n',
        tests: 'healthCheck'
    },
    {
        id: '242-missing-token-matches-empty', ticket: '#242',
        desc: 'a missing configured token lets an empty Bearer header in',
        file: 'src/lib/dashboardCredentials.js',
        anchor: "    if (!isSet(authConfig.token)) return { ok: false, reason: 'config' };\n",
        mutant: '',
        tests: 'dashboardCredentials'
    },

    {
        id: '246-token-failure-uncounted', ticket: '#246',
        desc: 'wrong tokens no longer count, so brute force is unthrottled',
        file: 'src/services/healthCheck.js',
        anchor: "    res.locals.authFailed = true;\n    this.logger.warn(`${realm} token authentication failed`, {",
        mutant: "    this.logger.warn(`${realm} token authentication failed`, {",
        tests: 'healthCheck'
    },
    {
        id: '246-basic-failure-uncounted', ticket: '#246',
        desc: 'wrong basic credentials no longer count',
        file: 'src/services/healthCheck.js',
        anchor: '      res.locals.authFailed = true;',
        mutant: '',
        tests: 'healthCheck'
    },
    {
        id: '246-success-counts', ticket: '#246',
        desc: 'every request counts, so an operator with the right password is locked out',
        file: 'src/services/healthCheck.js',
        anchor: '        if (res.locals.authFailed) failures.increment(key);',
        mutant: '        failures.increment(key);',
        tests: 'healthCheck'
    },
    {
        id: '246-throttle-bypassed', ticket: '#246',
        desc: 'the failure count is never checked, so guessing is unthrottled',
        file: 'src/services/healthCheck.js',
        anchor: '        if (seen && seen.resetTime > Date.now() && seen.totalHits >= this.authFailureLimit) {',
        mutant: '        if (false) {',
        tests: 'healthCheck'
    },

    {
        id: '246-expired-window-still-locks', ticket: '#246',
        desc: 'an ended window keeps locking the client out until the sweep',
        file: 'src/services/healthCheck.js',
        anchor: '        if (seen && seen.resetTime > Date.now() && seen.totalHits >= this.authFailureLimit) {',
        mutant: '        if (seen && seen.totalHits >= this.authFailureLimit) {',
        tests: 'healthCheck'
    },
    {
        id: '246-await-between-check-and-count', ticket: '#246',
        desc: 'an await between reading the count and adding a failure lets pipelined guesses through',
        file: 'src/services/healthCheck.js',
        anchor: "    const middleware = (req, res, next) => {\n      const authConfig = getAuthConfig();\n      const authType = authConfig.type || 'none';\n      if (authType === 'none') return next();\n\n      try {\n        const key = ipKeyGenerator(req.ip || '');\n        const seen = failures.get(key);\n",
        mutant: "    const middleware = async (req, res, next) => {\n      const authConfig = getAuthConfig();\n      const authType = authConfig.type || 'none';\n      if (authType === 'none') return next();\n\n      try {\n        const key = ipKeyGenerator(req.ip || '');\n        const seen = failures.get(key);\n        await new Promise((resolve) => setImmediate(resolve));\n",
        tests: 'healthCheck'
    },

    {
        id: '286-none-auth-throttled', ticket: '#286',
        desc: 'auth type none goes through the failure throttle, so a client with recorded failures is refused',
        file: 'src/services/healthCheck.js',
        anchor: "      if (authType === 'none') return next();\n\n      try {",
        mutant: '      try {',
        tests: 'healthCheck'
    },
    {
        id: '286-username-logged', ticket: '#286',
        desc: 'a failed basic login logs the typed username again, which may be a pasted password',
        file: 'src/services/healthCheck.js',
        anchor: "      this.logger.warn(`${realm} authentication failed`, {\n        remoteAddress",
        mutant: "      this.logger.warn(`${realm} authentication failed`, {\n        username: Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString('utf8'),\n        remoteAddress",
        tests: 'healthCheck'
    },

    {
        id: '247-prometheus-unguarded', ticket: '#247',
        desc: '/metrics/prometheus ignores healthCheck.auth',
        file: 'src/services/healthCheck.js',
        anchor: "this.app.get('/metrics/prometheus', this.metricsAuth(), async (req, res) => {",
        mutant: "this.app.get('/metrics/prometheus', async (req, res) => {",
        tests: 'healthCheck'
    },
    {
        id: '247-metrics-unguarded', ticket: '#247',
        desc: '/metrics ignores healthCheck.auth',
        file: 'src/services/healthCheck.js',
        anchor: "this.app.get('/metrics', this.metricsAuth(), (req, res) => {",
        mutant: "this.app.get('/metrics', (req, res) => {",
        tests: 'healthCheck'
    },
    {
        id: '247-metrics-reads-dashboard-auth', ticket: '#247',
        desc: 'the metrics endpoints accept the dashboard login instead of the scrape credential (the #241 coupling)',
        file: 'src/services/healthCheck.js',
        anchor: "return this.makeAuthMiddleware('metricsAuth', () => this.metricsAuthConfig || {},",
        mutant: "return this.makeAuthMiddleware('metricsAuth', () => this.dashboardConfig.auth || {},",
        tests: 'healthCheck'
    },
    {
        id: '247-metrics-gated-on-dashboard-enabled', ticket: '#247',
        desc: 'switching the dashboard off answers 403 to Prometheus',
        file: 'src/services/healthCheck.js',
        anchor: "    const middleware = (req, res, next) => {\n      const authConfig = getAuthConfig();",
        mutant: "    const middleware = (req, res, next) => {\n      if (!this.dashboardConfig.enabled) return res.status(403).json({ error: 'Dashboard is disabled' });\n      const authConfig = getAuthConfig();",
        tests: 'healthCheck'
    },
    {
        id: '247-shared-failure-counter', ticket: '#247',
        desc: 'wrong scrape tokens count against the dashboard login throttle',
        file: 'src/services/healthCheck.js',
        anchor: "      'Metrics', this.metricsAuthFailures);",
        mutant: "      'Metrics', this.authFailures || (this.authFailures = new AuthFailureCounter(this.authFailureWindowMs)));",
        tests: 'healthCheck'
    },
    {
        id: '247-half-set-credential-starts', ticket: '#247',
        desc: 'healthCheck.auth.type token with no token starts the service',
        file: 'src/lib/configLoader.js',
        anchor: "            const missing = needed.filter((key) => !isSet(key));",
        mutant: "            const missing = [];",
        tests: 'configLoader'
    },
    {
        id: '286-xff-warning-every-request', ticket: '#286',
        desc: 'the X-Forwarded-For misconfiguration warning repeats on every request',
        file: 'src/services/healthCheck.js',
        anchor: '          warned = true;\n',
        mutant: '',
        tests: 'healthCheck'
    },
    {
        id: '286-xff-warning-never', ticket: '#286',
        desc: 'no warning when requests carry X-Forwarded-For and trustProxy is off',
        file: 'src/services/healthCheck.js',
        anchor: "if (!warned && req.headers['x-forwarded-for']) {",
        mutant: 'if (false) {',
        tests: 'healthCheck'
    },
    {
        id: '286-sweeper-not-cleared', ticket: '#286',
        desc: 'shutdown() leaves the failure sweep timer running',
        file: 'src/services/healthCheck.js',
        anchor: '    if (this.sweeper) clearInterval(this.sweeper);\n',
        mutant: '',
        tests: 'healthCheck'
    },
    {
        id: '286-stop-keeps-sweeper', ticket: '#286',
        desc: 'stop() no longer shuts the failure counter down',
        file: 'src/services/healthCheck.js',
        anchor: '    if (this.authFailures) this.authFailures.shutdown();\n',
        mutant: '',
        tests: 'healthCheck'
    },

    {
        id: '263-metrics-echoes-error', ticket: '#263',
        desc: 'the unauthenticated /metrics shows the sync error text',
        file: 'src/services/healthCheck.js',
        anchor: "          .map(([name, { error, ...rest }]) => [name, rest])),",
        mutant: "          .map(([name, entry]) => [name, entry])),",
        tests: 'healthCheck'
    },

    // ---- #257: message template layer -----------------------------------
    {
        id: '257-lookup-allowed', ticket: '#257',
        desc: 'lookup becomes an allowed helper, defeating the security boundary',
        file: 'src/lib/templateRenderer.js',
        anchor: "const KNOWN_HELPERS = new Set(['eq', 'default', 'upper', 'lower']);",
        mutant: "const KNOWN_HELPERS = new Set(['eq', 'default', 'upper', 'lower', 'lookup']);",
        tests: 'templateRenderer'
    },
    {
        id: '257-false-branch-not-checked', ticket: '#257',
        desc: 'an unknown name inside a false #if branch no longer fails validation',
        file: 'src/lib/templateRenderer.js',
        anchor: '        walkProgram(statement.inverse, scopeVars);',
        mutant: '',
        tests: 'templateRenderer'
    },
    {
        id: '257-telegram-bare-ampersand-allowed', ticket: '#257',
        desc: 'a bare & in template literal text no longer fails Telegram markup validation',
        file: 'src/lib/templateRenderer.js',
        anchor: "      fail(key, '&', line, 'telegram_markup');",
        mutant: '',
        tests: 'templateRenderer'
    },
    {
        id: '257-telegram-not-html-escaped', ticket: '#257',
        desc: 'Telegram output stops HTML-escaping values, so a payee value can break message structure',
        file: 'src/lib/templateRenderer.js',
        anchor: "  telegram: { noEscape: false, postProcess: (text) => truncateTelegramHtml(text) },",
        mutant: "  telegram: { noEscape: true, postProcess: (text) => truncateTelegramHtml(text) },",
        tests: 'templateRenderer'
    },
    {
        id: '257-slack-not-escaped', ticket: '#257',
        desc: 'Slack output stops escaping the whole rendered string, so a payee value can inject markup',
        file: 'src/lib/templateRenderer.js',
        anchor: "  slack: { noEscape: true, postProcess: escapeSlack },",
        mutant: '  slack: { noEscape: true },',
        tests: 'templateRenderer'
    },
    {
        id: '257-telegram-truncate-ignores-closing-cost', ticket: '#257',
        desc: 'Telegram truncation forgets to budget for closing tags, so the result can exceed the length limit',
        file: 'src/lib/channelEscape.js',
        anchor: '    if (output.length + token.raw.length + closingSuffix.length > max) break;',
        mutant: '    if (output.length + token.raw.length > max) break;',
        tests: 'channelEscape'
    },
    {
        id: '257-webhook-statuscode-not-set', ticket: '#257',
        desc: 'a rejected webhook error no longer carries statusCode, so the Telegram 400 retry can never fire',
        file: 'src/services/notificationService.js',
        anchor: '            error.statusCode = res.statusCode;',
        mutant: '',
        tests: 'templatedDelivery'
    },
    {
        id: '257-telegram-message-always-true', ticket: '#257',
        desc: 'sendTelegramMessage reports success even when Telegram never accepted the message',
        file: 'src/services/notificationService.js',
        anchor: '    return (await this.sendTelegramMessageDetailed(message, options)).ok;',
        mutant: '    return true;',
        tests: 'notificationService'
    },
    {
        id: '257-telegram-base-url-ignores-test-seam', ticket: '#257',
        desc: 'the constructor stops honoring telegramApiBaseUrl, so tests can no longer reach a fake Telegram server',
        file: 'src/services/notificationService.js',
        anchor: "    this.telegramApiBaseUrl = options.telegramApiBaseUrl || 'https://api.telegram.org';",
        mutant: "    this.telegramApiBaseUrl = 'https://api.telegram.org';",
        tests: 'templatedDelivery'
    },
    {
        id: '257-telegram-retry-not-limited-to-400', ticket: '#257',
        desc: 'the Telegram retry fires on every failure, not only a 400, silently doubling every non-400 failure',
        file: 'src/services/notificationService.js',
        anchor: '    if (result.ok || result.statusCode !== 400) {',
        mutant: '    if (result.ok) {',
        tests: 'templatedDelivery'
    },
    {
        id: '257-review-data-var-whitelist-bypassed', ticket: '#257',
        desc: 'any @data path (including @root, the whole render context) is allowed again, bypassing the variable whitelist',
        file: 'src/lib/templateRenderer.js',
        anchor: '      if (node.parts.length === 1 && ALLOWED_DATA_VARS.has(node.parts[0])) return;',
        mutant: '      return;',
        tests: 'templateRenderer'
    },
    {
        id: '257-review-dotted-path-bypassed', ticket: '#257',
        desc: 'a dotted path off a non-block-param variable, or through a dangerous prototype-chain property, is allowed again',
        file: 'src/lib/templateRenderer.js',
        anchor: '      if (!isBlockParam || hasDangerousPart) {',
        mutant: '      if (false) {',
        tests: 'templateRenderer'
    },

    // ---- #258: missing-payment alerts ------------------------------------
    {
        id: '258-interval-violation-boundary-off-by-one', ticket: '#258',
        desc: 'the #271 item 1 window-overlap guard uses > instead of >=, so an exact-equal grace+early no longer trips it',
        file: 'src/lib/scheduleAlerts.js',
        // #297 round 1, M2: effectiveEarlyDays includes the linked allowance
        // again, but only while the interval exceeds it (daily stays valid).
        anchor: '      if (shortestIntervalDays !== null && binding.graceDays + effectiveEarlyDays >= shortestIntervalDays) {',
        mutant: '      if (shortestIntervalDays !== null && binding.graceDays + effectiveEarlyDays > shortestIntervalDays) {',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-amount-tolerance-boundary-off-by-one', ticket: '#258',
        desc: 'an amount exactly at the tolerance boundary is no longer accepted, narrowing the allowed range',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '  return Math.abs(Math.abs(amount) - Math.abs(expected)) <= allowed;',
        mutant: '  return Math.abs(Math.abs(amount) - Math.abs(expected)) < allowed;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-staleness-check-disabled', ticket: '#258',
        desc: 'a stale bank connection is never detected, so a merely-unsynced account is reported missing instead of cannotCheck',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '      const stale = !lastSync || today.diff(lastSync, \'days\') > binding.staleAfterDays;',
        mutant: '      const stale = false;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-schedule-link-ignored', ticket: '#258',
        desc: "Actual's own transaction-to-schedule link is ignored, falling back to account+payee matching even when linked",
        file: 'src/lib/scheduleAlerts.js',
        anchor: '    const linked = !!schedule.id && tx.schedule === schedule.id;',
        mutant: '    const linked = false;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-duplicate-alert-id-not-rejected', ticket: '#258',
        desc: 'checkUniqueIds no longer throws on a duplicate alert id, silently allowing two rules to collide',
        file: 'src/lib/scheduleAlertRules.js',
        anchor: '      if (seen.has(id)) {',
        mutant: '      if (false) {',
        tests: 'scheduleAlertRules'
    },
    {
        id: '258-unmatched-rule-not-flagged', ticket: '#258',
        desc: 'a rule matching no schedule silently expands to zero bindings instead of one unmatched binding, so no ruleUnmatched event fires',
        file: 'src/lib/scheduleAlertRules.js',
        anchor: '    if (matches.length === 0) {',
        mutant: '    if (false) {',
        tests: 'scheduleAlertRules'
    },
    {
        id: '258-reminder-interval-not-enforced', ticket: '#258',
        desc: 'a missing-payment reminder resends on every sync instead of waiting remindEveryDays, spamming every channel',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: 'due: calendarDaysBetween(now, latest.recordedAt, timezone) >= remindEveryDays,',
        mutant: 'due: true,',
        tests: 'scheduleAlertDelivery'
    },
    // '258-ruleUnmatched-reminder-uses-configured-interval' was removed: since
    // #356, ruleUnmatched returns early in the dueness check, so a mutant on
    // the reminder line below it is unreachable and always survives.
    // '356-ruleUnmatched-repeats' guards that once-per-destination rule.
    {
        id: '258-disabled-webhook-not-skipped', ticket: '#258',
        desc: 'a generic webhook with enabled:false is sent to anyway, since the enabled check is dropped from resolveTargets',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "      return (cfg.webhooks?.generic || []).filter((w) => w.enabled !== false && w.url);",
        mutant: "      return (cfg.webhooks?.generic || []).filter((w) => w.url);",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '258-sent-skipped-swapped', ticket: '#258',
        desc: 'runScheduleAlertsStep swaps sent and skipped in its return value, so syncService would log an inverted count',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '    return { events: events.length, sent: deliverResult.sent, skipped: deliverResult.skipped };',
        mutant: '    return { events: events.length, sent: deliverResult.skipped, skipped: deliverResult.sent };',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '258-ledger-null-key-matching-broken', ticket: '#258',
        desc: 'the schedule_alerts ledger lookup uses = instead of IS for nullable key columns, so a NULL scheduleId/occurrenceDate never matches itself',
        file: 'src/services/syncHistory.js',
        anchor: '          AND schedule_id IS ? AND occurrence_date IS ? AND event = ?',
        mutant: '          AND schedule_id = ? AND occurrence_date = ? AND event = ?',
        tests: 'syncHistory'
    },
    {
        id: '258-ledger-retention-floor-dropped', ticket: '#258',
        desc: 'the schedule_alerts ledger loses its 120-day retention floor, so a low sync-history retentionDays purges alert history too early',
        file: 'src/services/syncHistory.js',
        anchor: '      const scheduleAlertsRetentionDays = Math.max(this.retentionDays, 120);',
        mutant: '      const scheduleAlertsRetentionDays = this.retentionDays;',
        tests: 'syncHistory'
    },
    {
        id: '258-weekend-skip-mode-inverted', ticket: '#258',
        desc: 'a "before" weekend solve mode rolls a Saturday to Monday instead of back to Friday (the before/after branches are swapped)',
        file: 'src/lib/vendor/actualSchedules.js',
        anchor: "    if (solveMode === 'after') {\n      return d.nextMonday(date);\n    } else if (solveMode === 'before') {\n      return d.previousFriday(date);\n    }",
        mutant: "    if (solveMode === 'after') {\n      return d.previousFriday(date);\n    } else if (solveMode === 'before') {\n      return d.nextMonday(date);\n    }",
        tests: 'actualSchedules.vendor'
    },

    // ---- #258 additional guards from PR #295 review round 1 ----------------
    {
        id: '258-h1-last-sync-epoch-ms-not-parsed', ticket: '#258',
        desc: 'account.last_sync (a production epoch-ms string) is parsed with plain moment.tz instead of as a number, so missing never fires in production',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "  const parsed = isNumeric ? moment.tz(Number(lastSync), timezone) : moment.tz(lastSync, timezone);",
        mutant: "  const parsed = moment.tz(lastSync, timezone);",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-h2-binding-isolation-removed', ticket: '#258',
        desc: 'one schedule that throws during evaluation is no longer isolated, so it aborts evaluate() and silences every other rule',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '    } catch (error) {',
        mutant: '    } catch (error) { throw error;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-h2-cadence-date-format-missing', ticket: '#258',
        desc: 'getRecurringDescription is called with no date-fns format again, throwing for an on_date endMode schedule',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "\n        cadenceText: typeof dateConfig === 'string' ? null : getRecurringDescription(dateConfig, CADENCE_DATE_FORMAT),",
        mutant: "\n        cadenceText: typeof dateConfig === 'string' ? null : getRecurringDescription(dateConfig),",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-h3-lookback-ignores-early-days', ticket: '#258',
        desc: "the transaction fetch window is sized off MAX_LOOKBACK_DAYS alone again, so an early payment near the boundary can fall outside the query",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "        .subtract(MAX_LOOKBACK_DAYS + maxEarlyDays, 'days')",
        mutant: "        .subtract(MAX_LOOKBACK_DAYS, 'days')",
        tests: 'scheduleAlertsSync'
    },
    {
        id: '258-h4-completed-schedule-not-skipped', ticket: '#258',
        desc: 'a completed schedule is matched again, so it keeps producing false "missing" events for an occurrence nobody expects anymore',
        file: 'src/lib/scheduleAlertRules.js',
        anchor: '    const isActive = (s) => s.completed !== true;',
        mutant: '    const isActive = (s) => true;',
        tests: 'scheduleAlertRules'
    },
    {
        id: '258-h5-destination-key-ignores-target', ticket: '#258',
        desc: 'the per-destination ledger key collapses back to the channel name alone, so a dead multi-target destination (e.g. one of two webhooks) blocks resending to the other',
        file: 'src/lib/scheduleAlertDelivery.js',
        // #295 review round 2, M8 moved the key computation into destinationKey()
        // (never storing the raw webhook URL); this anchor was retargeted to the
        // new call site, since the old inline ternary no longer appears in the file.
        anchor: '      destinations.push({ channel, target, key: destinationKey(channel, target) });',
        mutant: '      destinations.push({ channel, target, key: channel });',
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '258-h6-template-not-validated-at-startup', ticket: '#258',
        desc: 'a rule\'s merged template is no longer compiled at config-load time, so a bad template only fails at send time',
        // R2-M7 rewrote the compiled channel set from a fixed allModes to the
        // rule's own resolved modes; retargeted to the call itself, which is
        // unaffected by which channel list it is passed (#258 review round 2).
        file: 'src/lib/configLoader.js',
        anchor: "                if (result.code === 'invalid_template') {",
        mutant: '                if (false) {',
        tests: 'configLoader'
    },
    {
        id: '258-m1-digest-ignores-rule-channel-restriction', ticket: '#258',
        desc: "digest mode groups by every channel again instead of each item's own resolveChannels, leaking a channel-restricted rule's content onto channels it never allowed",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: '    for (const channel of resolveChannels(item.rule, sender)) {',
        mutant: '    for (const channel of ALL_CHANNELS) {',
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '258-m2-unreachable-channels-not-rejected-at-startup', ticket: '#258',
        desc: "a rule whose explicit channels restriction names no configured destination is no longer rejected at startup",
        // R2-M7 hoisted resolveChannels(rule, sender) into a ruleChannels
        // local (reused for the per-rule template modes too); retargeted to
        // that same guard, now read from ruleChannels (#258 review round 2).
        file: 'src/lib/configLoader.js',
        anchor: "                if (result.code === 'no_configured_destination') {",
        mutant: '                if (false) {',
        tests: 'configLoader'
    },
    {
        id: '258-m4-transactions-query-explodes-splits', ticket: '#258',
        desc: "the transactions query requests splits: 'inline' again, exploding a split parent into subtransactions that lose the schedule link",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "            .options({ splits: 'none' })",
        mutant: "            .options({ splits: 'inline' })",
        tests: 'scheduleAlertsSync'
    },
    {
        id: '258-m7-calendar-days-uses-raw-24h-periods', ticket: '#258',
        desc: 'calendarDaysBetween goes back to raw 24h-period diffing instead of calendar-day comparison in the configured timezone, letting a reminder skip or double-fire near a day boundary',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  return moment.tz(now, timezone).startOf('day').diff(moment.tz(recordedAt, timezone).startOf('day'), 'days');",
        mutant: '  return moment(now).diff(moment(recordedAt), \'days\');',
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '258-m9-skip-next-date-not-honored', ticket: '#258',
        desc: "an occurrence Actual's \"Skip next date\" already moved past is reported missing again instead of skipped",
        file: 'src/lib/scheduleAlerts.js',
        anchor: '      const nextDateMoment = schedule.next_date ? moment.tz(schedule.next_date, timezone).startOf(\'day\') : null;',
        mutant: '      const nextDateMoment = null;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-m10-isbetween-range-check-removed', ticket: '#258',
        desc: "an isbetween schedule's amount range check always passes, so wrongAmount can never fire for it",
        file: 'src/lib/scheduleAlerts.js',
        anchor: '    return amount >= lo && amount <= hi;',
        mutant: '    return true;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-m11-pass1-ignores-link-and-amount-preference', ticket: '#258',
        desc: 'on-time matching goes back to taking the earliest in-window candidate regardless of link/amount, reintroducing false wrongAmount',
        file: 'src/lib/scheduleAlerts.js',
        // #295 review round 2, M1/M3 reworked this block (betterMatchedElsewhere,
        // strictLinked/closestLinked); this anchor was retargeted to the current
        // preference chain, since the old text no longer appears in the file.
        anchor: "        const candidate = strictLinked\n          || (linkedBeatsAmount ? closestLinked : null)\n          || amountMatch\n          || closestLinked\n          // Wrong-amount fallback (M11): only take a candidate that is not a\n          // better, correctly-amounted match for some OTHER bound schedule\n          // (#295 review round 2, M1).\n          || inWindow.find((c) => !betterMatchedElsewhere(c.tx, schedule, tolerancePct, bindings))\n          || null;",
        mutant: '        const candidate = inWindow[0] || null;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-m12-linked-early-window-not-widened', ticket: '#258',
        desc: "a linked transaction's early window goes back to the rule's own (possibly narrower) earlyDays instead of Actual's +/-2 day linking tolerance",
        file: 'src/lib/scheduleAlerts.js',
        anchor: "        let earlyStartLinked = day.clone().subtract(Math.max(binding.earlyDays, LINKED_EARLY_WINDOW_DAYS), 'days');",
        mutant: '        let earlyStartLinked = earlyStart;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-m1-linked-allowance-beats-in-window-amount-match', ticket: '#297',
        desc: "the 2-day linked allowance wins over an in-window exact-amount payment again, so a late linked payment for the previous occurrence steals this one's payment",
        file: 'src/lib/scheduleAlerts.js',
        anchor: '        const linkedBeatsAmount = closestLinked && (!amountMatch || fitsSiblingSchedule(amountMatch.tx, schedule, bindings));',
        mutant: '        const linkedBeatsAmount = closestLinked;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-m2-linked-allowance-ignored-by-overlap-guard', ticket: '#297',
        desc: 'the overlap guard ignores the linked early allowance again, so weekly graceDays 5 is evaluated and its window swallows the next occurrence\'s early linked payment',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '      const effectiveEarlyDays = linkedOverlap ? Math.max(binding.earlyDays, LINKED_EARLY_WINDOW_DAYS) : binding.earlyDays;',
        mutant: '      const effectiveEarlyDays = binding.earlyDays;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-f4-linked-allowance-rejects-short-intervals', ticket: '#297',
        desc: 'the linked allowance applies to every interval again, so every daily schedule is a permanent interval violation',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '      const linkedOverlap = shortestIntervalDays !== null && shortestIntervalDays > LINKED_EARLY_WINDOW_DAYS',
        mutant: '      const linkedOverlap = shortestIntervalDays !== null && shortestIntervalDays > 0',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-l1-ledger-lookup-failure-rejects-batch', ticket: '#297',
        desc: "a failing ledger lookup rejects the whole deliver() batch again instead of withholding only that event",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "      log.warn('Schedule alert ledger lookup failed; event withheld until the next sync', {",
        mutant: "      throw error;\n      log.warn('Schedule alert ledger lookup failed; event withheld until the next sync', {",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '297-l1-resolved-lookup-failure-rejects-batch', ticket: '#297',
        desc: "a failing ledger lookup while deriving resolved events rejects the whole deliver() batch again",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "        logger.warn('Schedule alert ledger lookup failed; resolved check withheld until the next sync', {",
        mutant: "        throw error;\n        logger.warn('Schedule alert ledger lookup failed; resolved check withheld until the next sync', {",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '297-f4-linked-early-not-clamped-to-previous-deadline', ticket: '#297',
        desc: "a linked payment's early window is no longer clamped to start after the previous occurrence's deadline, so a payment inside the previous grace is pulled onto the next occurrence",
        file: 'src/lib/scheduleAlerts.js',
        anchor: "          if (earlyStartLinked.isBefore(afterPrevDeadline, 'day')) earlyStartLinked = afterPrevDeadline;",
        mutant: '          void afterPrevDeadline;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-m13-lookback-fallback-too-short', ticket: '#258',
        desc: "the interval-stats fallback goes back to a hard-coded 30 days for a schedule with fewer than two occurrences in range, undersizing the window for a yearly schedule",
        file: 'src/lib/scheduleAlerts.js',
        anchor: '  return { shortestIntervalDays: shortest, longestIntervalDays: longest || MAX_LOOKBACK_DAYS };',
        mutant: '  return { shortestIntervalDays: shortest, longestIntervalDays: longest || 30 };',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-r2-h1-shared-pool-claim-ignores-schedule', ticket: '#258',
        desc: 'the shared transaction pool goes back to a plain used-set, so a second rule bound to the same schedule cannot reuse a transaction the first rule already claimed for that SAME schedule, reporting every occurrence missing',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '        .filter((c) => c.match.eligible && (!globallyUsedTx.has(c.tx) || globallyUsedTx.get(c.tx) === schedule.id))',
        mutant: '        .filter((c) => c.match.eligible && !globallyUsedTx.has(c.tx))',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-r2-h2-skip-inference-ignores-intervening-linked-payment', ticket: '#258',
        desc: 'next_date-based skip inference goes back to firing on ANY occurrence before next_date, even when a later linked payment (not an explicit skip) is what advanced next_date, hiding a genuinely missed payment',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '          if (!hasInterveningLinkedPayment) {',
        mutant: '          if (true) {',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-r2-m1-pass2-late-fallback-ignores-sibling-match', ticket: '#258',
        desc: 'the pass-2 late fallback goes back to taking any unlinked candidate in window, even one that is a better, correctly-amounted match for a sibling schedule on the same account+payee',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '            && (c.linked || !betterMatchedElsewhere(c.tx, schedule, tolerancePct, bindings))',
        mutant: '            && true',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-r2-m2-completed-only-match-fires-rule-unmatched', ticket: '#258',
        desc: 'a rule whose name matched only completed schedules goes back to producing an unmatched: true binding (and a daily ruleUnmatched) instead of no binding at all',
        file: 'src/lib/scheduleAlertRules.js',
        anchor: "      if (rawMatches.length === 0) {\n        bindings.push({ ...rule, scheduleId: null, scheduleName: null, schedule: null, unmatched: true });\n      }",
        mutant: '        bindings.push({ ...rule, scheduleId: null, scheduleName: null, schedule: null, unmatched: true });',
        tests: 'scheduleAlertRules.test'
    },
    {
        id: '258-r2-m5-resolved-resent-after-already-resolved-here', ticket: '#258',
        desc: 'a resolved event goes back to being resendable to a destination that already has its own resolved row recorded, resending indefinitely instead of once per destination',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: 'due: !resolvedRow ||',
        mutant: 'due: true ||',
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '258-r2-m6-deadline-not-enforced-per-destination', ticket: '#258',
        desc: 'sendEvent goes back to never checking the delivery deadline between destinations, so a short budget no longer stops a new destination send from starting',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: '      if (deadline != null && Date.now() >= deadline) {',
        mutant: '      if (false) {',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '258-r2-m8-destination-key-stores-raw-url', ticket: '#258',
        desc: 'destinationKey goes back to embedding the raw webhook URL (a secret) in the ledger key instead of a short hash, for a destination with no configured name',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  const hash = crypto.createHash('sha256').update(target.url).digest('hex').slice(0, 8);",
        mutant: '  const hash = target.url;',
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '258-r2-m9-legacy-null-channel-row-not-matched', ticket: '#258',
        desc: 'a channel-scoped ledger lookup goes back to an exact-match-only filter, so a legacy pre-H5 row (recorded before the channel column existed, and therefore NULL) is invisible to a lookup for any specific destination key, defeating dedup for upgraded installs',
        file: 'src/services/syncHistory.js',
        // #297 F7 limited the NULL wildcard to delivered rows; this anchor was
        // retargeted to the current text.
        anchor: "          ${filterChannel ? \"AND (channel IS ? OR (channel IS NULL AND delivery = 'sent'))\" : ''}",
        mutant: "          ${filterChannel ? 'AND channel IS ?' : ''}",
        tests: 'syncHistory.test'
    },
    {
        id: '258-r2-m7-startup-template-check-ignores-rule-channels', ticket: '#258',
        desc: 'startup template validation goes back to compiling every rule against every channel mode, so a Telegram-only literal-markup restriction rejects a valid template for a rule that can only ever reach slack/email',
        file: 'src/lib/scheduleAlertValidation.js',
        // #262 review F1 split this into `requested` plus a save-mode branch.
        anchor: "  const channels = schemaOnly || dashboard ? requested : resolved;",
        mutant: "  const channels = ALL_CHANNELS;",
        tests: 'scheduleAlertValidation'
    },

    // ---- #294: template low findings -----------------------------------------
    {
        id: "294-decorator-passes-validation", ticket: '#294',
        desc: "a decorator ({{*foo}}) passes validation again and throws at render",
        file: "src/lib/templateRenderer.js",
        anchor: "        fail(key, statement.path && statement.path.original || 'decorator', statement.loc.start.line, 'unknown_helper');",
        mutant: "",
        tests: "templateRenderer"
    },
    {
        id: "294-mismatched-block-line-lost", ticket: '#294',
        desc: "a mismatched block error reports line 1 again",
        file: "src/lib/templateRenderer.js",
        anchor: " || / - (\\d+):\\d+/.exec(err.message);",
        mutant: ";",
        tests: "templateRenderer"
    },
    {
        id: "294-telegram-any-entity-allowed", ticket: '#294',
        desc: "Telegram validation accepts entities Telegram rejects (&nbsp;)",
        file: "src/lib/templateRenderer.js",
        anchor: "const TELEGRAM_ENTITY_RE = /^&(?:amp|lt|gt|quot);/;",
        mutant: "const TELEGRAM_ENTITY_RE = /^&(?:amp|lt|gt|quot|nbsp);/;",
        tests: "templateRenderer"
    },
    {
        id: "294-telegram-entity-rejected", ticket: '#294',
        desc: "the Telegram entities are rejected again, so a literal & cannot be written",
        file: "src/lib/templateRenderer.js",
        anchor: "      if (entity) {",
        mutant: "      if (false) {",
        tests: "templateRenderer"
    },
    {
        id: "294-telegram-unclosed-tag-passes", ticket: '#294',
        desc: "an unclosed Telegram tag passes validation again",
        file: "src/lib/templateRenderer.js",
        anchor: "    if (tagStack.length > 0) {",
        mutant: "    if (false) {",
        tests: "templateRenderer"
    },
    {
        id: "294-telegram-crossed-tags-pass", ticket: '#294',
        desc: "crossed Telegram tags pass validation again",
        file: "src/lib/templateRenderer.js",
        anchor: "if (!open || open.tag !== tag) fail(",
        mutant: "if (!open) fail(",
        tests: "templateRenderer"
    },
    {
        id: "294-upper-undefined-renders-word", ticket: '#294',
        desc: "upper of an undefined value renders UNDEFINED again",
        file: "src/lib/templateRenderer.js",
        anchor: "  upper: (value) => (value == null ? '' : String(value).toUpperCase()),",
        mutant: "  upper: (value) => String(value).toUpperCase(),",
        tests: "templateRenderer"
    },
    {
        id: "294-lower-undefined-renders-word", ticket: '#294',
        desc: "lower of a null value renders NULL again",
        file: "src/lib/templateRenderer.js",
        anchor: "  lower: (value) => (value == null ? '' : String(value).toLowerCase())",
        mutant: "  lower: (value) => String(value).toLowerCase()",
        tests: "templateRenderer"
    },
    {
        id: "294-webhook-field-overrides-text", ticket: '#294',
        desc: "a webhook field named text overrides the rendered text again",
        file: "src/services/notificationService.js",
        anchor: "{ ...(fields || {}), text }",
        mutant: "{ text, ...(fields || {}) }",
        tests: "templatedDelivery"
    },
    {
        id: "294-discord-content-uncapped", ticket: '#294',
        desc: "templated Discord content is no longer capped at 2000 characters",
        file: "src/services/notificationService.js",
        anchor: "content: truncateWithEllipsis(text, DISCORD_CONTENT_MAX)",
        mutant: "content: text",
        tests: "templatedDelivery"
    },
    {
        id: "294-slack-text-uncapped", ticket: '#294',
        desc: "templated Slack text is no longer capped",
        file: "src/services/notificationService.js",
        anchor: "{ text: truncateWithEllipsis(text, SLACK_TEXT_MAX) }",
        mutant: "{ text }",
        tests: "templatedDelivery"
    },
    {
        id: "294-ellipsis-exceeds-cap", ticket: '#294',
        desc: "the ellipsis is added on top of the cap, so Discord content ends up 2001 characters",
        file: "src/lib/channelEscape.js",
        anchor: "truncateCodePoints(value, max - 1)",
        mutant: "truncateCodePoints(value, max)",
        tests: "channelEscape"
    },
    {
        id: "294-discord-mentions-allowed", ticket: '#294',
        desc: "non-templated Discord payloads allow mentions again (@everyone pings)",
        file: "src/services/notificationService.js",
        anchor: "if (payload) payload.allowed_mentions = { parse: [] };",
        mutant: "if (payload) payload.allowed_mentions = { parse: ['everyone'] };",
        tests: "notificationService.test"
    },
    {
        id: "294-discord-formatted-mentions-missing", ticket: '#294',
        desc: "the formatted Discord sender stops suppressing mentions",
        file: "src/services/notificationService.js",
        anchor: "(#114)\n    this._suppressDiscordMentions(payload);",
        mutant: "(#114)",
        tests: "notificationService.test"
    },
    {
        id: "294-discord-legacy-mentions-missing", ticket: '#294',
        desc: "the dashboard-test Discord sender stops suppressing mentions",
        file: "src/services/notificationService.js",
        anchor: "this._brandPayload(payload, 'avatar_url');\n    this._suppressDiscordMentions(payload);",
        mutant: "this._brandPayload(payload, 'avatar_url');",
        tests: "notificationService.test"
    },
    {
        id: "294-digest-records-deferred-items", ticket: '#294',
        desc: "a capped digest records every rendered item as sent, including the ones cut off by the channel cap",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "const included = rendered.slice(0, count).map((r) => r.item);",
        mutant: "const included = rendered.map((r) => r.item);",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "294-digest-no-fair-order", ticket: '#294',
        desc: "the digest no longer sends never-sent and longest-waiting items first, so daily reminders starve the deferred tail",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "return x === y ? 0 : (x < y ? -1 : 1);",
        mutant: "return 0;",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "294-telegram-digest-header-unescaped", ticket: '#294',
        desc: "the Telegram digest header interpolates the server name into HTML unescaped again",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "for ${escapeTelegramHtml(server)}`",
        mutant: "for ${server}`",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "294-email-digest-header-unescaped", ticket: '#294',
        desc: "the email digest html body interpolates the server name unescaped again",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "html: `<p>${htmlHeader}</p><ul>",
        mutant: "html: `<p>${header}</p><ul>",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "294-slack-digest-header-unescaped", ticket: '#294',
        desc: "the Slack digest header carries the raw server name again, so <!channel> in a name pings the channel",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "return buildDigestOutput(channel, channel === 'slack' ? slackHeader : header,",
        mutant: "return buildDigestOutput(channel, header,",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "294-digest-reminders-not-oldest-first", ticket: '#294',
        desc: "already-sent digest items no longer rotate by oldest last send, so the first items take every reminder slot",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "const sentAtMs = (d) => (d.lastSentAt == null ? -Infinity : Date.parse(d.lastSentAt));",
        mutant: "const sentAtMs = (d) => (d.lastSentAt == null ? -Infinity : 0);",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "294-digest-ignores-cap", ticket: '#294',
        desc: "the digest no longer stops adding items at the channel cap, so Discord gets a message cut at 2000",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "digestLength(channel, build(count + 1)) <= cap",
        mutant: "digestLength(channel, build(count + 1)) <= Infinity",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "294-slack-cap-4000", ticket: '#294',
        desc: "the Slack cap goes back to 4000, cutting a 40-item digest short",
        file: "src/lib/channelEscape.js",
        anchor: "const SLACK_TEXT_MAX = 40000;",
        mutant: "const SLACK_TEXT_MAX = 4000;",
        tests: "templatedDelivery"
    },
    {
        id: "294-markup-line-from-stripped-value", ticket: '#294',
        desc: "the Telegram markup check counts lines in the whitespace-stripped value again, so the line after a standalone block tag is wrong",
        file: "src/lib/templateRenderer.js",
        anchor: "const text = node.original;",
        mutant: "const text = node.value;",
        tests: "templateRenderer"
    },
    {
        id: "294-ellipsis-splits-surrogate", ticket: '#294',
        desc: "truncateWithEllipsis cuts by UTF-16 unit and can leave a lone surrogate",
        file: "src/lib/channelEscape.js",
        anchor: "${truncateCodePoints(value, max - 1)}",
        mutant: "${value.slice(0, max - 1)}",
        tests: "channelEscape"
    },


    // ---- #297: findings left open when the #258 review loop stopped -------
    {
        id: '297-f1-remembered-skip-ignored', ticket: '#297',
        desc: 'a remembered skip decision is no longer honoured, so January (skipped, then February paid and linked) is reported missing once next_date has moved past it',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '        if (rememberedSkips.has(skipKey(binding.scheduleId, occurrenceKey))) {',
        mutant: '        if (false) {',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-f1-skip-decision-not-reported', ticket: '#297',
        desc: 'a first-time skip inference is no longer reported as a skipDecision, so nothing is ever written to the ledger and the skip is forgotten',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '            skipDecisions.push({ alertId: binding.id, scheduleId: binding.scheduleId, occurrence: occurrenceKey });',
        mutant: '            void occurrenceKey;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-f1-skips-not-loaded-from-ledger', ticket: '#297',
        desc: 'the sync step stops loading remembered skips from the ledger before evaluating, so a skip recorded by an earlier sync is forgotten',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '            skips = rows.map((r) => skipKey(r.scheduleId, r.occurrenceDate));',
        mutant: '            skips = [];',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '297-f1-skip-decisions-not-persisted', ticket: '#297',
        desc: 'the deliver phase stops writing newly inferred skip decisions to the ledger',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '    for (const decision of skipDecisions || []) {',
        mutant: '    for (const decision of []) {',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '297-f2-unlinked-exact-amount-beats-linked', ticket: '#297',
        desc: 'pass 1 prefers an unlinked exact-amount lookalike over a payment linked to the schedule again, so a sibling schedule on the same account+payee loses its payment and reports a false missing',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "          || (linkedBeatsAmount ? closestLinked : null)\n",
        mutant: "",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-f2b-pass2-ignores-linked-preference', ticket: '#297',
        desc: 'pass 2 takes the earliest late candidate again instead of preferring one linked to the schedule, so an earlier unlinked lookalike starves its sibling',
        file: 'src/lib/scheduleAlerts.js',
        anchor: '        const candidate = lateCandidates.find((c) => c.linked) || lateCandidates[0];',
        mutant: '        const candidate = lateCandidates[0];',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '297-f7-null-channel-wildcard-matches-any-delivery', ticket: '#297',
        desc: 'a NULL-channel ledger row of any delivery kind (muted, inferred skip) matches a lookup for a specific destination again, so it can suppress every destination',
        file: 'src/services/syncHistory.js',
        anchor: "          ${filterChannel ? \"AND (channel IS ? OR (channel IS NULL AND delivery = 'sent'))\" : ''}",
        mutant: "          ${filterChannel ? 'AND (channel IS ? OR channel IS NULL)' : ''}",
        tests: 'syncHistory.test'
    },

    {
        id: '297-f3-destination-key-collapses-duplicate-names', ticket: '#297',
        desc: 'the destination key is the webhook name alone again when one is set, so two webhooks of one channel sharing a name collapse into one ledger key and a failed one is never retried',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  return `${channel}:#${target.name || ''}:${hash}`;",
        mutant: "  return target.name ? `${channel}:#${target.name}` : `${channel}:#${hash}`;",
        tests: 'scheduleAlertDelivery'
    },
    // ---- #243: helmet security headers -------------------------------------
    {
        id: '243-frame-ancestors-allowed', ticket: '#243',
        desc: 'the CSP lets any site frame the dashboard again (clickjacking)',
        file: 'src/services/healthCheck.js',
        anchor: "          frameAncestors: [\"'none'\"]",
        mutant: "          frameAncestors: ['*']",
        tests: 'healthCheck.test'
    },
    {
        id: '243-inline-script-allowed', ticket: '#243',
        desc: 'the CSP allows inline scripts again',
        file: 'src/services/healthCheck.js',
        anchor: "          scriptSrc: [\"'self'\"],",
        mutant: "          scriptSrc: [\"'self'\", \"'unsafe-inline'\"],",
        tests: 'healthCheck.test'
    },
    {
        id: '243-hsts-include-subdomains', ticket: '#243',
        desc: 'HSTS sends includeSubDomains again, locking plain-HTTP sibling hosts out',
        file: 'src/services/healthCheck.js',
        anchor: "      strictTransportSecurity: hsts ? { maxAge: 15552000, includeSubDomains: false } : false",
        mutant: "      strictTransportSecurity: hsts ? { maxAge: 15552000 } : false",
        tests: 'healthCheck.test'
    },
    // ---- #288: the History tab server filter was ignored by the route -------
    {
        id: '288-history-server-filter-dropped', ticket: '#288',
        desc: 'the history route drops serverName again, so the server filter shows every server',
        file: 'src/services/healthCheck.js',
        anchor: "if (typeof serverName === 'string' && serverName !== '') filters.serverName = serverName;",
        mutant: "if (false) filters.serverName = serverName;",
        tests: 'healthCheck.test'
    },
    // ---- #337/#338: digest and immediate delivery starvation at the budget ---
    {
        id: '337-digest-channel-order-fixed', ticket: '#337',
        desc: 'the digest visits channels in insertion order again, so a channel that eats the whole budget starves later channels every run',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    .sort((a, b) => (attempts.get(a[0]) || 0) - (attempts.get(b[0]) || 0));",
        mutant: "    .sort(() => 0);",
        tests: 'scheduleAlertDelivery.test'
    },
    {
        id: '337-digest-attempt-not-stamped', ticket: '#337',
        desc: 'a digest send that fails is no longer stamped as attempted, so the rotation never moves off the failing channel',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    attempts.set(channel, digestAttemptSeq);",
        mutant: "",
        tests: 'scheduleAlertDelivery.test'
    },
    {
        id: '338-immediate-order-fixed', ticket: '#338',
        desc: 'immediate mode sends events in evaluation order again, so early daily reminders use the budget every run and starve the tail',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    if (x.since !== y.since) return x.since < y.since ? -1 : 1;",
        mutant: "",
        tests: 'scheduleAlertDelivery.test'
    },
    {
        id: '338-never-sent-not-first', ticket: '#338',
        desc: 'a destination that never got the event no longer sorts ahead of ones that did',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "oldest = Math.min(oldest, state.lastSentAt == null ? -Infinity : Date.parse(state.lastSentAt));",
        mutant: "oldest = Math.min(oldest, state.lastSentAt == null ? Infinity : Date.parse(state.lastSentAt));",
        tests: 'scheduleAlertDelivery.test'
    },
    {
        id: '337-immediate-destination-order-fixed', ticket: '#337',
        desc: 'immediate mode visits destinations in configured order again, so a hanging first destination starves later ones every run',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "      .sort((a, b) => (attempts.get(`dest|${a.key}`) || 0) - (attempts.get(`dest|${b.key}`) || 0));",
        mutant: "      .sort(() => 0);",
        tests: 'scheduleAlertDelivery.test'
    },
    {
        id: '337-immediate-attempt-not-stamped', ticket: '#337',
        desc: 'an immediate-mode destination send is no longer stamped as attempted, so the rotation never moves off a hanging destination',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "      attempts.set(`dest|${destination.key}`, digestAttemptSeq);",
        mutant: "",
        tests: 'scheduleAlertDelivery.test'
    },
    {
        id: '337-immediate-attempt-tiebreak-removed', ticket: '#337',
        desc: 'immediate mode no longer breaks ties by oldest attempt, so one hanging destination keeps the same alert first and the rest never start',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    if (x.attempt !== y.attempt) return x.attempt < y.attempt ? -1 : 1;",
        mutant: "",
        tests: 'scheduleAlertDelivery.test'
    },
    {
        id: '338-immediate-order-reversed', ticket: '#338',
        desc: 'immediate mode sends the most recently sent event first, so the same few reminders use the budget every day and the rest starve',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    if (x.since !== y.since) return x.since < y.since ? -1 : 1;",
        mutant: "    if (x.since !== y.since) return x.since < y.since ? 1 : -1;",
        tests: 'scheduleAlertDelivery.test'
    },
    // ---- #169: the README claim that started #168 ---------------------------
    {
        id: '169-readme-failure-only', ticket: '#169',
        desc: 'the README claims notifications fire only on failures again',
        file: 'README.md',
        anchor: '- **Notifies** you of sync results via Telegram',
        mutant: '- **Notifies** you of failures via Telegram',
        tests: 'docDriftGuards'
    },

    // ---- #260: payment alert snapshot and GET /api/dashboard/payments -----
    {
        id: '260-sync-drops-evaluation-outcome', ticket: '#260',
        desc: 'syncService stops passing the outcome object to the evaluation, so a failed evaluation leaves lastRun.ok true',
        file: 'src/syncService.js',
        anchor: "                logger: serverLogger,\n                syncHistory,\n                outcome: paymentOutcome\n",
        mutant: "                logger: serverLogger,\n                syncHistory\n",
        tests: 'syncLateBankSync'
    },
    {
        id: '260-sync-persists-when-stuck', ticket: '#260',
        desc: 'the payment snapshot is persisted even when a bank sync is stuck',
        file: 'src/syncService.js',
        anchor: '        if (sessionStuckAfterLoop) {\n            serverLogger.warn(\'Skipping the final file sync',
        mutant: '        persistPaymentSnapshot(server, null, { syncHistory, serverName: name, outcome: {}, logger: serverLogger });\n        if (sessionStuckAfterLoop) {\n            serverLogger.warn(\'Skipping the final file sync',
        tests: 'syncLateBankSync'
    },
    {
        id: '260-no-transaction', ticket: '#260',
        desc: 'replacePaymentSnapshot runs its writes without a transaction, so a mid-way failure leaves partial rows',
        file: 'src/services/syncHistory.js',
        anchor: '      const replace = this.db.transaction(() => {',
        mutant: '      const replace = ((fn) => fn)(() => {',
        tests: 'paymentSnapshot'
    },
    {
        id: '260-persist-no-synchistory-guard', ticket: '#260',
        desc: 'persistPaymentSnapshot drops its missing-syncHistory guard and logs a WARN instead of returning quietly',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '    if (!syncHistory) return;',
        mutant: '',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '260-replace-keeps-removed', ticket: '#260',
        desc: 'a pair no longer evaluated is never deleted, so a removed rule lingers on the dashboard',
        file: 'src/services/syncHistory.js',
        anchor: '          if (!keep.has(pairKey(row.alert_id, row.schedule_id))) {',
        mutant: '          if (false) {',
        tests: 'paymentSnapshot'
    },
    {
        id: '260-range-not-normalised', ticket: '#260',
        desc: 'an isbetween range is stored in config order instead of min/max',
        file: 'src/services/syncHistory.js',
        anchor: '            min = Math.min(amount.num1, amount.num2);',
        mutant: '            min = amount.num1;',
        tests: 'paymentSnapshot'
    },
    {
        id: '260-lastsent-includes-inferred', ticket: '#260',
        desc: 'lastAlertAt counts inferred skip rows as sent alerts',
        file: 'src/services/syncHistory.js',
        anchor: "        WHERE server = ? AND delivery = 'sent'",
        mutant: '        WHERE server = ?',
        tests: 'paymentSnapshot'
    },
    {
        id: '260-reset-keeps-payment-rows', ticket: '#260',
        desc: 'resetServerHistory leaves the payment snapshot rows behind',
        file: 'src/services/syncHistory.js',
        anchor: '          payment_alert_status: delPaymentItems.run(s).changes,',
        mutant: '          payment_alert_status: (void s, 0),',
        tests: 'paymentSnapshot'
    },
    {
        id: '260-failure-clears-last-success', ticket: '#260',
        desc: 'a failed run wipes last_success_at',
        file: 'src/services/syncHistory.js',
        anchor: '          evaluated_at = excluded.evaluated_at, ok = 0, error_code = excluded.error_code',
        mutant: '          evaluated_at = excluded.evaluated_at, ok = 0, error_code = excluded.error_code, last_success_at = NULL',
        tests: 'paymentSnapshot'
    },
    {
        id: '260-errored-pairs-count-interval-violation', ticket: '#260',
        desc: 'an interval-violation rule (warning plus cannotCheck evaluation) is counted as errored',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '                if (evaluatedPairs.has(key) || seen.has(key)) continue;',
        mutant: '                if (seen.has(key)) continue;',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '260-error-code-passthrough', ticket: '#260',
        desc: 'a raw error code (PHASE_TIMEOUT, ECONNRESET) is stored instead of the closed list',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "    return PAYMENT_ERROR_CODES.includes(code) ? code : 'evaluation_failed';",
        mutant: "    return code || 'evaluation_failed';",
        tests: 'scheduleAlertsSync'
    },
    {
        id: '260-block-removed-keeps-snapshot', ticket: '#260',
        desc: 'removing the scheduleAlerts block no longer erases the server snapshot',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '            syncHistory.deletePaymentSnapshot(serverName);',
        mutant: '            void serverName;',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '260-failure-overwrites-items', ticket: '#260',
        desc: 'a failed evaluation replaces the items with an empty set instead of only recording the run',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '            syncHistory.recordPaymentRunFailure(serverName, outcome.errorCode);',
        mutant: '            syncHistory.replacePaymentSnapshot(serverName, [], {});',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '260-outcome-failure-lost', ticket: '#260',
        desc: 'maybeRunScheduleAlerts no longer reports that it failed',
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: '            outcome.failed = true;',
        mutant: '            outcome.failed = false;',
        tests: 'scheduleAlertsSync'
    },
    {
        id: '260-days-late-reversed', ticket: '#260',
        desc: 'daysLate is computed with the dates swapped (negative)',
        file: 'src/services/healthCheck.js',
        anchor: '                  ? daysBetween(o.deadline, o.receivedDate)',
        mutant: '                  ? daysBetween(o.receivedDate, o.deadline)',
        tests: 'paymentsRoute'
    },
    {
        id: '260-bracket-server-accepted', ticket: '#260',
        desc: '?server[]=x and ?server[a]=b are silently ignored instead of rejected',
        file: 'src/services/healthCheck.js',
        anchor: '      if (bracketed || (requested !== undefined',
        mutant: '      if ((requested !== undefined',
        tests: 'paymentsRoute'
    },
    {
        id: '341-group-title-innerhtml', ticket: '#341',
        desc: 'server name written as HTML in the group heading',
        file: 'src/services/dashboard.js',
        anchor: "    head.appendChild(payEl('h3', 'pay-group-title', group.server));",
        mutant: "    head.innerHTML = '<h3 class=\"pay-group-title\">' + group.server + '</h3>';",
        tests: 'dashboardPayments'
    },
    {
        id: '341-name-insert-html', ticket: '#341',
        desc: 'schedule name inserted as HTML',
        file: 'src/services/dashboard.js',
        anchor: "        nameTd.appendChild(document.createTextNode(item.name || ''));",
        mutant: "        nameTd.insertAdjacentHTML('beforeend', item.name || '');",
        tests: 'dashboardPayments'
    },
    {
        id: '341-sync-arg-all', ticket: '#341',
        desc: 'Sync now button always targets all servers',
        file: 'src/services/dashboard.js',
        anchor: "    syncBtn.setAttribute('data-arg', group.server);",
        mutant: "    syncBtn.setAttribute('data-arg', 'all');",
        tests: 'dashboardPayments'
    },
    {
        id: '341-error-banner-hidden', ticket: '#341',
        desc: 'load-failure banner never shown',
        file: 'src/services/dashboard.js',
        anchor: "    errorEl.hidden = !paymentsLoadError;",
        mutant: "    errorEl.hidden = true;",
        tests: 'dashboardPayments'
    },
    {
        id: '341-poll-cap-off-by-one', ticket: '#341',
        desc: 'status poll runs one read too many',
        file: 'src/services/dashboard.js',
        anchor: 'paymentsReads < PAYMENTS_SYNC_MAX_POLLS',
        mutant: 'paymentsReads <= PAYMENTS_SYNC_MAX_POLLS',
        tests: 'dashboardPayments'
    },
    {
        id: '341-failed-read-counts', ticket: '#341',
        desc: 'a failed status read counts toward the two null reads',
        file: 'src/services/dashboard.js',
        anchor: '            paymentsNullStreak = 0; // a failed read never counts toward the two',
        mutant: '            paymentsNullStreak += 1;',
        tests: 'dashboardPayments'
    },
    {
        id: '341-one-null-enough', ticket: '#341',
        desc: 'one null status read ends the wait',
        file: 'src/services/dashboard.js',
        anchor: 'paymentsNullStreak >= 2',
        mutant: 'paymentsNullStreak >= 1',
        tests: 'dashboardPayments'
    },
    {
        id: '341-date-local-tz', ticket: '#341',
        desc: 'calendar dates formatted in the browser time zone',
        file: 'src/services/dashboard.js',
        anchor: "    const fmt = (locale, options) => date.toLocaleDateString(locale, { ...options, timeZone: 'UTC' });",
        mutant: "    const fmt = (locale, options) => date.toLocaleDateString(locale, { ...options });",
        tests: 'dashboardPayments'
    },
    {
        id: '341-interval-ignores-tab', ticket: '#341',
        desc: '60 s poll runs while another tab is active',
        file: 'src/services/dashboard.js',
        anchor: "    if (document.hidden || !paymentsTabActive()) return;",
        mutant: "    if (document.hidden) return;",
        tests: 'dashboardPayments'
    }
,
    {
        id: '341-second-status-loop', ticket: '#341',
        desc: 'every Sync now click starts its own status loop',
        file: 'src/services/dashboard.js',
        anchor: '    if (!paymentsWatching) await watchPaymentsSync();',
        mutant: '    await watchPaymentsSync();',
        tests: 'dashboardPayments'
    },
    {
        id: '341-busy-after-post', ticket: '#341',
        desc: 'the server is marked syncing only after the POST resolves (double-click sends two)',
        file: 'src/services/dashboard.js',
        anchor: '    paymentsSyncing.add(serverName);\n    renderPayments();\n    let failure',
        mutant: '    renderPayments();\n    let failure',
        tests: 'dashboardPayments'
    },
    {
        id: '341-error-rewritten', ticket: '#341',
        desc: 'the role=alert load error is rewritten on every render',
        file: 'src/services/dashboard.js',
        anchor: '    if (errorEl.textContent !== paymentsLoadError) errorEl.textContent',
        mutant: '    if (true) errorEl.textContent',
        tests: 'dashboardPayments'
    },
    {
        id: '341-loop-end-clears-pending', ticket: '#341',
        desc: 'the loop ending frees a server whose POST is still pending',
        file: 'src/services/dashboard.js',
        anchor: 'paymentsQueued.forEach((name) => paymentsSyncing.delete(name));',
        mutant: 'paymentsSyncing.clear();',
        tests: 'dashboardPayments'
    },
    {
        id: '341-late-queue-keeps-streak', ticket: '#341',
        desc: 'a late-resolving POST keeps the earlier null-read streak',
        file: 'src/services/dashboard.js',
        anchor: '    paymentsNullStreak = 0; // a job was just queued',
        mutant: '    // a job was just queued',
        tests: 'dashboardPayments'
    },
    {
        id: '341-late-queue-keeps-reads', ticket: '#341',
        desc: 'a late-queued server inherits the shared loop read count',
        file: 'src/services/dashboard.js',
        anchor: '    paymentsReads = 0;\n    if (!paymentsWatching)',
        mutant: '    if (!paymentsWatching)',
        tests: 'dashboardPayments'
    },
    {
        id: '341-live-region-rewritten', ticket: '#341',
        desc: 'the sync-start live region is rewritten on every render',
        file: 'src/services/dashboard.js',
        anchor: 'if (liveEl.textContent !== liveText) liveEl.textContent',
        mutant: 'if (true) liveEl.textContent',
        tests: 'dashboardPayments'
    },
    {
        id: "259-origin-unchecked-dismiss-error", ticket: '#259',
        desc: "the dismiss-error POST drops the Origin check, reopening cross-site request forgery",
        file: "src/services/healthCheck.js",
        anchor: "this.app.post('/api/dashboard/dismiss-error', this.dashboardAuth(), this.checkOrigin(), (req, res) =>",
        mutant: "this.app.post('/api/dashboard/dismiss-error', this.dashboardAuth(), (req, res) =>",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-origin-unchecked-sync", ticket: '#259',
        desc: "the sync POST drops the Origin check, reopening cross-site request forgery",
        file: "src/services/healthCheck.js",
        anchor: "this.app.post('/api/dashboard/sync', this.dashboardAuth(), this.checkOrigin(), async",
        mutant: "this.app.post('/api/dashboard/sync', this.dashboardAuth(), async",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-origin-unchecked-reset-history", ticket: '#259',
        desc: "the reset-history POST drops the Origin check, reopening cross-site request forgery",
        file: "src/services/healthCheck.js",
        anchor: "this.app.post('/api/dashboard/reset-history', this.dashboardAuth(), this.checkOrigin(), async",
        mutant: "this.app.post('/api/dashboard/reset-history', this.dashboardAuth(), async",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-origin-unchecked-test-notification", ticket: '#259',
        desc: "the test-notification POST drops the Origin check, reopening cross-site request forgery",
        file: "src/services/healthCheck.js",
        anchor: "this.app.post('/api/dashboard/test-notification', this.dashboardAuth(), this.checkOrigin(), async",
        mutant: "this.app.post('/api/dashboard/test-notification', this.dashboardAuth(), async",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-origin-before-auth", ticket: '#259',
        desc: "the sync POST checks Origin before authentication, leaking the origin policy to anonymous callers",
        file: "src/services/healthCheck.js",
        anchor: "this.app.post('/api/dashboard/sync', this.dashboardAuth(), this.checkOrigin(), async",
        mutant: "this.app.post('/api/dashboard/sync', this.checkOrigin(), this.dashboardAuth(), async",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-sec-fetch-accepted", ticket: '#259',
        desc: "a request with Sec-Fetch-Site but no Origin or Referer is accepted",
        file: "src/services/healthCheck.js",
        anchor: "ok = req.headers['sec-fetch-site'] === undefined;",
        mutant: "ok = true;",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-referer-ignored", ticket: '#259',
        desc: "the Referer fallback is dropped, so a header-stripped cross-site POST passes",
        file: "src/services/healthCheck.js",
        anchor: "const candidate = origin !== undefined ? origin : referer;",
        mutant: "const candidate = origin;",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-redaction-disabled", ticket: '#259',
        desc: "audit changes are stored without redaction",
        file: "src/services/syncHistory.js",
        anchor: "const text = JSON.stringify(redactValue(source, []));",
        mutant: "const text = JSON.stringify(source);",
        tests: "syncHistory"
    },
    {
        id: "259-redaction-exact-match", ticket: '#259',
        desc: "redaction only hits keys that equal a denylist word, not keys containing one",
        file: "src/services/syncHistory.js",
        anchor: "CONFIG_AUDIT_REDACT_SUBSTRINGS.some(sub => full.includes(sub))",
        mutant: "CONFIG_AUDIT_REDACT_SUBSTRINGS.some(sub => full === sub)",
        tests: "syncHistory"
    },
    {
        id: "259-audit-size-uncapped", ticket: '#259',
        desc: "an oversized audit entry is stored whole instead of truncated",
        file: "src/services/syncHistory.js",
        anchor: "if (Buffer.byteLength(text) <= CONFIG_AUDIT_MAX_BYTES) return text;",
        mutant: "return text;",
        tests: "syncHistory"
    },
    {
        id: "259-reset-server-deletes-audit", ticket: '#259',
        desc: "a per-server history reset erases the configuration audit",
        file: "src/services/syncHistory.js",
        anchor: "      // config_audit is deliberately NOT deleted (#259)",
        mutant: "      this.db.prepare('DELETE FROM config_audit').run();\n      // config_audit is deliberately NOT deleted (#259)",
        tests: "syncHistory"
    },
    {
        id: "259-reset-all-deletes-audit", ticket: '#259',
        desc: "a full history reset erases the configuration audit",
        file: "src/services/syncHistory.js",
        anchor: "      const delPaymentRun = this.db.prepare('DELETE FROM payment_alert_run');\n",
        mutant: "      const delPaymentRun = this.db.prepare('DELETE FROM payment_alert_run');\n      this.db.prepare('DELETE FROM config_audit').run();\n",
        tests: "syncHistory"
    },
    {
        id: "259-audit-never-purged", ticket: '#259',
        desc: "config_audit rows are never purged by retention",
        file: "src/services/syncHistory.js",
        anchor: "DELETE FROM config_audit WHERE at < ?",
        mutant: "DELETE FROM config_audit WHERE 0 AND at < ?",
        tests: "syncHistory"
    },
    {
        id: "259-limit-unvalidated", ticket: '#259',
        desc: "config-audit accepts any limit string",
        file: "src/services/healthCheck.js",
        anchor: "limit = typeof raw === 'string' && /^\\d{1,3}$/.test(raw) ? Number(raw) : NaN;",
        mutant: "limit = Number(raw);",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-limit-no-upper-bound", ticket: '#259',
        desc: "config-audit has no upper bound on limit",
        file: "src/services/healthCheck.js",
        anchor: "if (!(limit >= 1 && limit <= 200)) {",
        mutant: "if (!(limit >= 1)) {",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-body-cap-raised", ticket: '#259',
        desc: "the config write body cap is raised from 16kb",
        file: "src/services/healthCheck.js",
        anchor: "express.json({ limit: '16kb' })",
        mutant: "express.json({ limit: '10mb' })",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-writes-default-on", ticket: '#259',
        desc: "config writes are enabled when allowConfigWrites is unset",
        file: "src/services/healthCheck.js",
        anchor: "if (this.dashboardConfig.allowConfigWrites !== true) return 'disabled';",
        mutant: "if (this.dashboardConfig.allowConfigWrites === false) return 'disabled';",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-writes-allowed-auth-none", ticket: '#259',
        desc: "config writes are allowed while auth is none",
        file: "src/services/healthCheck.js",
        anchor: "if ((this.dashboardConfig.auth?.type || 'none') === 'none') return 'auth-none';",
        mutant: "if (false) return 'auth-none';",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-config-write-chain-no-gate", ticket: '#259',
        desc: "configWrite() omits requireConfigWrites",
        file: "src/services/healthCheck.js",
        anchor: "      this.requireConfigWrites(),\n      configBody,",
        mutant: "      configBody,",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-content-type-unchecked", ticket: '#259',
        desc: "a non-JSON config write body is no longer rejected with 415",
        file: "src/services/healthCheck.js",
        anchor: "if (!req.is('application/json')) {",
        mutant: "if (false) {",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-redact-email-auth-parent", ticket: '#259',
        desc: "audit redaction stops covering user/pass under the real notifications.email.auth path",
        file: "src/services/syncHistory.js",
        anchor: "a.includes('smtp') || a.includes('email') || a === 'auth'",
        mutant: "a.includes('smtp')",
        tests: "syncHistory"
    },
    {
        id: "259-unmapped-4xx-html", ticket: '#259',
        desc: "an unmapped 4xx body-parser error falls through to Express's HTML stack page",
        file: "src/services/healthCheck.js",
        anchor: "if (err && err.fromBodyParser && status >= 400 && status < 500 && !res.headersSent) {",
        mutant: "if (false) {",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-final-handler-leaks", ticket: '#259',
        desc: "the final error handler passes the error on, so Express renders the stack",
        file: "src/services/healthCheck.js",
        anchor: "if (res.headersSent) return next(err);\n      // A 4xx",
        mutant: "return next(err);\n      // A 4xx",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-reset-unknown-server", ticket: '#259',
        desc: "resetting an unknown server answers 200 and writes an audit row again",
        file: "src/services/healthCheck.js",
        anchor: "if (!known) {",
        mutant: "if (false) {",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-reset-server-name-uncapped", ticket: '#259',
        desc: "the reset-history server name length cap is removed",
        file: "src/services/healthCheck.js",
        anchor: "server.length > 200",
        mutant: "server.length > 2000000",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-body-error-unmarked", ticket: '#259',
        desc: "any 4xx is relabelled invalid_body, hiding a route's own 409/404",
        file: "src/services/healthCheck.js",
        anchor: "if (err && err.fromBodyParser && status >= 400",
        mutant: "if (err && status >= 400",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-final-handler-4xx-500", ticket: '#259',
        desc: "the final error handler answers a route's 4xx as 500",
        file: "src/services/healthCheck.js",
        anchor: "if (status >= 400 && status < 500) {\n        return res.status(status).json({ error: 'request_error' });",
        mutant: "if (false) {\n        return res.status(status).json({ error: 'request_error' });",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-reset-known-history-only", ticket: '#259',
        desc: "a retired server with only non-history rows is 404 again",
        file: "src/services/syncHistory.js",
        anchor: "OR EXISTS (SELECT 1 FROM account_metadata WHERE server_name = @s)",
        mutant: "OR 0",
        tests: "dashboardWriteSecurity"
    },
    {
        id: "259-reset-nonstring-server", ticket: '#259',
        desc: "a non-string server is no longer rejected with invalid_server",
        file: "src/services/healthCheck.js",
        anchor: "if (typeof server !== 'string') {",
        mutant: "if (false) {",
        tests: "dashboardWriteSecurity"
    },
    // ---- #296: low findings from the #258 review ----------------------------
    {
        id: '296-cannotcheck-one-wording-for-all-reasons', ticket: '#296',
        desc: 'interval-violation and error cannotCheck render the bank-connection text again',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  cannotCheck: '{{#if (eq reason \"interval-violation\")}}",
        mutant: "  cannotCheck: '{{#if (eq reason \"never-matches\")}}",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '296-error-reason-uses-bank-wording', ticket: '#296',
        desc: 'the error reason falls through to the bank-connection wording',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "{{else if (eq reason \"error\")}}",
        mutant: "{{else if (eq reason \"never-matches\")}}",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '296-reason-not-in-context', ticket: '#296',
        desc: 'the cannotCheck reason is no longer passed to the template',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    reason: event.reason || null,",
        mutant: "    reason: null,",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '296-refund-sign-ignored', ticket: '#296',
        desc: 'an unlinked opposite-sign refund is accepted by the wrong-amount fallback and the late pass',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "        .filter((c) => c.match.linked || signCompatible(c.tx.amount, schedule.amount))",
        mutant: "        .filter((c) => c.match.linked || signCompatible(c.tx.amount, schedule.amount) || true)",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '296-tolerance-sign-ignored', ticket: '#296',
        desc: 'amountWithinTolerance ignores the sign, so a sibling schedule of opposite sign hijacks the payment',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "  if (!signCompatible(amount, expected)) return false;",
        mutant: "  if (false) return false;",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '296-sign-zero-amount-rejects-all', ticket: '#296',
        desc: 'a zero-amount schedule drops every non-zero transaction (wrongAmount becomes missing)',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "  return bounds.some((b) => b === 0 || Math.sign(txAmount) === Math.sign(b));",
        mutant: "  return bounds.some((b) => Math.sign(txAmount) === Math.sign(b));",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '296-sign-range-unchecked', ticket: '#296',
        desc: 'a range schedule skips the sign check, so a positive refund is taken as late or wrongAmount',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "  const bounds = typeof scheduleAmount === 'object' ? [scheduleAmount.num1, scheduleAmount.num2] : [scheduleAmount];",
        mutant: "  if (typeof scheduleAmount === 'object') return true;\n  const bounds = [scheduleAmount];",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '296-sign-range-first-bound-only', ticket: '#296',
        desc: 'a range spanning zero only honours its first bound, rejecting a sign matching the other bound',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "  const bounds = typeof scheduleAmount === 'object' ? [scheduleAmount.num1, scheduleAmount.num2] : [scheduleAmount];",
        mutant: "  const bounds = typeof scheduleAmount === 'object' ? [scheduleAmount.num1] : [scheduleAmount];",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '296-never-synced-wording', ticket: '#296',
        desc: 'a never-synced account renders "has not synced since  (deadline" with an empty date',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "{{#if last_sync}}has not synced since {{last_sync}}{{else}}has never synced{{/if}}",
        mutant: "has not synced since {{last_sync}}",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '296-redelivery-after-restart', ticket: '#296',
        desc: 'a sent missing alert is considered due again (no de-duplication across syncs and restarts)',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  if (!latest) return { due: true, lastSentAt: null };\n  // #261: held back by a mute.",
        mutant: "  if (!latest || true) return { due: true, lastSentAt: null };\n  // #261: held back by a mute.",
        tests: 'scheduleAlertsSync'
    },
    {
        id: '296-resolved-sent-every-sync', ticket: '#296',
        desc: 'a resolved alert is not de-duplicated, so it repeats on every later sync',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    return { due: !resolvedRow || resolvedRow.recordedAt < missingRow.recordedAt, lastSentAt: null };",
        mutant: "    return { due: true, lastSentAt: null };",
        tests: 'scheduleAlertsSync'
    },
    {
        id: '296-never-synced-account-reports-missing', ticket: '#296',
        desc: 'an account with no last_sync is treated as synced, so a missing payment is reported',
        file: 'src/lib/scheduleAlerts.js',
        anchor: "const stale = !lastSync || today.diff(lastSync, 'days') > binding.staleAfterDays;\n        const lastSyncAfterDeadline = lastSync && lastSync.isAfter(occ.deadline, 'day');",
        mutant: "const stale = lastSync ? today.diff(lastSync, 'days') > binding.staleAfterDays : false;\n        const lastSyncAfterDeadline = !lastSync || lastSync.isAfter(occ.deadline, 'day');",
        tests: 'scheduleAlerts.test'
    },
    {
        id: '332-digest-lookup-failure-rejects-batch', ticket: '#332',
        desc: "a failing per-destination ledger read in digest mode rejects the whole deliver() batch again instead of withholding only that channel",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "      logger.warn('Schedule alert ledger lookup failed; destination withheld until the next sync', {",
        mutant: "      throw error;\n      logger.warn('Schedule alert ledger lookup failed; destination withheld until the next sync', {",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '332-digest-lookup-failure-sends-anyway', ticket: '#332',
        desc: "a failing digest ledger read no longer skips the channel, so the loop carries on with nothing due or a stale state",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "        server, channel, error: error.message\n      });\n      continue;\n    }\n    if (dueItems.length === 0) continue;",
        mutant: "        server, channel, error: error.message\n      });\n    }\n    if (dueItems.length === 0) continue;",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '332-digest-record-failure-rejects-batch', ticket: '#332',
        desc: "a failing ledger write after a successful digest send rejects deliver() again and stops the remaining channels",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "      } catch (error) {\n        logger.warn('Schedule alert ledger write failed after a successful send; the row may be resent next sync', {",
        mutant: "      } catch (error) {\n        throw error;\n        logger.warn('Schedule alert ledger write failed after a successful send; the row may be resent next sync', {",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '332-digest-unrecorded-item-counted-sent', ticket: '#332',
        desc: "an item whose ledger write failed is still reported as sent",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "        sentKeys.add(eventKey(item.event));\n      } catch (error) {",
        mutant: "        sentKeys.add(eventKey(item.event));\n      } catch (error) {\n        sentKeys.add(eventKey(item.event));",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '332-digest-write-failure-stops-channel-items', ticket: '#332',
        desc: "a ledger write failure in digest mode stops recording the remaining items on the same channel",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "the row may be resent next sync', {\n          server, alertId: item.event.alertId, event: item.event.event, channel, error: error.message\n        });\n      }",
        mutant: "the row may be resent next sync', {\n          server, alertId: item.event.alertId, event: item.event.event, channel, error: error.message\n        });\n        break;\n      }",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '332-immediate-write-failure-aborts-destinations', ticket: '#332',
        desc: "a ledger write failure after a successful immediate send goes to the outer catch again and stops the remaining destinations",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "          logger.warn('Schedule alert ledger write failed after a successful send; the row may be resent next sync', {\n            server, alertId: event.alertId, event: event.event, channel: destination.channel",
        mutant: "          throw error;\n          logger.warn('Schedule alert ledger write failed after a successful send; the row may be resent next sync', {\n            server, alertId: event.alertId, event: event.event, channel: destination.channel",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '332-immediate-unrecorded-destination-counted-sent', ticket: '#332',
        desc: "an immediate destination whose ledger write failed still makes the event count as sent",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "          sentAny = true;\n        } catch (error) {",
        mutant: "          sentAny = true;\n        } catch (error) {\n          sentAny = true;",
        tests: 'scheduleAlertDelivery'
    },
    {
        id: "261-summary-bounded-by-mute-end", ticket: '#261',
        desc: "the mute summary only covers rows recorded before the end of the mute day",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "const mutedRows = history.listMutedRows({ server, alertId, since: override.mutedFrom || undefined });",
        mutant: "const mutedRows = history.listMutedRows({ server, alertId, since: override.mutedFrom || undefined, until: muteEndsAt(override.mutedUntil, timezone) });",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "261-reason-only-unvalidated", ticket: '#261',
        desc: "a reason-only PUT skips the trim, required and length check",
        file: "src/services/healthCheck.js",
        anchor: "if (typeof body.reason === 'string' && !('mutedUntil' in body) && before && before.mutedUntil) {",
        mutant: "if (false) {",
        tests: "paymentOverrides"
    },
    {
        id: "261-reason-checked-unmuted", ticket: '#261',
        desc: "a reason-only check also rejects a request on an alert that is not muted",
        file: "src/services/healthCheck.js",
        anchor: "if (typeof body.reason === 'string' && !('mutedUntil' in body) && before && before.mutedUntil) {",
        mutant: "if (typeof body.reason === 'string' && body.mutedUntil !== null) {",
        tests: "paymentOverrides"
    },
    {
        id: "261-noop-change-logged", ticket: '#261',
        desc: "a no-op override change still logs 'Configuration change recorded'",
        file: "src/services/syncHistory.js",
        anchor: "if (audited) this.logger.info('Configuration change recorded'",
        mutant: "if (true) this.logger.info('Configuration change recorded'",
        tests: "paymentOverrides"
    },
    {
        id: "261-override-change-not-atomic", ticket: '#261',
        desc: "the override change and its audit row run outside one transaction",
        file: "src/services/syncHistory.js",
        anchor: "    const apply = this.db.transaction(() => {\n      if (dropMutedRows)",
        mutant: "    const apply = ((fn) => fn)(() => {\n      if (dropMutedRows)",
        tests: "paymentOverrides"
    },
    {
        id: "261-mute-ends-end-of-day", ticket: '#261',
        desc: "a mute ends at the start of the mutedUntil day instead of the end of it",
        file: "src/lib/scheduleAlertRules.js",
        anchor: ".add(1, 'day').startOf('day')",
        mutant: ".add(0, 'day').startOf('day')",
        tests: "scheduleAlertRules"
    },
    {
        id: "261-config-lock-ignored", ticket: '#261',
        desc: "a config-locked alert still counts as enabled",
        file: "src/lib/scheduleAlertRules.js",
        anchor: "enabled: !lockedByConfig && o.enabled !== false",
        mutant: "enabled: o.enabled !== false",
        tests: "scheduleAlertRules"
    },
    {
        id: "261-mute-never-active", ticket: '#261',
        desc: "a mute whose end is in the future is not reported as muted",
        file: "src/lib/scheduleAlertRules.js",
        anchor: "now.getTime() < muteEndsAt(mutedUntil, timezone).getTime()",
        mutant: "now.getTime() > muteEndsAt(mutedUntil, timezone).getTime()",
        tests: "scheduleAlertRules"
    },
    {
        id: "261-mute-days-unbounded", ticket: '#261',
        desc: "a mute date beyond 365 days is accepted",
        file: "src/services/healthCheck.js",
        anchor: "if (days < 0 || days > 365) return bad",
        mutant: "if (days < 0) return bad",
        tests: "paymentOverrides"
    },
    {
        id: "261-mute-reason-optional", ticket: '#261',
        desc: "a mute without a reason is accepted",
        file: "src/services/healthCheck.js",
        anchor: "if (reason === '') return 'reason_required';",
        mutant: "",
        tests: "paymentOverrides"
    },
    {
        id: "261-mute-extension-resets-start", ticket: '#261',
        desc: "extending a mute moves its start to now",
        file: "src/services/healthCheck.js",
        anchor: "before && before.mutedUntil && before.mutedFrom ? before.mutedFrom : now.toISOString()",
        mutant: "now.toISOString()",
        tests: "paymentOverrides"
    },
    {
        id: "261-early-unmute-keeps-muted-rows", ticket: '#261',
        desc: "an early unmute leaves the held-back rows in place",
        file: "src/services/healthCheck.js",
        anchor: "dropMutedRows: Boolean(before && before.mutedUntil && next.mutedUntil === null),",
        mutant: "dropMutedRows: false,",
        tests: "paymentOverrides"
    },
    {
        id: "261-noop-put-audited", ticket: '#261',
        desc: "a PUT that changes nothing is still written to the audit trail",
        file: "src/services/syncHistory.js",
        anchor: "const audited = Boolean(changes && Object.keys(changes).length > 0);",
        mutant: "const audited = true;",
        tests: "paymentOverrides"
    },
    {
        id: "261-delete-missing-override-ok", ticket: '#261',
        desc: "DELETE of an unknown override answers 200 instead of 404",
        file: "src/services/healthCheck.js",
        anchor: "if (!before) return res.status(404).json({ error: 'override_not_found' });",
        mutant: "",
        tests: "paymentOverrides"
    },
    {
        id: "261-delete-keeps-muted-rows", ticket: '#261',
        desc: "DELETE of a muted override leaves its muted rows behind",
        file: "src/services/healthCheck.js",
        anchor: "dropMutedRows: Boolean(before.mutedUntil),",
        mutant: "dropMutedRows: false,",
        tests: "paymentOverrides"
    },
    {
        id: "261-orphaned-always-false", ticket: '#261',
        desc: "an override of a removed alert is not flagged orphaned",
        file: "src/services/healthCheck.js",
        anchor: "orphaned: !(known.has(o.server) && known.get(o.server).has(o.alertId))",
        mutant: "orphaned: false",
        tests: "paymentOverrides"
    },
    {
        id: "261-default-override-kept", ticket: '#261',
        desc: "a default-state override (on, not muted) is stored instead of deleted",
        file: "src/services/syncHistory.js",
        anchor: "if (enabled !== false && !mutedUntil) {",
        mutant: "if (false) {",
        tests: "paymentOverrides"
    },
    {
        id: "261-cleanup-purges-muted-rows", ticket: '#261',
        desc: "the retention cleanup purges the muted rows of an active mute",
        file: "src/services/syncHistory.js",
        anchor: "AND o.muted_until IS NOT NULL))",
        mutant: "AND 1 = 0))",
        tests: "paymentOverrides"
    },
    {
        id: "261-expiry-immediate", ticket: '#261',
        desc: "a stale mute expires with no 7 day grace after its end",
        file: "src/services/syncHistory.js",
        anchor: ".tz(timezone).add(7, 'days')",
        mutant: ".tz(timezone).add(0, 'days')",
        tests: "paymentOverrides"
    },
    {
        id: "261-muted-row-counts-as-told", ticket: '#261',
        desc: "a muted ledger row suppresses the destination like a sent one (no summary, no resend)",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "if (latest.delivery === 'muted') return { due: false, lastSentAt: null };",
        mutant: "",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "261-summary-resent-every-sync", ticket: '#261',
        desc: "the mute-end summary ignores its own ledger row and is sent again",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "event: 'muteEnded' })) continue; // already told",
        mutant: "event: 'muteEnded' })) void 0; // already told",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "261-summary-not-recorded", ticket: '#261',
        desc: "the mute-end summary is not written to the ledger after sending",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "await history.recordScheduleAlert({ ...summaryKey, event: 'muteEnded', delivery: 'sent' });",
        mutant: "",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "261-summary-failure-clears-mute", ticket: '#261',
        desc: "a failed summary send still clears the mute",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "if (!ok) { complete = false; continue; }",
        mutant: "if (!ok) { continue; }",
        tests: "scheduleAlertDelivery"
    },

    // ---- #289: now() seam at per-call sites, port read-back ----------------------
    {
        id: '289-e2e-external-request-guard-dropped', ticket: '#289',
        desc: "withFixture no longer fails when a spec's request was blocked by interception",
        file: 'tests/e2e/fixtures/browser.js',
        anchor: "    if (page.__externalRequests.length) {\n      throw new Error(",
        mutant: "    if (false && page.__externalRequests.length) {\n      throw new Error(",
        tests: 'e2eHarnessGuard'
    },
    {
        id: '261-e2e-data-url-counted-external', ticket: '#261',
        desc: "withFixture counts a data: URL as an external request and fails a page that used the date picker",
        file: 'tests/e2e/fixtures/browser.js',
        anchor: "url.startsWith(baseUrl)) || url.startsWith('data:')) {",
        mutant: "url.startsWith(baseUrl)) || false) {",
        tests: 'e2eHarnessGuard'
    },
    {
        id: '289-e2e-csp-violation-guard-dropped', ticket: '#289',
        desc: "withFixture no longer fails when a CSP violation was recorded on the page",
        file: 'tests/e2e/fixtures/browser.js',
        anchor: "    if (violations.length) {\n      throw new Error(",
        mutant: "    if (false && violations.length) {\n      throw new Error(",
        tests: 'e2eHarnessGuard'
    },
    {
        id: '289-e2e-csp-report-round-trip-dropped', ticket: '#289',
        desc: "withFixture reads the CSP violation list before a report from the spec's last step reaches Node",
        file: 'tests/e2e/fixtures/browser.js',
        anchor: "    if (!page.isClosed()) await page.evaluate(() => new Promise((r) => setTimeout(r, 0))).catch(() => {});",
        mutant: "",
        tests: 'e2eHarnessGuard'
    },
    {
        id: '289-port-readback-dropped', ticket: '#289',
        desc: "start() no longer reads the OS-assigned port back, so service.port stays 0 after port: 0",
        file: 'src/services/healthCheck.js',
        anchor: "            this.port = this.server.address().port;",
        mutant: "            void this.server.address().port;",
        tests: 'healthCheckPort'
    },
    {
        id: '289-health-uptime-real-clock', ticket: '#289',
        desc: "/health computes uptime from the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "this.app.get('/health', (req, res) => {\n      const uptime = Math.floor((this.now().getTime()",
        mutant: "this.app.get('/health', (req, res) => {\n      const uptime = Math.floor((new Date().getTime()",
        tests: 'healthCheckPort'
    },
    {
        id: '289-health-timestamp-real-clock', ticket: '#289',
        desc: "/health stamps its timestamp from the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "const health = {\n        status: 'UP',\n        timestamp: this.now().toISOString(),",
        mutant: "const health = {\n        status: 'UP',\n        timestamp: new Date().toISOString(),",
        tests: 'healthCheckPort'
    },
    {
        id: '289-metrics-uptime-real-clock', ticket: '#289',
        desc: "/metrics computes uptime from the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "this.app.get('/metrics', this.metricsAuth(), (req, res) => {\n      const uptime = Math.floor((this.now().getTime()",
        mutant: "this.app.get('/metrics', this.metricsAuth(), (req, res) => {\n      const uptime = Math.floor((new Date().getTime()",
        tests: 'healthCheckPort'
    },
    {
        id: '289-metrics-timestamp-real-clock', ticket: '#289',
        desc: "/metrics stamps its timestamp from the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "status: this.getOverallStatus(),\n        timestamp: this.now().toISOString(),",
        mutant: "status: this.getOverallStatus(),\n        timestamp: new Date().toISOString(),",
        tests: 'healthCheckPort'
    },
    {
        id: '289-ready-window-real-clock', ticket: '#289',
        desc: "/ready measures its 60s startup window against the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "(this.now().getTime() - new Date(this.status.startTime).getTime()) < 60000;",
        mutant: "(new Date().getTime() - new Date(this.status.startTime).getTime()) < 60000;",
        tests: 'healthCheckPort'
    },
    {
        id: '289-ready-timestamp-real-clock', ticket: '#289',
        desc: "/ready READY response stamps the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "res.json({ status: 'READY', timestamp: this.now().toISOString() });",
        mutant: "res.json({ status: 'READY', timestamp: new Date().toISOString() });",
        tests: 'healthCheckPort'
    },
    {
        id: '289-not-ready-timestamp-real-clock', ticket: '#289',
        desc: "/ready NOT_READY response stamps the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "status: 'NOT_READY', \n          timestamp: this.now().toISOString(),",
        mutant: "status: 'NOT_READY', \n          timestamp: new Date().toISOString(),",
        tests: 'healthCheckPort'
    },
    {
        id: '289-last-sync-time-real-clock', ticket: '#289',
        desc: "updateSyncStatus stamps lastSyncTime from the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "this.status.lastSyncTime = this.now().toISOString();",
        mutant: "this.status.lastSyncTime = new Date().toISOString();",
        tests: 'healthCheckPort'
    },
    {
        id: '289-server-version-checked-at-real-clock', ticket: '#289',
        desc: "updateServerVersion stamps checkedAt from the real clock instead of now()",
        file: 'src/services/healthCheck.js',
        anchor: "checkedAt: this.now().toISOString()",
        mutant: "checkedAt: new Date().toISOString()",
        tests: 'healthCheckPort'
    },
    {
        id: '289-history-cutoff-real-clock', ticket: '#289',
        desc: "getHistory measures its days cutoff from the real clock instead of now()",
        file: 'src/services/syncHistory.js',
        anchor: "const cutoffDate = this.now();\n        cutoffDate.setDate(cutoffDate.getDate() - filters.days);\n        query += ' AND timestamp >= ?';\n        params.push(cutoffDate.toISOString());\n      }\n\n      query += ' ORDER BY timestamp DESC';",
        mutant: "const cutoffDate = new Date();\n        cutoffDate.setDate(cutoffDate.getDate() - filters.days);\n        query += ' AND timestamp >= ?';\n        params.push(cutoffDate.toISOString());\n      }\n\n      query += ' ORDER BY timestamp DESC';",
        tests: 'syncHistory'
    },
    {
        id: '289-statistics-cutoff-real-clock', ticket: '#289',
        desc: "getStatistics measures its days cutoff from the real clock instead of now()",
        file: 'src/services/syncHistory.js',
        anchor: "const cutoffDate = this.now();\n        cutoffDate.setDate(cutoffDate.getDate() - filters.days);\n        query += ' AND timestamp >= ?';\n        params.push(cutoffDate.toISOString());\n      }\n\n      const stmt = this.db.prepare(query);\n      const stats",
        mutant: "const cutoffDate = new Date();\n        cutoffDate.setDate(cutoffDate.getDate() - filters.days);\n        query += ' AND timestamp >= ?';\n        params.push(cutoffDate.toISOString());\n      }\n\n      const stmt = this.db.prepare(query);\n      const stats",
        tests: 'syncHistory'
    },
    {
        id: '289-statistics-by-server-cutoff-real-clock', ticket: '#289',
        desc: "getStatisticsByServer measures its days cutoff from the real clock instead of now()",
        file: 'src/services/syncHistory.js',
        anchor: "if (days) {\n        const cutoffDate = this.now();\n        cutoffDate.setDate(cutoffDate.getDate() - days);\n        query += ' AND timestamp >= ?';\n        params.push(cutoffDate.toISOString());\n      }\n\n      query += ' GROUP BY",
        mutant: "if (days) {\n        const cutoffDate = new Date();\n        cutoffDate.setDate(cutoffDate.getDate() - days);\n        query += ' AND timestamp >= ?';\n        params.push(cutoffDate.toISOString());\n      }\n\n      query += ' GROUP BY",
        tests: 'syncHistory'
    },
    {
        id: '289-cleanup-cutoff-real-clock', ticket: '#289',
        desc: "cleanup measures the sync_history retention cutoff from the real clock instead of now()",
        file: 'src/services/syncHistory.js',
        anchor: "try {\n      const cutoffDate = this.now();\n      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);",
        mutant: "try {\n      const cutoffDate = new Date();\n      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);",
        tests: 'syncHistory'
    },
    {
        id: '289-schedule-alerts-cutoff-real-clock', ticket: '#289',
        desc: "cleanup measures the schedule_alerts retention cutoff from the real clock instead of now()",
        file: 'src/services/syncHistory.js',
        anchor: "const scheduleAlertsCutoff = this.now();",
        mutant: "const scheduleAlertsCutoff = new Date();",
        tests: 'syncHistory'
    },

    // ---- #326: completed one-off schedule closes its open missing ---------
    {
        id: '326-completed-oneoff-not-bound', ticket: '#326',
        desc: 'a completed one-off schedule is no longer bound, so its open missing is never resolved',
        file: 'src/lib/scheduleAlertRules.js',
        anchor: "if (!isActive(s) && typeof s.date === 'string') {",
        mutant: "if (false && !isActive(s) && typeof s.date === 'string') {",
        tests: 'scheduleAlert'
    },
    {
        id: '326-completed-recurring-bound', ticket: '#326',
        desc: 'a completed recurring schedule is bound too, so it would also be resolved on completion',
        file: 'src/lib/scheduleAlertRules.js',
        anchor: "if (!isActive(s) && typeof s.date === 'string') {",
        mutant: "if (!isActive(s)) {",
        tests: 'scheduleAlert'
    },
    {
        id: '326-completed-lookback-ignored', ticket: '#326',
        desc: 'the look-back window is not applied, so a missing older than it is still resolved',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: ".subtract(MAX_LOOKBACK_DAYS, 'days').format('YYYY-MM-DD');\n    for (const schedule of completedSchedules)",
        mutant: ".subtract(MAX_LOOKBACK_DAYS, 'days').format('YYYY-MM-DD');\n    sinceDate = '0000-01-01';\n    for (const schedule of completedSchedules)",
        tests: 'scheduleAlert'
    },
    {
        id: '326-completed-wording-lost', ticket: '#326',
        desc: 'closed_by is not put in the render context, so the resolved text claims a payment arrived',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "closed_by: event.closedBy || null,",
        mutant: "closed_by: null,",
        tests: 'scheduleAlert'
    },
    {
        id: '326-completed-custom-template-used', ticket: '#326',
        desc: 'a custom resolved template without closed_by is used for a completed one-off, claiming a payment arrived',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "    if (!handled) templates.resolved = DEFAULT_TEMPLATES.resolved;",
        mutant: "    if (false && !handled) templates.resolved = DEFAULT_TEMPLATES.resolved;",
        tests: 'scheduleAlert'
    },
    {
        id: '326-payment-resolved-loses-custom-template', ticket: '#326',
        desc: 'the built-in resolved replaces every custom template without closed_by, including ordinary payments',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  if (event.closedBy) {",
        mutant: "  if (true) {",
        tests: 'scheduleAlert'
    },
    {
        id: '326-completed-resolved-repeats', ticket: '#326',
        desc: 'the per-destination already-resolved check is skipped, so resolved repeats every sync',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "return { due: !resolvedRow || resolvedRow.recordedAt < missingRow.recordedAt, lastSentAt: null };",
        mutant: "return { due: true, lastSentAt: null };",
        tests: 'scheduleAlert'
    },
    {
        id: '326-resolved-final-after-later-missing', ticket: '#326',
        desc: 'any resolved row is final, so a completed-then-uncompleted (or unlinked-then-relinked) schedule never closes again',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "return { due: !resolvedRow || resolvedRow.recordedAt < missingRow.recordedAt, lastSentAt: null };",
        mutant: "return { due: !resolvedRow, lastSentAt: null };",
        tests: 'scheduleAlert'
    },
    {
        id: '326-completed-lookback-off-by-one', ticket: '#326',
        desc: 'the look-back cutoff is one day short, so a missing exactly MAX_LOOKBACK_DAYS old is no longer resolved',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: ".subtract(MAX_LOOKBACK_DAYS, 'days').format('YYYY-MM-DD');\n    for (const schedule of completedSchedules)",
        mutant: ".subtract(MAX_LOOKBACK_DAYS - 1, 'days').format('YYYY-MM-DD');\n    for (const schedule of completedSchedules)",
        tests: 'scheduleAlert'
    },
    {
        id: "262-skipped-sync-blanks-schedule-snapshot", ticket: '#262',
        desc: "a sync skipped for an empty schedule list replaces the schedule snapshot with an empty one",
        file: "src/lib/scheduleAlertsStep.js",
        anchor: "} else if (!(outcome && outcome.failed) && evaluated && !evaluated.skipped) {",
        mutant: "} else if (!(outcome && outcome.failed) && evaluated) {",
        tests: "scheduleAlertsSync"
    },
    {
        id: "262-r1-save-compiles-resolved-only", ticket: '#262',
        desc: "a dashboard save compiles templates only for configured channels, so the sync later drops a 201 rule",
        file: "src/lib/scheduleAlertValidation.js",
        anchor: "  const channels = schemaOnly || dashboard ? requested : resolved;",
        mutant: "  const channels = schemaOnly ? requested : resolved;",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-r1-list-config-schema-only", ticket: '#262',
        desc: "the list checks a config rule against every channel, flagging one the sync evaluates",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "    schemaOnly: dashboard,",
        mutant: "    schemaOnly: true,",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-r1-empty-block-templates-unchecked", ticket: '#262',
        desc: "block templates of a block with no config rules are not checked at startup",
        file: "src/lib/configLoader.js",
        anchor: "if (server.scheduleAlerts && alerts.length === 0) {",
        mutant: "if (false) {",
        tests: "configLoader"
    },
    {
        id: "262-r2-block-unconfigured-channel-silent", ticket: '#262',
        desc: "a block template only an unconfigured channel rejects passes startup with no warning",
        file: "src/lib/configLoader.js",
        anchor: "                if (allChannels.code === 'invalid_template') {",
        mutant: "                if (false) {",
        tests: "configLoader"
    },
    {
        id: "262-r2-rule-only-server-not-orphaned", ticket: '#262',
        desc: "a removed server with dashboard rules but no sync rows is missing from the orphaned list",
        file: "src/services/syncHistory.js",
        anchor: "          SELECT DISTINCT server, 0, NULL FROM payment_alert_rule",
        mutant: "          SELECT DISTINCT server, 0, NULL FROM payment_alert_rule WHERE 0",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-r1-orphan-rules-kept", ticket: '#262',
        desc: "a reset of a server removed from the config keeps its dashboard rules",
        file: "src/services/healthCheck.js",
        anchor: "const purgeRules = configured !== null && !configured.includes(server) &&",
        mutant: "const purgeRules = false &&",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-r1-configured-rules-purged", ticket: '#262',
        desc: "a reset of a configured server deletes its dashboard rules",
        file: "src/services/healthCheck.js",
        anchor: "const purgeRules = configured !== null && !configured.includes(server) &&",
        mutant: "const purgeRules = true &&",
        tests: "paymentRulesRoute"
    },
    {
        id: "372-reset-all-keeps-orphan-rules", ticket: '#372',
        desc: "reset all keeps the dashboard rules of servers removed from the config",
        file: "src/services/healthCheck.js",
        anchor: "          await this.syncHistory.resetAllHistory({ remoteAddr: req.ip, configuredServers });",
        mutant: "          await this.syncHistory.resetAllHistory({ remoteAddr: req.ip });",
        tests: "paymentRulesRoute"
    },
    {
        id: "372-reset-all-deletes-configured-rules", ticket: '#372',
        desc: "reset all deletes the dashboard rules of configured servers too",
        file: "src/services/syncHistory.js",
        anchor: "        'DELETE FROM payment_alert_rule WHERE server NOT IN (SELECT value FROM json_each(?))'",
        mutant: "        'DELETE FROM payment_alert_rule WHERE ? IS NOT NULL'",
        tests: "paymentRulesRoute"
    },
    {
        id: "372-r-reset-all-ungated", ticket: '#372',
        desc: "reset all deletes orphan rules while config writes are off",
        file: "src/services/healthCheck.js",
        anchor: "          const configuredServers = this.getServers && this.configWritesReason() === null",
        mutant: "          const configuredServers = this.getServers",
        tests: "paymentRulesRoute"
    },
    {
        id: "372-r-reset-server-ungated", ticket: '#372',
        desc: "reset of one orphan server deletes its rules while config writes are off",
        file: "src/services/healthCheck.js",
        anchor: "            this.configWritesReason() === null;",
        mutant: "            true;",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-reset-server-deletes-rules", ticket: '#262',
        desc: "a per-server history reset also deletes the dashboard payment rules",
        file: "src/services/syncHistory.js",
        anchor: "        if (purgeRules) deleted.payment_alert_rule = delRules.run(s).changes;",
        mutant: "        deleted.payment_alert_rule = delRules.run(s).changes;",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-config-wins-on-id-clash", ticket: '#262',
        desc: "a dashboard rule whose id equals a config rule is no longer marked superseded",
        file: "src/lib/scheduleAlertRules.js",
        anchor: "superseded: configIds.has(rule.id),",
        mutant: "superseded: false,",
        tests: "scheduleAlertRules"
    },
    {
        id: "262-sync-listrules-untagged", ticket: '#262',
        desc: "a failed rule read is swallowed so the previous snapshot would not be kept",
        file: "src/lib/scheduleAlertsStep.js",
        anchor: "    const merged = mergeRules(configRules, syncHistory.listRules(serverName), block);",
        mutant: "    let rows = [];\n    try { rows = syncHistory.listRules(serverName); } catch (e) { rows = []; }\n    const merged = mergeRules(configRules, rows, block);",
        tests: "scheduleAlertsSync"
    },
    {
        id: "262-sync-schemaonly-skipped", ticket: '#262',
        desc: "an invalid stored dashboard rule is no longer excluded from the sync",
        file: "src/lib/scheduleAlertsStep.js",
        anchor: "        if (result.valid) active.push(rule); else excluded.push(rule.id);",
        mutant: "        active.push(rule);",
        tests: "scheduleAlertsSync"
    },
    {
        id: "262-post-id-in-config-unchecked", ticket: '#262',
        desc: "POST no longer rejects an id that a config rule owns",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "if (getRules(block).some((rule) => rule.id === id)) return res.status(409).json({ error: 'id_in_config' });",
        mutant: "",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-post-duplicate-unchecked", ticket: '#262',
        desc: "POST no longer rejects a duplicate dashboard id",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "if (svc.syncHistory.getRule(server.name, id)) return { error: 'duplicate_id' };",
        mutant: "",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-post-cap-off-by-one", ticket: '#262',
        desc: "the 200 rule cap lets a 201st rule in",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "countRules(server.name) >= MAX_DASHBOARD_RULES",
        mutant: "countRules(server.name) > MAX_DASHBOARD_RULES",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-put-noop-always-writes", ticket: '#262',
        desc: "an unchanged PUT writes an update and an audit row",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "if (canonical(stored.definition) !== canonical(definition)) {",
        mutant: "if (true) {",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-put-managed-in-config-unchecked", ticket: '#262',
        desc: "PUT no longer refuses an id that a config rule owns",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "if (getRules(block).some((rule) => rule.id === alertId)) return res.status(409).json({ error: 'managed_in_config' });",
        mutant: "",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-preview-rate-limit-off", ticket: '#262',
        desc: "the test-send rate limit never triggers",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "if (sendTimes.length >= TEST_SEND_LIMIT) return",
        mutant: "if (false) return",
        tests: "paymentPreviewRoute"
    },
    {
        id: "262-preview-window-never-slides", ticket: '#262',
        desc: "old test sends never leave the rate limit window",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "while (sendTimes.length && now - sendTimes[0] >= TEST_SEND_WINDOW_MS) sendTimes.shift();",
        mutant: "",
        tests: "paymentPreviewRoute"
    },
    {
        id: "262-preview-timeout-code", ticket: '#262',
        desc: "a send that hangs is reported as send_threw instead of timeout",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "error: error && error.previewTimeout ? 'timeout' : 'send_threw'",
        mutant: "error: 'send_threw'",
        tests: "scheduleAlertDelivery"
    },
    {
        id: "262-delete-keeps-override", ticket: '#262',
        desc: "deleting a dashboard rule leaves its override behind",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "            svc.syncHistory.deleteOverride(server.name, alertId);\n",
        mutant: "",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-delete-keeps-muted-rows", ticket: '#262',
        desc: "deleting a muted dashboard rule leaves its muted ledger rows",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "if (override.mutedUntil) {",
        mutant: "if (false) {",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-delete-keeps-status", ticket: '#262',
        desc: "deleting a dashboard rule leaves its status rows",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "          svc.syncHistory.deletePaymentStatusForAlert(server.name, alertId);\n",
        mutant: "",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-delete-superseded-cascades", ticket: '#262',
        desc: "deleting a superseded row also wipes the config rule's override and status",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "        if (!inConfig) {\n          // The config rule",
        mutant: "        if (true) {\n          // The config rule",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-delete-audit-outside-tx", ticket: '#262',
        desc: "the delete is no longer wrapped in one transaction",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "      svc.syncHistory.runInTransaction(() => {\n        const changes = diffDefinitions(stored.definition, null);",
        mutant: "      ((fn) => fn())(() => {\n        const changes = diffDefinitions(stored.definition, null);",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-active-rules-ignores-merge", ticket: '#262',
        desc: "the payment routes consult only config rules",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "return mergeRules(getRules(block), rows, block).filter((rule) => !rule.superseded);",
        mutant: "return getRules(block).map((r) => ({ ...r, source: 'config', superseded: false }));",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-no-block-no-rules", ticket: '#262',
        desc: "a server with no scheduleAlerts block still lists stored rules as active",
        file: "src/services/paymentRuleRoutes.js",
        anchor: "  if (!block) return [];\n  const rows",
        mutant: "  if (!block) return mergeRules([], svc.syncHistory.listRules(server.name), {});\n  const rows",
        tests: "paymentRulesRoute"
    },
    {
        id: "262-preview-compiles-once-skipped", ticket: '#262',
        desc: "previewRule no longer compiles the templates so a bad template would not surface",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "  const renderer = compileTemplateSet({ templates, variables: VARIABLES, channels: modes });\n  const text = channels.length ?",
        mutant: "  const renderer = { render: () => 'x' };\n  const text = channels.length ?",
        tests: "paymentPreviewRoute"
    },
    {
        id: "262-null-result-channel-unavailable", ticket: '#262',
        desc: "a null channel result is reported as ok",
        file: "src/lib/scheduleAlertDelivery.js",
        anchor: "  if (result == null) return 'channel_unavailable';",
        mutant: "  if (result == null) return null;",
        tests: "scheduleAlertDelivery"
    },
    // ---- #356: deleted schedule closes its open missing; ruleUnmatched once ---
    {
        id: '356-deleted-never-inferred', ticket: '#356',
        desc: "a schedule missing from Actual's list is not detected, so its open missing never closes",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "        if (existingScheduleIds.has(row.scheduleId)) {",
        mutant: "        if (true) continue;\n        if (existingScheduleIds.has(row.scheduleId)) {",
        tests: 'scheduleAlert'
    },
    {
        id: '356-existing-schedule-closed', ticket: '#356',
        desc: "a schedule still present in Actual is closed as deleted too",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "        if (existingScheduleIds.has(row.scheduleId)) {",
        mutant: "        if (false) {",
        tests: 'scheduleAlert'
    },
    {
        id: '356-deleted-no-list-guard', ticket: '#356',
        desc: "deletion is inferred even when the schedule list is unusable (null), risking a mass resolve",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  if (existingScheduleIds) {\n    const sinceDate",
        mutant: "  if (true) {\n    existingScheduleIds = existingScheduleIds || new Set();\n    const sinceDate",
        tests: 'scheduleAlert'
    },
    {
        id: '356-empty-list-trusted', ticket: '#356',
        desc: "an empty schedule list is trusted as everything deleted instead of ignored",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "Array.isArray(rawSchedules) && rawSchedules.length > 0",
        mutant: "Array.isArray(rawSchedules)",
        tests: 'scheduleAlert'
    },
    {
        id: '356-deleted-wording-lost', ticket: '#356',
        desc: "the deleted branch is dropped from the built-in resolved, so a deleted schedule is reported as a payment",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "{{else if (eq closed_by \"deleted\")}}",
        mutant: "{{else if (eq closed_by \"never\")}}",
        tests: 'scheduleAlert'
    },
    {
        id: '356-deleted-custom-template-used', ticket: '#356',
        desc: "a custom resolved without closed_by is used for a deleted schedule, claiming a payment arrived",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "const handled = /\\bclosed_by\\b/.test(custom) && (literals.length === 0 || literals.includes(event.closedBy));",
        mutant: "const handled = /\\bclosed_by\\b/.test(custom);",
        tests: 'scheduleAlert'
    },
    {
        id: '356-ruleUnmatched-repeats', ticket: '#356',
        desc: "ruleUnmatched is due again on every sync after it was sent",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "return { due: !!matchedRow && matchedRow.recordedAt > latest.recordedAt, lastSentAt: latest.recordedAt };",
        mutant: "return { due: true, lastSentAt: latest.recordedAt };",
        tests: 'scheduleAlert'
    },
    {
        id: '356-ruleUnmatched-never-rearms', ticket: '#356',
        desc: "ruleUnmatched never fires again after the rule matched and later unmatched",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "return { due: !!matchedRow && matchedRow.recordedAt > latest.recordedAt, lastSentAt: latest.recordedAt };",
        mutant: "return { due: false, lastSentAt: latest.recordedAt };",
        tests: 'scheduleAlert'
    },
    {
        id: '356-rematch-not-recorded', ticket: '#356',
        desc: "a rule matching again leaves no ruleMatched marker, so a later unmatch stays silent",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "      await history.recordScheduleAlert({ ...key, event: 'ruleMatched', delivery: 'inferred' });",
        mutant: "      void key;",
        tests: 'scheduleAlert'
    },
    {
        id: '356-reversed-eq-order-ignored', ticket: '#356',
        desc: 'a template written as (eq "completed" closed_by) is honoured for a deleted schedule and claims a payment arrived',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "|[\"']([^\"']*)[\"']\\s+closed_by\\b/g)]",
        mutant: "/g)]",
        tests: 'scheduleAlert'
    },
    {
        id: '356-matched-from-evaluations-only', ticket: '#356',
        desc: "a rule is only counted as matched when it has an evaluation, so a cannotCheck-only rule never re-arms ruleUnmatched",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: ".filter((id) => !unmatchedIds.has(id))",
        mutant: ".filter((id) => !unmatchedIds.has(id) && (evaluations || []).some((e) => e.alertId === id))",
        tests: 'scheduleAlert'
    },

    // ---- #373: a retargeted rule closes the old schedule's open missing ------
    {
        id: '373-retarget-never-closed', ticket: '#373',
        desc: "a schedule that still exists but is no longer named by the rule is never closed",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "          if (!matched || matched.has(row.scheduleId)) continue;",
        mutant: "          continue;",
        tests: 'scheduleAlert'
    },
    {
        id: '373-still-matched-closed', ticket: '#373',
        desc: "a schedule the rule still names is closed as rule_changed too",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "          if (!matched || matched.has(row.scheduleId)) continue;",
        mutant: "          if (!matched) continue;",
        tests: 'scheduleAlert'
    },
    {
        id: '373-no-matched-map-guard', ticket: '#373',
        desc: "without a matched-schedule map every existing schedule is closed as rule_changed",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "          if (!matched || matched.has(row.scheduleId)) continue;",
        mutant: "          if (matched && matched.has(row.scheduleId)) continue;",
        tests: 'scheduleAlert'
    },
    {
        id: '373-deleted-labelled-rule-changed', ticket: '#373',
        desc: "a deleted schedule is reported as rule_changed instead of deleted",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "        let closedBy = 'deleted';",
        mutant: "        let closedBy = 'rule_changed';",
        tests: 'scheduleAlert'
    },
    {
        id: '373-rule-changed-wording-lost', ticket: '#373',
        desc: "the rule_changed branch is dropped from the built-in resolved, so a retarget is reported as a payment",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "{{else if (eq closed_by \"rule_changed\")}}",
        mutant: "{{else if (eq closed_by \"never\")}}",
        tests: 'scheduleAlert'
    },
    {
        id: '373-rule-changed-name-from-rule', ticket: '#373',
        desc: "the retarget close names the rule's new target instead of the schedule that was closed",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "          scheduleName = (scheduleNameById && scheduleNameById.get(row.scheduleId)) || null;",
        mutant: "          scheduleName = rule.schedule || null;",
        tests: 'scheduleAlert'
    },
    {
        id: '373-matched-ignores-prefix', ticket: '#373',
        desc: "the matched set ignores schedulePrefix, so a prefix rule's schedules are closed as rule_changed",
        file: 'src/lib/scheduleAlertRules.js',
        anchor: "  if (rule.schedulePrefix) {\n    return (schedules || [])",
        mutant: "  if (false) {\n    return (schedules || [])",
        tests: 'scheduleAlert'
    },
    {
        id: '373-matched-map-not-passed', ticket: '#373',
        desc: "the sync step does not hand the matched map to delivery, so a retarget is never closed",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "        matchedScheduleIds,\n        scheduleNameById,\n        ruleState",
        mutant: "        scheduleNameById,\n        ruleState",
        tests: 'scheduleAlert'
    },
    {
        id: '373-custom-template-used-for-retarget', ticket: '#373',
        desc: "a custom resolved without closed_by is used for a retarget close, claiming a payment arrived",
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "const handled = /\\bclosed_by\\b/.test(custom) && (literals.length === 0 || literals.includes(event.closedBy));",
        mutant: "const handled = /\\bclosed_by\\b/.test(custom);",
        tests: 'scheduleAlert'
    },

    // ---- #359: an empty schedule list skips rule matching ------------------
    {
        id: '359-empty-list-evaluated', ticket: '#359',
        desc: "an empty schedule list is evaluated, so every rule raises ruleUnmatched",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "if (!scheduleListReliable && scheduleAlertRules.length > 0) {",
        mutant: "if (false) {",
        tests: 'scheduleAlert'
    },
    {
        id: '359-skip-without-rules-warns', ticket: '#359',
        desc: "the skip also fires (and warns) when no rule is configured",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "if (!scheduleListReliable && scheduleAlertRules.length > 0) {",
        mutant: "if (!scheduleListReliable) {",
        tests: 'scheduleAlert'
    },
    {
        id: '359-skipped-still-delivered', ticket: '#359',
        desc: "a skipped sync still runs delivery, marking every rule matched and re-arming ruleUnmatched",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "if (evaluated.skipped) return { events: 0, sent: 0, skipped: 0 };",
        mutant: "",
        tests: 'scheduleAlert'
    },
    {
        id: '359-skipped-snapshot-replaced', ticket: '#359',
        desc: "a skipped sync replaces the dashboard snapshot with an empty one",
        file: 'src/lib/scheduleAlertsStep.js',
        anchor: "} else if (evaluated && evaluated.skipped) {",
        mutant: "} else if (evaluated && evaluated.skipped && false) {",
        tests: 'scheduleAlert'
    },
    {
        id: "268-slug-empty", ticket: '#268',
        desc: "an empty or symbol-only name no longer falls back to \"alert\"",
        file: 'src/services/dashboard.js',
        anchor: "return (slug || 'alert').slice(0, 64);",
        mutant: "return (slug || '').slice(0, 64);",
        tests: 'dashboardPayments'
    },
    {
        id: "268-slug-length", ticket: '#268',
        desc: "the slug is no longer cut to 64 characters",
        file: 'src/services/dashboard.js',
        anchor: "return (slug || 'alert').slice(0, 64);",
        mutant: "return (slug || 'alert');",
        tests: 'dashboardPayments'
    },
    {
        id: "268-slug-trim", ticket: '#268',
        desc: "leading and trailing hyphens are kept in the slug",
        file: 'src/services/dashboard.js',
        anchor: ".replace(/^-+|-+$/g, '');\n    return (slug",
        mutant: ".replace(/^-+$/g, '');\n    return (slug",
        tests: 'dashboardPayments'
    },
    {
        id: "268-unique-start", ticket: '#268',
        desc: "the first duplicate id gets -1 instead of -2",
        file: 'src/services/dashboard.js',
        anchor: "for (let n = 2; ; n += 1) {",
        mutant: "for (let n = 1; ; n += 1) {",
        tests: 'dashboardPayments'
    },
    {
        id: "268-unique-cut", ticket: '#268',
        desc: "the suffix is appended without cutting the base, so the id can pass 64 characters",
        file: 'src/services/dashboard.js',
        anchor: "const id = base.slice(0, 64 - suffix.length) + suffix;",
        mutant: "const id = base + suffix;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-prefix-completed", ticket: '#268',
        desc: "completed schedules count as prefix matches",
        file: 'src/services/dashboard.js',
        anchor: "filter((s) => !s.completed && typeof s.name === 'string' && s.name.startsWith(prefix))",
        mutant: "filter((s) => typeof s.name === 'string' && s.name.startsWith(prefix))",
        tests: 'dashboardPayments'
    },
    {
        id: "268-prefix-case", ticket: '#268',
        desc: "the prefix match ignores case, unlike the server",
        file: 'src/services/dashboard.js',
        anchor: "s.name.startsWith(prefix)).length;",
        mutant: "s.name.toLowerCase().startsWith(String(prefix).toLowerCase())).length;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-prefix-zero-text", ticket: '#268',
        desc: "a prefix matching nothing no longer warns about ruleUnmatched",
        file: 'src/services/dashboard.js',
        anchor: "count === 0 ? 'matches 0: this rule will report ruleUnmatched' : `matches ${count}`",
        mutant: "`matches ${count}`",
        tests: 'dashboardPayments'
    },
    {
        id: "268-options-completed", ticket: '#268',
        desc: "completed schedules are offered in the picker",
        file: 'src/services/dashboard.js',
        anchor: "const live = (schedules || []).filter((s) => !s.completed);",
        mutant: "const live = (schedules || []);",
        tests: 'dashboardPayments'
    },
    {
        id: "268-options-dup-suffix", ticket: '#268',
        desc: "two schedules with one name are not told apart",
        file: 'src/services/dashboard.js',
        anchor: "label: counts.get(s.name) > 1 ?",
        mutant: "label: counts.get(s.name) > 99 ?",
        tests: 'dashboardPayments'
    },
    {
        id: "268-line-direction", ticket: '#268',
        desc: "a negative amount is described as money coming in",
        file: 'src/services/dashboard.js',
        anchor: "const out = typeof probe === 'number' && probe < 0;",
        mutant: "const out = typeof probe === 'number' && probe > 0;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-line-no-account", ticket: '#268',
        desc: "a deleted account is not called out",
        file: 'src/services/dashboard.js',
        anchor: "const account = s.account == null ? '(deleted account)' : s.account;",
        mutant: "const account = s.account == null ? '' : s.account;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-ordinal-teens", ticket: '#268',
        desc: "11th, 12th and 13th get the st/nd/rd suffixes",
        file: 'src/services/dashboard.js',
        anchor: "if (v >= 11 && v <= 13) return `${n}th`;",
        mutant: "if (false) return `${n}th`;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-deadline-threshold", ticket: '#268',
        desc: "a day + grace of 29 or more is still called \"of each month\"",
        file: 'src/services/dashboard.js',
        anchor: "if (Number(day[1]) + grace <= 28) return",
        mutant: "if (Number(day[1]) + grace <= 31) return",
        tests: 'dashboardPayments'
    },
    {
        id: "268-deadline-grace-add", ticket: '#268',
        desc: "the real deadline date ignores the grace days",
        file: 'src/services/dashboard.js',
        anchor: "new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + grace));",
        mutant: "new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));",
        tests: 'dashboardPayments'
    },
    {
        id: "268-deadline-non-monthly", ticket: '#268',
        desc: "non-monthly schedules get the monthly deadline wording",
        file: 'src/services/dashboard.js',
        anchor: "if (!day) return `next date ${shortDate(due)}`;",
        mutant: "if (!day) return `deadline: ${shortDate(due)}`;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-template-block", ticket: '#268',
        desc: "the server block template is ignored when prefilling a message",
        file: 'src/services/dashboard.js',
        anchor: "if (block != null) return block;",
        mutant: "if (false) return block;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-tolerance-approx", ticket: '#268',
        desc: "an approximate schedule hint says exact",
        file: 'src/services/dashboard.js',
        anchor: "amountOp === 'isapprox' ? 'From schedule (about 7.5%)'",
        mutant: "amountOp === 'never' ? 'From schedule (about 7.5%)'",
        tests: 'dashboardPayments'
    },
    {
        id: "268-number-stored-key", ticket: '#268',
        desc: "a stored key equal to the default is dropped on edit",
        file: 'src/services/dashboard.js',
        anchor: "if (hasOwn(stored, key) || n !== fallback) body[key] = n;",
        mutant: "if (n !== fallback) body[key] = n;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-keeps-stored", ticket: '#268',
        desc: "keys the form does not show are lost on edit",
        file: 'src/services/dashboard.js',
        anchor: "const body = { ...stored };",
        mutant: "const body = {};",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-prefix-key", ticket: '#268',
        desc: "a prefix watch is written as a schedule",
        file: 'src/services/dashboard.js',
        anchor: "if (form.watch === 'prefix') body.schedulePrefix = form.prefix; else body.schedule = form.schedule;",
        mutant: "if (form.watch === 'prefix') body.schedule = form.prefix; else body.schedule = form.schedule;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-period-default", ticket: '#268',
        desc: "the default period is written even when the rule never had it",
        file: 'src/services/dashboard.js',
        anchor: "if (hasOwn(stored, 'period') || form.period !== DEFAULT_PERIOD) body.period",
        mutant: "if (true) body.period",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-channels-all", ticket: '#268',
        desc: "all channels ticked still writes an explicit channels list",
        file: 'src/services/dashboard.js',
        anchor: "if (all.every((c) => picked.includes(c))) delete body.channels;",
        mutant: "if (false) delete body.channels;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-channels-order", ticket: '#268',
        desc: "the channels list follows tick order, not the configured order",
        file: 'src/services/dashboard.js',
        anchor: "else body.channels = all.filter((c) => picked.includes(c));",
        mutant: "else body.channels = picked.slice();",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-template-empty", ticket: '#268',
        desc: "an emptied message is saved as an empty string",
        file: 'src/services/dashboard.js',
        anchor: "if (text === '') delete templates[event];",
        mutant: "if (text === '') templates[event] = '';",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-template-default", ticket: '#268',
        desc: "an untouched default message is written into the rule",
        file: 'src/services/dashboard.js',
        anchor: "else if (hasOwn(stored.templates, event) || text !== effectiveTemplate(d, event)) templates[event] = text;",
        mutant: "else if (true) templates[event] = text;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-body-remind-off", ticket: '#268',
        desc: "switching reminders off keeps the stored remindEveryDays",
        file: 'src/services/dashboard.js',
        anchor: "        delete body.remindEveryDays;\n    }",
        mutant: "    }",
        tests: 'dashboardPayments'
    },
    {
        id: "268-edited-compare", ticket: '#268',
        desc: "the Edited note shows when the rule was saved before the run",
        file: 'src/services/dashboard.js',
        anchor: "return Number.isFinite(saved) && Number.isFinite(ran) && saved > ran;",
        mutant: "return Number.isFinite(saved) && Number.isFinite(ran) && saved < ran;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-edited-config", ticket: '#268',
        desc: "a config rule can show the Edited note",
        file: 'src/services/dashboard.js',
        anchor: "if (!rule || rule.source !== 'dashboard' || !rule.updatedAt || !lastRunAt) return false;",
        mutant: "if (!rule || !rule.updatedAt || !lastRunAt) return false;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-merge-source", ticket: '#268',
        desc: "rows join on the id alone, so a dashboard rule and a config rule share one row",
        file: 'src/services/dashboard.js',
        anchor: "const key = paymentRuleKey(item.alertId, item.source || 'config');",
        mutant: "const key = paymentRuleKey(item.alertId, 'config');",
        tests: 'dashboardPayments'
    },
    {
        id: "268-merge-null-list", ticket: '#268',
        desc: "a rule list that failed to load hides every snapshot row",
        file: 'src/services/dashboard.js',
        anchor: "if (rules === null || rules === undefined) {",
        mutant: "if (rules === undefined) {",
        tests: 'dashboardPayments'
    },
    {
        id: "268-merge-dormant", ticket: '#268',
        desc: "a rule on a server without a scheduleAlerts block is shown as pending",
        file: 'src/services/dashboard.js',
        anchor: "else if (configured === false) kind = 'dormant';",
        mutant: "else if (false) kind = 'dormant';",
        tests: 'dashboardPayments'
    },
    {
        id: "268-merge-superseded", ticket: '#268',
        desc: "a replaced dashboard rule is shown as pending",
        file: 'src/services/dashboard.js',
        anchor: "else if (rule.superseded) kind = 'superseded';",
        mutant: "else if (false) kind = 'superseded';",
        tests: 'dashboardPayments'
    },
    {
        id: "268-merge-invalid", ticket: '#268',
        desc: "a stored rule that no longer validates is shown as a normal row",
        file: 'src/services/dashboard.js',
        anchor: "if (rule.invalid) kind = 'invalid';",
        mutant: "if (false) kind = 'invalid';",
        tests: 'dashboardPayments'
    },
    {
        id: "268-path-boundary", ticket: '#268',
        desc: "\"/schedule\" swallows \"/schedulePrefix\" errors",
        file: 'src/services/dashboard.js',
        anchor: "if (p === prefix || p.startsWith(`${prefix}/`)) return field;",
        mutant: "if (p.startsWith(prefix)) return field;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-path-template", ticket: '#268',
        desc: "a template error path is not mapped to its message box",
        file: 'src/services/dashboard.js',
        anchor: "if (t) return `template:${t[1]}`;",
        mutant: "if (false) return `template:${t[1]}`;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-error-duplicate", ticket: '#268',
        desc: "a duplicate id error is shown as a banner instead of on the id field",
        file: 'src/services/dashboard.js',
        anchor: "if (code === 'duplicate_id') { out.fields.id = 'An alert with this id exists'; return out; }",
        mutant: "if (code === 'duplicate_id') { say('An alert with this id exists'); return out; }",
        tests: 'dashboardPayments'
    },
    {
        id: "268-error-gone", ticket: '#268',
        desc: "a deleted rule leaves the dialog open",
        file: 'src/services/dashboard.js',
        anchor: "say('This alert no longer exists.'); out.reload = true; out.close = true; return out;",
        mutant: "say('This alert no longer exists.'); out.reload = true; return out;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-error-writes-off", ticket: '#268',
        desc: "a 403 config_writes_disabled does not switch the controls off",
        file: 'src/services/dashboard.js',
        anchor: "        out.writesOff = true;\n        return out;",
        mutant: "        return out;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-error-network", ticket: '#268',
        desc: "a network failure (status 0) is reported as a server rejection",
        file: 'src/services/dashboard.js',
        anchor: "if (status === 0) { say('Could not reach the server. Check your connection and try again.'); return out; }",
        mutant: "if (false) { say('Could not reach the server. Check your connection and try again.'); return out; }",
        tests: 'dashboardPayments'
    },
    {
        id: "268-error-preview-place", ticket: '#268',
        desc: "a preview failure is shown in the save banner",
        file: 'src/services/dashboard.js',
        anchor: "const say = (text) => { if (where === 'preview') out.preview = text; else out.banner = text; };",
        mutant: "const say = (text) => { out.banner = text; };",
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-m1-stored-channels", ticket: '#268',
        desc: 'a stored channels list is dropped again when every box is ticked',
        file: 'src/services/dashboard.js',
        anchor: 'if (Array.isArray(stored.channels)) {',
        mutant: 'if (false) {',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-m1-unchanged-boxes", ticket: '#268',
        desc: 'untouched boxes no longer keep the stored list with its unavailable entries',
        file: 'src/services/dashboard.js',
        anchor: 'body.channels = unchanged ? stored.channels.slice() : all.filter((c) => picked.includes(c));',
        mutant: 'body.channels = all.filter((c) => picked.includes(c));',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-m1-unchanged-compare", ticket: '#268',
        desc: 'changed boxes are treated as unchanged',
        file: 'src/services/dashboard.js',
        anchor: 'const unchanged = initial.length === picked.length && initial.every((c) => picked.includes(c));',
        mutant: 'const unchanged = initial.every((c) => picked.includes(c));',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-m2-errors-shown", ticket: '#268',
        desc: 'Save stays enabled while an error is shown',
        file: 'src/services/dashboard.js',
        anchor: 'const shown = Object.values(ed.errors).some(Boolean);',
        mutant: 'const shown = false;',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-m2-invalid-blocks", ticket: '#268',
        desc: 'Save ignores fields the server marked invalid',
        file: 'src/services/dashboard.js',
        anchor: 'Object.keys(ed.invalid).length === 0 && !shown',
        mutant: '!shown',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-l1-send-guard", ticket: '#268',
        desc: 'a second test send can start while one is in flight',
        file: 'src/services/dashboard.js',
        anchor: '    if (ed.sending) return false;\n',
        mutant: '    if (false) return false;\n',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-l1-send-flag", ticket: '#268',
        desc: 'the in-flight flag is never set',
        file: 'src/services/dashboard.js',
        anchor: '    ed.sending = true;\n    return true;',
        mutant: '    return true;',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-l1-send-disabled", ticket: '#268',
        desc: 'the Send button stays enabled while sending',
        file: 'src/services/dashboard.js',
        anchor: "return !ro && writes && !ed.busy && !ed.sending && !ed.loading;",
        mutant: "return !ro && writes && !ed.busy && !ed.loading;",
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-l2-focus-action", ticket: '#268',
        desc: 'after saving an edit focus goes to Add alert instead of the row Edit button',
        file: 'src/services/dashboard.js',
        anchor: "return editorRowFocusKey(server, ruleId, 'dashboard', 'editPaymentRule');",
        mutant: "return editorRowFocusKey(server, ruleId, 'dashboard', 'edit');",
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-l2-row-key", ticket: '#268',
        desc: 'the row button focus key no longer uses the shared builder format',
        file: 'src/services/dashboard.js',
        anchor: 'return `ed:${JSON.stringify([server, alertId, source, action])}`;',
        mutant: 'return `ed:${JSON.stringify([server, alertId, action])}`;',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-l3-kind", ticket: '#268',
        desc: 'the superseded twin row is counted in Applies to N schedules',
        file: 'src/services/dashboard.js',
        anchor: "r.kind === 'evaluated' && r.item.alertId === alertId",
        mutant: 'r.item.alertId === alertId',
        tests: 'dashboardPayments'
    },
    {
        id: "268-r1-l3-source", ticket: '#268',
        desc: 'rows of another source with the same id are counted',
        file: 'src/services/dashboard.js',
        anchor: ' && r.item.source === source).length;',
        mutant: ' ).length;',
        tests: 'dashboardPayments'
    }
];

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
        anchor: '    return syncQueue.run(server.name, () => runSyncBank(server, options));',
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
        desc: 'downloadBudget is no longer timed, so a server that never answers hangs the queue again',
        file: 'src/lib/actualTimeouts.js',
        anchor: "const TIMED_METHODS = ['init', 'downloadBudget', 'loadBudget', 'aqlQuery', 'sync', 'shutdown', 'getSchedules'];",
        mutant: "const TIMED_METHODS = ['init', 'loadBudget', 'aqlQuery', 'sync', 'shutdown', 'getSchedules'];",
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
        anchor: '            if (lateCalls) lateCalls.add(call);',
        mutant: '',
        tests: 'actualTimeouts'
    },
    {
        id: '272-no-busy-check', ticket: '#272',
        desc: 'a sync opens the session while an earlier late call still runs',
        file: 'src/syncService.js',
        anchor: '        if (!(await lateActualCalls.drain(phaseTimeoutMs))) {',
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
        file: 'src/syncService.js',
        anchor: '            const abandoned = lateActualCalls.abandon();',
        mutant: '            const abandoned = lateActualCalls.size;',
        tests: 'syncQueue'
    },
    {
        id: '272-abandon-keeps-calls', ticket: '#272',
        desc: 'abandon reports the calls dropped but keeps tracking them',
        file: 'src/lib/actualTimeouts.js',
        anchor: '        this.pending.clear();',
        mutant: '',
        tests: 'actualTimeouts'
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
        anchor: "    if (info.origin && !this.isAllowedWsOrigin(info.origin, req.headers.host)) {",
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
        id: '246-basic-auth-short-circuits', ticket: '#246',
        desc: 'a wrong username skips the password comparison, a timing signal for valid usernames',
        file: 'src/lib/dashboardCredentials.js',
        anchor: '    const passOk = safeEqual(password, authConfig.password);',
        mutant: '    const passOk = userOk && safeEqual(password, authConfig.password);',
        tests: 'dashboardCredentials'
    },

    {
        id: '242-ws-header-oracle', ticket: '#242',
        desc: 'the handshake accepts an Authorization header again, an unthrottled password oracle',
        file: 'src/services/healthCheck.js',
        anchor: '    if (ticket && this.wsTickets.consume(ticket)) return done(true);\n',
        mutant: '    if (ticket && this.wsTickets.consume(ticket)) return done(true);\n    if (checkCredentials(req.headers, authConfig).ok) return done(true);\n',
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
        anchor: "    res.locals.authFailed = true;\n    this.logger.warn('Dashboard token authentication failed', {",
        mutant: "    this.logger.warn('Dashboard token authentication failed', {",
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
        anchor: '        if (res.locals.authFailed) this.authFailures.increment(key);',
        mutant: '        this.authFailures.increment(key);',
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
        anchor: "    return (req, res, next) => {\n      // Skip if dashboard is disabled\n      if (!this.dashboardConfig.enabled) {\n        return res.status(403).json({ error: 'Dashboard is disabled' });\n      }\n\n      const authConfig = this.dashboardConfig.auth || {};\n      const authType = authConfig.type || 'none';\n      if (authType === 'none') return next();\n\n      try {\n        const key = ipKeyGenerator(req.ip || '');\n        const seen = this.authFailures.get(key);\n",
        mutant: "    return async (req, res, next) => {\n      // Skip if dashboard is disabled\n      if (!this.dashboardConfig.enabled) {\n        return res.status(403).json({ error: 'Dashboard is disabled' });\n      }\n\n      const authConfig = this.dashboardConfig.auth || {};\n      const authType = authConfig.type || 'none';\n      if (authType === 'none') return next();\n\n      try {\n        const key = ipKeyGenerator(req.ip || '');\n        const seen = this.authFailures.get(key);\n        await null;\n",
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
        // #295 review round 2, M3 widened the guard from `binding.earlyDays`
        // alone to `effectiveEarlyDays` (Math.max with LINKED_EARLY_WINDOW_DAYS);
        // this anchor was retargeted to match, since the old text no longer
        // appears in the file at all (a stale anchor tests nothing).
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
        anchor: '  return calendarDaysBetween(now, latest.recordedAt, timezone) >= remindEveryDays;',
        mutant: '  return true;',
        tests: 'scheduleAlertDelivery'
    },
    {
        id: '258-ruleUnmatched-reminder-uses-configured-interval', ticket: '#258',
        desc: 'ruleUnmatched reminders stop using the fixed 1-day interval and instead honor (or skip, when unset) the rule\'s own remindEveryDays',
        file: 'src/lib/scheduleAlertDelivery.js',
        anchor: "  const remindEveryDays = event.event === 'ruleUnmatched' ? 1 : rule.remindEveryDays;",
        mutant: '  const remindEveryDays = rule.remindEveryDays;',
        tests: 'scheduleAlertDelivery'
    },
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
        anchor: '                    compileTemplateSet({ templates, variables: VARIABLES, channels: modes });',
        mutant: '                    void 0;',
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
        anchor: '                if (rule.channels && rule.channels.length && ruleChannels.length === 0) {',
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
        anchor: "        const candidate = strictLinked\n          || inWindow.find((c) => amountMatchesSchedule(c.tx.amount, schedule, tolerancePct))\n          || closestLinked\n          // Wrong-amount fallback (M11): only take a candidate that is not a\n          // better, correctly-amounted match for some OTHER bound schedule\n          // (#295 review round 2, M1).\n          || inWindow.find((c) => !betterMatchedElsewhere(c.tx, schedule, tolerancePct, bindings))\n          || null;",
        mutant: '        const candidate = inWindow[0] || null;',
        tests: 'scheduleAlerts.test'
    },
    {
        id: '258-m12-linked-early-window-not-widened', ticket: '#258',
        desc: "a linked transaction's early window goes back to the rule's own (possibly narrower) earlyDays instead of Actual's +/-2 day linking tolerance",
        file: 'src/lib/scheduleAlerts.js',
        anchor: "        const earlyStartLinked = day.clone().subtract(Math.max(binding.earlyDays, LINKED_EARLY_WINDOW_DAYS), 'days');",
        mutant: '        const earlyStartLinked = earlyStart;',
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
        anchor: '    return !resolvedRow;',
        mutant: '    return true;',
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
        anchor: "          ${filterChannel ? 'AND (channel IS ? OR channel IS NULL)' : ''}",
        mutant: "          ${filterChannel ? 'AND channel IS ?' : ''}",
        tests: 'syncHistory.test'
    },
    {
        id: '258-r2-m7-startup-template-check-ignores-rule-channels', ticket: '#258',
        desc: 'startup template validation goes back to compiling every rule against every channel mode, so a Telegram-only literal-markup restriction rejects a valid template for a rule that can only ever reach slack/email',
        file: 'src/lib/configLoader.js',
        anchor: '                const ruleChannels = resolveChannels(rule, sender);',
        mutant: "                const ruleChannels = ['telegram', 'email', 'slack', 'discord', 'webhook', 'ntfy'];",
        tests: 'configLoader.test'
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

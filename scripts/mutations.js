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
        anchor: '    const looksLikeSection = (v) => v && typeof v === \'object\' && !Array.isArray(v) &&',
        mutant: '    const looksLikeSection = (v) => true && v !== undefined &&',
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
    }
];

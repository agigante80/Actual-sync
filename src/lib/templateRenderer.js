/**
 * Message template rendering (#257).
 *
 * User-configurable notification wording, built on Handlebars - the same
 * engine and `{{ variable }}` syntax Actual Budget uses for rule action
 * templates, so Actual users already know it. This is infrastructure: it does
 * not read config or send anything by itself. #258 is the first consumer.
 *
 * Validation is AST-based, not a sample render. A sample render misses names
 * used inside helper arguments (`{{default nmae "-"}}`), names used only in a
 * false `#if` branch, and names used only inside an `#each` body that happens
 * to be empty at render time. `validateTemplate` instead walks
 * `Handlebars.parse(source)` and checks every name that could ever be looked
 * up, regardless of whether a given render would actually reach it.
 *
 * Security model: an isolated `Handlebars.create()` environment registers only
 * four helpers (`eq`, `default`, `upper`, `lower`); `lookup` and `log` are
 * explicitly unregistered because they otherwise survive `knownHelpersOnly`
 * (Handlebars treats any already-registered helper as "known" regardless of
 * the `knownHelpers` hint). No partials are registered and none may be used.
 * The actual enforcement, though, is `validateTemplate`'s AST whitelist: a
 * template can only ever reference a name from the caller's `variables` list,
 * `this`, an `@data` variable, or a block param introduced by `#each`/`#with`
 * in scope - so a config secret that was never added to that list can never be
 * reached from a template, however it is written.
 */
const Handlebars = require('handlebars');
const { escapeSlack, escapeDiscordMarkdown, truncateTelegramHtml } = require('./channelEscape');

/** Handlebars built-in block helpers this templating layer allows. */
const BUILTIN_BLOCK_HELPERS = new Set(['if', 'unless', 'each', 'with']);

/** Inline helpers registered on the isolated environment. */
const KNOWN_HELPERS = new Set(['eq', 'default', 'upper', 'lower']);

/**
 * HTML tags Telegram's HTML `parse_mode` accepts. Anything else in a
 * template's literal text is markup Telegram would reject at send time (400).
 */
const ALLOWED_TELEGRAM_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);

/** Thrown by `validateTemplate` for every kind of invalid template. */
class TemplateValidationError extends Error {
  /**
   * @param {Object} details
   * @param {string} details.key - the template key, for a useful error message
   * @param {string} details.token - the offending name/character
   * @param {number} details.line - 1-based line number in the template source
   * @param {'unknown_variable'|'unknown_helper'|'parse_error'|'telegram_markup'} details.reason
   */
  constructor({ key, token, line, reason }) {
    super(`Template "${key}" is invalid (${reason}): "${token}" at line ${line}`);
    this.name = 'TemplateValidationError';
    this.key = key;
    this.token = token;
    this.line = line;
    this.reason = reason;
  }
}

function fail(key, token, line, reason) {
  throw new TemplateValidationError({ key, token, line, reason });
}

/**
 * Check a template's literal text against Telegram's HTML rules: a bare `&`
 * or `<` outside of one of the allowed tags is markup Telegram would reject at
 * send time. Escaping happens at render time for VALUES (Handlebars) - this
 * only guards the literal text the operator typed into the template itself.
 *
 * @param {string} key
 * @param {import('handlebars').AST.ContentStatement} node
 */
function checkTelegramMarkup(key, node) {
  const text = node.value;
  let line = node.loc.start.line;
  let i = 0;
  const tagRe = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s+[a-zA-Z-]+(?:="[^"]*")?)*\s*>/;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === '<') {
      const match = tagRe.exec(text.slice(i));
      if (match && ALLOWED_TELEGRAM_TAGS.has(match[1].toLowerCase())) {
        line += (match[0].match(/\n/g) || []).length;
        i += match[0].length;
        continue;
      }
      fail(key, '<', line, 'telegram_markup');
    }
    if (ch === '&') {
      fail(key, '&', line, 'telegram_markup');
    }
    i += 1;
  }
}

/**
 * Validate a template source by walking its Handlebars AST. Every name a
 * lookup could ever reach must be a documented variable, a whitelisted
 * helper, `this`, an `@data` variable, or a block param currently in scope.
 *
 * @param {string} source - the template source
 * @param {Object} opts
 * @param {string} opts.key - the template key, used in error messages
 * @param {string[]} opts.variables - documented variable names this template may use
 * @param {string} [opts.channel] - pass 'telegram' to also check literal markup
 * @returns {void}
 * @throws {TemplateValidationError}
 */
function validateTemplate(source, { key, variables, channel } = {}) {
  const allowedVars = new Set(variables || []);
  let ast;
  try {
    ast = Handlebars.parse(source);
  } catch (err) {
    const match = /Parse error on line (\d+)/.exec(err.message);
    fail(key, err.message.split('\n')[0], match ? Number(match[1]) : 1, 'parse_error');
    return; // unreachable, fail() always throws - keeps control flow explicit
  }

  const checkPath = (node, scopeVars) => {
    if (node.data) return; // @index, @key, @root, ...
    if (node.parts.length === 0) return; // `this`
    const root = node.parts[0];
    if (scopeVars.has(root) || allowedVars.has(root)) return;
    fail(key, root, node.loc.start.line, 'unknown_variable');
  };

  const checkHelperName = (pathNode) => {
    const name = pathNode.parts[0];
    if (!KNOWN_HELPERS.has(name)) {
      fail(key, name, pathNode.loc.start.line, 'unknown_helper');
    }
  };

  const walkHash = (hash, scopeVars) => {
    if (!hash) return;
    for (const pair of hash.pairs) walkExpression(pair.value, scopeVars);
  };

  const walkExpression = (node, scopeVars) => {
    if (!node) return;
    if (node.type === 'PathExpression') {
      checkPath(node, scopeVars);
    } else if (node.type === 'SubExpression') {
      checkHelperName(node.path);
      for (const param of node.params) walkExpression(param, scopeVars);
      walkHash(node.hash, scopeVars);
    }
    // StringLiteral / NumberLiteral / BooleanLiteral / UndefinedLiteral /
    // NullLiteral need no check - they cannot reach outside the template.
  };

  const walkProgram = (program, scopeVars) => {
    if (!program) return;
    const childScope = new Set(scopeVars);
    for (const blockParam of program.blockParams || []) childScope.add(blockParam);
    for (const statement of program.body) walkStatement(statement, childScope);
  };

  const walkStatement = (statement, scopeVars) => {
    switch (statement.type) {
      case 'ContentStatement':
        if (channel === 'telegram') checkTelegramMarkup(key, statement);
        break;
      case 'CommentStatement':
        break;
      case 'MustacheStatement': {
        const isHelperCall = statement.params.length > 0
          || (statement.hash && statement.hash.pairs.length > 0);
        if (isHelperCall) {
          checkHelperName(statement.path);
          for (const param of statement.params) walkExpression(param, scopeVars);
          walkHash(statement.hash, scopeVars);
        } else {
          checkPath(statement.path, scopeVars);
        }
        break;
      }
      case 'BlockStatement': {
        const name = statement.path.parts[0];
        if (!BUILTIN_BLOCK_HELPERS.has(name)) {
          fail(key, name, statement.path.loc.start.line, 'unknown_helper');
        }
        for (const param of statement.params) walkExpression(param, scopeVars);
        walkHash(statement.hash, scopeVars);
        walkProgram(statement.program, scopeVars);
        walkProgram(statement.inverse, scopeVars);
        break;
      }
      case 'PartialStatement':
      case 'PartialBlockStatement':
        // No partials in v1 (see module docs) - a partial reference is always invalid.
        fail(key, statement.name && statement.name.original || 'partial', statement.loc.start.line, 'unknown_helper');
        break;
      default:
        break;
    }
  };

  walkProgram(ast, new Set());
}

/** Inline helper implementations for the isolated Handlebars environment. */
const HELPER_FNS = {
  eq: (a, b) => a === b,
  default: (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value),
  upper: (value) => String(value).toUpperCase(),
  lower: (value) => String(value).toLowerCase()
};

/**
 * Per-channel compile/render mode (see docs/NOTIFICATIONS.md "Message
 * templates" for the full table and the reasoning behind each row).
 *
 * `noEscape: false` leans on Handlebars' own HTML-escaping (Telegram, whose
 * entities double as valid Telegram HTML, and the email HTML part).
 * `noEscape: true` renders raw text; Slack/Discord then escape the WHOLE
 * rendered string with their own channel-specific escaper, since the operator
 * cannot use platform markup in v1.
 */
const CHANNEL_MODES = {
  telegram: { noEscape: false, postProcess: (text) => truncateTelegramHtml(text) },
  email_html: { noEscape: false },
  email_text: { noEscape: true },
  ntfy: { noEscape: true },
  slack: { noEscape: true, postProcess: escapeSlack },
  discord: { noEscape: true, postProcess: escapeDiscordMarkdown },
  webhook: { noEscape: true }
};

/**
 * Validate a whole set of templates and return a renderer for them.
 *
 * @param {Object} opts
 * @param {Object<string, string>} opts.templates - `{ key: source }`
 * @param {string[]} opts.variables - documented variable names every template may use
 * @param {string[]} opts.channels - channel modes this set will be rendered for
 *   (see `CHANNEL_MODES`); when it includes `'telegram'`, every template is
 *   also checked against Telegram's literal-markup rule.
 * @returns {{ render(key: string, context: Object, channel: string): string }}
 * @throws {TemplateValidationError} if any template fails validation
 */
function compileTemplateSet({ templates, variables, channels }) {
  const sources = templates || {};
  const requestedChannels = new Set(channels || []);

  for (const [key, source] of Object.entries(sources)) {
    validateTemplate(source, { key, variables });
    if (requestedChannels.has('telegram')) {
      validateTemplate(source, { key, variables, channel: 'telegram' });
    }
  }

  const hb = Handlebars.create();
  // Both survive `knownHelpersOnly` otherwise, since Handlebars treats any
  // already-registered helper as known regardless of the `knownHelpers` hint
  // passed to compile() below.
  hb.unregisterHelper('lookup');
  hb.unregisterHelper('log');
  for (const [name, fn] of Object.entries(HELPER_FNS)) hb.registerHelper(name, fn);

  const knownHelpers = { eq: true, default: true, upper: true, lower: true, lookup: false, log: false };
  const compiled = new Map(); // `${key}::${channel}` -> compiled template, per output mode (#257)

  const compileFor = (key, channel) => {
    const cacheKey = `${key}::${channel}`;
    if (compiled.has(cacheKey)) return compiled.get(cacheKey);
    const template = hb.compile(sources[key], {
      strict: true,
      knownHelpersOnly: true,
      knownHelpers,
      noEscape: CHANNEL_MODES[channel].noEscape
    });
    compiled.set(cacheKey, template);
    return template;
  };

  return {
    render(key, context, channel) {
      if (!Object.prototype.hasOwnProperty.call(sources, key)) {
        throw new Error(`Unknown template key: ${key}`);
      }
      if (!requestedChannels.has(channel)) {
        throw new Error(`Channel "${channel}" was not declared to compileTemplateSet`);
      }
      const mode = CHANNEL_MODES[channel];
      const template = compileFor(key, channel);
      let output = template(context || {});
      if (mode.postProcess) output = mode.postProcess(output);
      return output;
    }
  };
}

module.exports = { validateTemplate, compileTemplateSet, TemplateValidationError };

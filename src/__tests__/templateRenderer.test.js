/**
 * Tests for src/lib/templateRenderer.js (#257)
 */

const { validateTemplate, compileTemplateSet, TemplateValidationError } = require('../lib/templateRenderer');

describe('validateTemplate', () => {
  describe('positive cases', () => {
    test('a template using only documented variables passes', () => {
      expect(() => {
        validateTemplate('{{name}} due {{deadline}}', { key: 'missing', variables: ['name', 'deadline'] });
      }).not.toThrow();
    });

    test('eq and default helpers with plain params pass', () => {
      expect(() => {
        validateTemplate('{{#if (eq status "ok")}}fine{{else}}{{default note "-"}}{{/if}}', {
          key: 'status',
          variables: ['status', 'note']
        });
      }).not.toThrow();
    });

    test('block helpers if/unless/each/with pass, including block params in scope', () => {
      const source = '{{#each accounts as |account|}}{{account.name}}{{/each}}{{#with owner as |o|}}{{o}}{{/with}}';
      expect(() => {
        validateTemplate(source, { key: 'accounts', variables: ['accounts', 'owner'] });
      }).not.toThrow();
    });

    test('`this` and @index need no variable declaration', () => {
      expect(() => {
        validateTemplate('{{#each items}}{{@index}}: {{this}}{{/each}}', { key: 'items', variables: ['items'] });
      }).not.toThrow();
    });

    test('@key, @first and @last need no variable declaration', () => {
      expect(() => {
        validateTemplate('{{#each items}}{{@key}} {{@first}} {{@last}}{{/each}}', {
          key: 'items',
          variables: ['items']
        });
      }).not.toThrow();
    });

    test('a dotted path rooted at an in-scope block param passes', () => {
      expect(() => {
        validateTemplate('{{#each accounts as |account|}}{{account.name}}{{/each}}', {
          key: 'accounts',
          variables: ['accounts']
        });
      }).not.toThrow();
    });
  });

  describe('negative cases (spec scenarios)', () => {
    test('an unknown variable throws unknown_variable with the token and line', () => {
      expect.assertions(4);
      try {
        validateTemplate('{{nmae}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateValidationError);
        expect(err.key).toBe('missing');
        expect(err.token).toBe('nmae');
        expect(err.line).toBe(1);
      }
    });

    test('an unknown name used as a helper argument throws unknown_variable', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{default nmae "-"}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('nmae');
      }
    });

    test('an unknown name used only in a false #if branch still throws', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{#if flag}}{{name}}{{else}}{{nmae}}{{/if}}', {
          key: 'missing',
          variables: ['flag', 'name']
        });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('nmae');
      }
    });

    test('an unknown name used only inside an #each body still throws', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{#each items}}{{nmae}}{{/each}}', { key: 'missing', variables: ['items'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('nmae');
      }
    });

    test('lookup is rejected as an unknown helper', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{lookup this "constructor"}}', { key: 'missing', variables: [] });
      } catch (err) {
        expect(err.reason).toBe('unknown_helper');
        expect(err.token).toBe('lookup');
      }
    });

    test('log is rejected as an unknown helper', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{log this}}', { key: 'missing', variables: [] });
      } catch (err) {
        expect(err.reason).toBe('unknown_helper');
        expect(err.token).toBe('log');
      }
    });

    test('an unclosed block throws parse_error with the line', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{#if name}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('parse_error');
        expect(err.line).toBeGreaterThanOrEqual(1);
      }
    });

    test('an unregistered custom helper name throws unknown_helper', () => {
      expect.assertions(1);
      try {
        validateTemplate('{{customHelp foo}}', { key: 'missing', variables: ['foo'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_helper');
      }
    });

    test('a partial reference always throws unknown_helper', () => {
      expect.assertions(1);
      try {
        validateTemplate('{{> somePartial}}', { key: 'missing', variables: [] });
      } catch (err) {
        expect(err.reason).toBe('unknown_helper');
      }
    });
  });

  describe('__proto__ / constructor are never reachable', () => {
    test('__proto__ is not an implicitly allowed name', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{__proto__}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('__proto__');
      }
    });

    test('constructor is not an implicitly allowed name', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{constructor}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('constructor');
      }
    });
  });

  // H1 (#257 review): `if (node.data) return;` let any @data path skip the
  // whitelist entirely, so @root (the whole render context, secrets
  // included) and a mistyped @data name both slipped past validation.
  describe('only @index/@key/@first/@last are reachable data variables', () => {
    test('@root is rejected as unknown_variable, not allowed through', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{@root}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('@root');
      }
    });

    test('a dotted @root path used to reach outside the whitelist is rejected', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{@root.telegram.botToken}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('@root.telegram.botToken');
      }
    });

    test('a misspelled @data variable is rejected at validation time, not left to throw at render', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{@nmae}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('@nmae');
      }
    });
  });

  // H3 (#257 review): only parts[0] of a dotted path was ever checked, so
  // `{{name.length}}`, `{{name.constructor}}` and similar passed validation
  // and then threw (or worse, walked the prototype chain) at render time.
  describe('a dotted path is only reachable through an in-scope block param', () => {
    test('a dotted path off a plain whitelisted variable is rejected', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{name.length}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('name.length');
      }
    });

    test('constructor reached through a dotted path is rejected', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{name.constructor}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('name.constructor');
      }
    });

    test('constructor.name reached through a whitelisted list variable is rejected', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{items.constructor.name}}', { key: 'missing', variables: ['items'] });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('items.constructor.name');
      }
    });

    test('a dangerous property name is rejected even off an in-scope block param', () => {
      expect.assertions(2);
      try {
        validateTemplate('{{#each accounts as |account|}}{{account.__proto__}}{{/each}}', {
          key: 'accounts',
          variables: ['accounts']
        });
      } catch (err) {
        expect(err.reason).toBe('unknown_variable');
        expect(err.token).toBe('account.__proto__');
      }
    });
  });

  // M3 (#257 review): a literal in mustache/helper/block position
  // (`{{"&"}}`, `{{1}}`, `{{#"x"}}...{{/"x"}}`) has no `.parts`/`.data`
  // fields, so the AST walk crashed with a raw TypeError instead of a clean
  // TemplateValidationError.
  describe('a literal expression fails cleanly instead of crashing the validator', () => {
    test('a string literal in mustache position is a parse_error', () => {
      expect.assertions(1);
      try {
        validateTemplate('{{"&"}}', { key: 'missing', variables: [] });
      } catch (err) {
        expect(err.reason).toBe('parse_error');
      }
    });

    test('a number literal in mustache position is a parse_error', () => {
      expect.assertions(1);
      try {
        validateTemplate('{{1}}', { key: 'missing', variables: [] });
      } catch (err) {
        expect(err.reason).toBe('parse_error');
      }
    });

    test('a string literal used as a block name is a parse_error', () => {
      expect.assertions(1);
      try {
        validateTemplate('{{#"x"}}y{{/"x"}}', { key: 'missing', variables: [] });
      } catch (err) {
        expect(err.reason).toBe('parse_error');
      }
    });

    test('a string literal used as a helper is a parse_error', () => {
      expect.assertions(1);
      try {
        validateTemplate('{{"foo" name}}', { key: 'missing', variables: ['name'] });
      } catch (err) {
        expect(err.reason).toBe('parse_error');
      }
    });
  });

  describe('Telegram literal markup (channel: telegram)', () => {
    test('a bare & in literal text throws telegram_markup', () => {
      expect.assertions(2);
      try {
        validateTemplate('Rent & fees', { key: 'reminder', variables: [], channel: 'telegram' });
      } catch (err) {
        expect(err.reason).toBe('telegram_markup');
        expect(err.token).toBe('&');
      }
    });

    test('a bare < throws telegram_markup', () => {
      expect.assertions(1);
      try {
        validateTemplate('a < b', { key: 'reminder', variables: [], channel: 'telegram' });
      } catch (err) {
        expect(err.reason).toBe('telegram_markup');
      }
    });

    test('a disallowed tag throws telegram_markup', () => {
      expect.assertions(1);
      try {
        validateTemplate('<script>x</script>', { key: 'reminder', variables: [], channel: 'telegram' });
      } catch (err) {
        expect(err.reason).toBe('telegram_markup');
      }
    });

    test('an allowed tag around a variable passes', () => {
      expect(() => {
        validateTemplate('<b>{{name}}</b>', { key: 'reminder', variables: ['name'], channel: 'telegram' });
      }).not.toThrow();
    });

    test('without channel: telegram, the same literal & is not checked', () => {
      expect(() => {
        validateTemplate('Rent & fees', { key: 'reminder', variables: [] });
      }).not.toThrow();
    });
  });
});

describe('compileTemplateSet / render', () => {
  test('renders one string per requested channel', () => {
    const { render } = compileTemplateSet({
      templates: { greeting: 'Hello {{name}}' },
      variables: ['name'],
      channels: ['telegram', 'email_text', 'slack']
    });

    expect(render('greeting', { name: 'World' }, 'telegram')).toBe('Hello World');
    expect(render('greeting', { name: 'World' }, 'email_text')).toBe('Hello World');
    expect(render('greeting', { name: 'World' }, 'slack')).toBe('Hello World');
  });

  test('eq and default operate on raw values, before any escaping', () => {
    const { render } = compileTemplateSet({
      templates: { line: '{{#if (eq status "ok")}}OK{{else}}{{default note "no note"}}{{/if}}' },
      variables: ['status', 'note'],
      channels: ['email_text']
    });

    expect(render('line', { status: 'ok' }, 'email_text')).toBe('OK');
    expect(render('line', { status: 'bad', note: undefined }, 'email_text')).toBe('no note');
    expect(render('line', { status: 'bad', note: 'kept' }, 'email_text')).toBe('kept');
  });

  test('upper on "Bob & Co" HTML-escapes for Telegram but not for ntfy', () => {
    const { render } = compileTemplateSet({
      templates: { payee: '{{upper payee}}' },
      variables: ['payee'],
      channels: ['telegram', 'ntfy']
    });

    expect(render('payee', { payee: 'Bob & Co' }, 'telegram')).toBe('BOB &amp; CO');
    expect(render('payee', { payee: 'Bob & Co' }, 'ntfy')).toBe('BOB & CO');
  });

  test('a raw <b>x</b> value is escaped for both Telegram and Slack', () => {
    const { render } = compileTemplateSet({
      templates: { line: '{{value}}' },
      variables: ['value'],
      channels: ['telegram', 'slack']
    });

    expect(render('line', { value: '<b>x</b>' }, 'telegram')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(render('line', { value: '<b>x</b>' }, 'slack')).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  test('discord escapes the whole rendered output', () => {
    const { render } = compileTemplateSet({
      templates: { line: '{{value}}' },
      variables: ['value'],
      channels: ['discord']
    });

    expect(render('line', { value: '*bold* text' }, 'discord')).toBe('\\*bold\\* text');
  });

  test('compileTemplateSet validates every template up front, including telegram markup when requested', () => {
    expect(() => {
      compileTemplateSet({
        templates: { bad: 'Rent & fees' },
        variables: [],
        channels: ['telegram']
      });
    }).toThrow(TemplateValidationError);
  });

  test('rendering an unknown key throws', () => {
    const { render } = compileTemplateSet({
      templates: { known: 'hi' },
      variables: [],
      channels: ['email_text']
    });
    expect(() => render('unknown', {}, 'email_text')).toThrow('Unknown template key');
  });

  test('rendering an undeclared channel throws', () => {
    const { render } = compileTemplateSet({
      templates: { known: 'hi' },
      variables: [],
      channels: ['email_text']
    });
    expect(() => render('known', {}, 'slack')).toThrow('was not declared');
  });

  test('no config secret key is reachable from the render context', () => {
    // A consumer must explicitly whitelist every variable a template may use.
    // Even if the render context object happens to carry extra fields (for
    // example because a caller passed the whole config by mistake), a
    // template that never declared them as a variable cannot reach them:
    // validateTemplate rejects the reference before compilation ever runs.
    const configLikeContext = {
      name: 'Alice',
      telegram: { botToken: '123:SECRET', chatId: '1' },
      email: { auth: { pass: 'hunter2' } }
    };

    expect(() => {
      validateTemplate('{{telegram.botToken}}', { key: 'leak', variables: ['name'] });
    }).toThrow(TemplateValidationError);

    expect(() => {
      validateTemplate('{{email.auth.pass}}', { key: 'leak', variables: ['name'] });
    }).toThrow(TemplateValidationError);

    // @root is the whole render context: without the H1 fix this reached the
    // same secret through Handlebars' built-in data variable instead of a
    // whitelisted variable name (#257 review).
    expect(() => {
      validateTemplate('{{@root.telegram.botToken}}', { key: 'leak', variables: ['name'] });
    }).toThrow(TemplateValidationError);

    // Only a template that explicitly declares `name` as a variable can ever
    // compile, and it renders only the whitelisted field, never a sibling.
    const { render } = compileTemplateSet({
      templates: { greeting: 'Hi {{name}}' },
      variables: ['name'],
      channels: ['email_text']
    });
    const output = render('greeting', configLikeContext, 'email_text');
    expect(output).toBe('Hi Alice');
    expect(output).not.toMatch(/SECRET|hunter2/);
  });
});

/**
 * Test-only template consumer (#257).
 *
 * No config key exists yet for user-configurable templates: the first real
 * consumer is #258. This fixture stands in for that future caller so
 * templatedDelivery.test.js can exercise the full path from a template
 * source, through compileTemplateSet's validation, to
 * NotificationService.sendTemplated's delivery, without inventing a second
 * copy of that wiring inside the test file itself.
 *
 * A consumer template set here always uses the variable `name` and `amount`,
 * standing in for whatever fields #258's overdue-payment alert will define.
 */

const { compileTemplateSet } = require('../../lib/templateRenderer');

const VARIABLES = ['name', 'amount'];
const CHANNELS = ['telegram', 'email_text', 'email_html', 'webhook', 'discord'];

/**
 * Build channel outputs for NotificationService.sendTemplated from a set of
 * template sources and a render context.
 *
 * Throws TemplateValidationError if any template in `templates` is invalid;
 * this happens before any delivery attempt, so an invalid template set never
 * causes a single request to be sent.
 *
 * @param {Object} templates - `{ message: source }`, at minimum
 * @param {Object} context - `{ name, amount }`
 * @returns {Object} channelOutputs, ready for NotificationService.sendTemplated
 */
function buildChannelOutputs(templates, context) {
  const { render } = compileTemplateSet({ templates, variables: VARIABLES, channels: CHANNELS });

  const html = render('message', context, 'telegram');
  const plain = render('message', context, 'email_text');

  return {
    telegram: { html, plain },
    email: {
      subject: 'Template test',
      text: plain,
      html: render('message', context, 'email_html')
    },
    webhook: {
      url: null, // filled in by the caller once the fake server URL is known
      text: render('message', context, 'webhook'),
      fields: { name: context.name, amount: context.amount }
    },
    discord: {
      url: null, // filled in by the caller once the fake server URL is known
      text: render('message', context, 'discord')
    }
  };
}

module.exports = { buildChannelOutputs, VARIABLES, CHANNELS };

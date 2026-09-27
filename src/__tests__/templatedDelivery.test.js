/**
 * Service-level delivery tests for NotificationService.sendTemplated (#257).
 *
 * A local fake-channel HTTP server stands in for both Telegram and a generic
 * webhook endpoint (routed by path), recording every request it receives.
 * The Telegram leg is reached through the telegramApiBaseUrl constructor
 * option: the option exists purely as this test seam. Email delivery is
 * exercised through the same mocked-nodemailer pattern the rest of the
 * notificationService test suite uses.
 *
 * templateConsumerFixture.js stands in for #258, the first real consumer of
 * this infrastructure: no config key for user templates exists yet.
 */

const http = require('http');
const nodemailer = require('nodemailer');
const { NotificationService } = require('../services/notificationService');
const { TemplateValidationError } = require('../lib/templateRenderer');
const { buildChannelOutputs } = require('./helpers/templateConsumerFixture');

jest.mock('nodemailer');

describe('sendTemplated delivery (#257)', () => {
  let server;
  let baseUrl;
  let received;
  /** Status codes the fake Telegram route returns, one per call, then 200 forever. */
  let telegramStatusQueue;
  let mockTransporter;

  beforeEach((done) => {
    jest.clearAllMocks();
    received = [];
    telegramStatusQueue = [];

    mockTransporter = { sendMail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' }) };
    nodemailer.createTransport.mockReturnValue(mockTransporter);

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body });
        if (req.url.startsWith('/bot')) {
          const status = telegramStatusQueue.length ? telegramStatusQueue.shift() : 200;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(status === 200 ? JSON.stringify({ ok: true }) : JSON.stringify({ ok: false, description: 'fake failure' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  function makeService(overrides = {}) {
    return new NotificationService(
      {
        telegram: { enabled: true, botToken: '123:ABC', chatId: '1' },
        email: { enabled: true, from: 'a@b.c', to: ['d@e.f'] },
        ...overrides
      },
      {},
      { telegramApiBaseUrl: baseUrl }
    );
  }

  test('a valid template set delivers to Telegram (HTML + parse_mode, escaped values), email, and webhook (text + raw fields)', async () => {
    const service = makeService();
    const outputs = buildChannelOutputs(
      { message: '{{upper name}} owes {{amount}}' },
      { name: 'bob & co', amount: '€80.00' }
    );
    outputs.webhook.url = `${baseUrl}/webhook`;

    const results = await service.sendTemplated(outputs);

    expect(results.telegram).toEqual({ ok: true, statusCode: 200 });
    expect(results.email).toEqual({ success: true, messageId: 'test-message-id' });
    expect(results.webhook).toEqual({ success: true });

    const telegramReq = received.find((r) => r.url.startsWith('/bot'));
    const telegramBody = JSON.parse(telegramReq.body);
    expect(telegramBody.parse_mode).toBe('HTML');
    // Handlebars HTML-escapes the raw "bob & co" value before upper() sees it
    // in the AST walk sense, but upper() runs on the raw value and escaping
    // happens at render time: the & in the final HTML output is escaped.
    expect(telegramBody.text).toBe('BOB &amp; CO owes €80.00');

    const webhookReq = received.find((r) => r.url === '/webhook');
    const webhookBody = JSON.parse(webhookReq.body);
    expect(webhookBody.text).toBe('BOB & CO owes €80.00');
    expect(webhookBody.name).toBe('bob & co');
    expect(webhookBody.amount).toBe('€80.00');

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const emailArgs = mockTransporter.sendMail.mock.calls[0][0];
    expect(emailArgs.text).toBe('BOB & CO owes €80.00');
  });

  // M5 (#257 review): the previous version of this test only asserted that
  // buildChannelOutputs itself throws, and never called sendTemplated at all,
  // so it could not tell "sendTemplated sends nothing on a bad template" from
  // "this test forgot to invoke sendTemplated". Wrapping the real two-step
  // caller flow (build, then send) in one async function and awaiting its
  // rejection exercises the actual path and still proves zero requests go out.
  test('an invalid template throws before any request is sent', async () => {
    const service = makeService();
    const runFlow = async () => {
      const outputs = buildChannelOutputs({ message: '{{nmae}}' }, { name: 'bob', amount: '1' });
      return service.sendTemplated(outputs);
    };

    await expect(runFlow()).rejects.toThrow(TemplateValidationError);
    expect(received).toHaveLength(0);
  });

  // M4 (#257 review): 'Bob' has no characters HTML-escapes, so the previous
  // version of this test could not actually distinguish the escaped HTML
  // request from the raw plain-text one; a bug that sent html twice, or
  // plain twice, would still have passed. 'Bob & Co' makes the two renders
  // different strings, so each request's text is checked against the render
  // it must have come from.
  test('a Telegram 400 triggers exactly one retry without parse_mode, with a WARN logged', async () => {
    telegramStatusQueue = [400];
    const service = makeService();
    const warnSpy = jest.spyOn(service.logger, 'warn');
    const outputs = buildChannelOutputs({ message: 'Hi {{name}}' }, { name: 'Bob & Co', amount: '1' });

    const result = await service._sendTemplatedTelegram(outputs.telegram);

    expect(result).toEqual({ ok: true, statusCode: 200 });
    const telegramReqs = received.filter((r) => r.url.startsWith('/bot'));
    expect(telegramReqs).toHaveLength(2);
    expect(JSON.parse(telegramReqs[0].body).parse_mode).toBe('HTML');
    expect(JSON.parse(telegramReqs[0].body).text).toBe('Hi Bob &amp; Co');
    expect(JSON.parse(telegramReqs[1].body)).not.toHaveProperty('parse_mode');
    expect(JSON.parse(telegramReqs[1].body).text).toBe('Hi Bob & Co');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/400/), expect.any(Object));
  });

  // M1 (#257 review): the 400 fallback used to send `plain ?? html` untruncated.
  // A plain render past Telegram's 4096-code-point limit, with an astral
  // character straddling the cut, previously risked an ill-formed string;
  // truncateCodePoints must produce a well-formed 4096-code-point string.
  test('a Telegram 400 fallback is truncated to 4096 code points, surrogate-safe', async () => {
    telegramStatusQueue = [400];
    const service = makeService();
    const longPlain = 'a'.repeat(4095) + '\u{1F600}\u{1F600}'; // emoji pair straddles the 4096 cut
    const html = 'irrelevant html, only the 400 fallback matters here';

    const result = await service._sendTemplatedTelegram({ html, plain: longPlain });

    expect(result).toEqual({ ok: true, statusCode: 200 });
    const telegramReqs = received.filter((r) => r.url.startsWith('/bot'));
    const fallbackText = JSON.parse(telegramReqs[1].body).text;
    expect([...fallbackText]).toHaveLength(4096);
    expect(fallbackText.isWellFormed()).toBe(true);
  });

  test('a Telegram 500 is not retried and the result is a failure', async () => {
    telegramStatusQueue = [500];
    const service = makeService();
    const outputs = buildChannelOutputs({ message: 'Hi {{name}}' }, { name: 'Bob', amount: '1' });

    const result = await service._sendTemplatedTelegram(outputs.telegram);

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(500);
    const telegramReqs = received.filter((r) => r.url.startsWith('/bot'));
    expect(telegramReqs).toHaveLength(1);
  });

  // M2 (#257 review): a rendered value the operator never vetted (a payee
  // name, say) must not be able to ping @everyone/@here/a user id. Discord's
  // own allowed_mentions gate is the authoritative fix; escapeDiscordMarkdown's
  // backslash/zero-width-space handling (channelEscape.test.js) is defense in
  // depth on top of it.
  test('a templated Discord send includes allowed_mentions: { parse: [] }', async () => {
    const service = makeService();
    const outputs = buildChannelOutputs({ message: 'Hi {{name}}' }, { name: 'Bob', amount: '1' });
    outputs.discord.url = `${baseUrl}/discord`;
    delete outputs.telegram;
    delete outputs.email;
    delete outputs.webhook;

    const results = await service.sendTemplated(outputs);

    expect(results.discord).toEqual({ success: true });
    const discordReq = received.find((r) => r.url === '/discord');
    const discordBody = JSON.parse(discordReq.body);
    expect(discordBody.allowed_mentions).toEqual({ parse: [] });
  });

  test('an existing caller using sendTelegramMessage still gets false on a fake 500', async () => {
    telegramStatusQueue = [500];
    const service = makeService();

    const ok = await service.sendTelegramMessage('plain message');

    expect(ok).toBe(false);
    const telegramReqs = received.filter((r) => r.url.startsWith('/bot'));
    expect(telegramReqs).toHaveLength(1);
    expect(JSON.parse(telegramReqs[0].body)).not.toHaveProperty('parse_mode');
  });
});

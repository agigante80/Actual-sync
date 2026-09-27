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

  test('an invalid template throws before any request is sent', () => {
    expect(() => {
      buildChannelOutputs({ message: '{{nmae}}' }, { name: 'bob', amount: '1' });
    }).toThrow(TemplateValidationError);

    expect(received).toHaveLength(0);
  });

  test('a Telegram 400 triggers exactly one retry without parse_mode, with a WARN logged', async () => {
    telegramStatusQueue = [400];
    const service = makeService();
    const warnSpy = jest.spyOn(service.logger, 'warn');
    const outputs = buildChannelOutputs({ message: 'Hi {{name}}' }, { name: 'Bob', amount: '1' });

    const result = await service._sendTemplatedTelegram(outputs.telegram);

    expect(result).toEqual({ ok: true, statusCode: 200 });
    const telegramReqs = received.filter((r) => r.url.startsWith('/bot'));
    expect(telegramReqs).toHaveLength(2);
    expect(JSON.parse(telegramReqs[0].body).parse_mode).toBe('HTML');
    expect(JSON.parse(telegramReqs[1].body)).not.toHaveProperty('parse_mode');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/400/), expect.any(Object));
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

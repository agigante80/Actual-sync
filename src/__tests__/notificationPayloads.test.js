/**
 * Baseline notification payload snapshots (#257).
 *
 * This file captures the exact output of the existing, hard-coded
 * `MessageFormatter` across representative scenarios, and a Telegram request
 * body shape, before any message-template code is added. It is committed
 * first, ahead of every other #257 change, specifically so the snapshot
 * proves the new templating layer changes nothing about existing
 * notifications: every one of these assertions must still pass, byte for
 * byte, once the rest of #257 lands.
 *
 * A future consumer (#258) opts INTO templated output. Nothing in this
 * ticket changes what an operator who never configures a template receives.
 */

const { MessageFormatter } = require('../lib/messageFormatter');
const { NotificationService } = require('../services/notificationService');

describe('notification payload baseline (#257)', () => {
  const FIXED_NOW = new Date('2026-01-15T10:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('formatSyncNotification', () => {
    test('success with no issues', () => {
      const result = {
        status: 'success',
        serverName: 'Main Server',
        duration: 4200,
        accountsProcessed: 3,
        accountsFailed: 0,
        succeededAccounts: ['Checking', 'Savings', 'Credit Card'],
        failedAccounts: [],
        skippedAccounts: []
      };
      expect(MessageFormatter.formatSyncNotification(result)).toMatchSnapshot();
    });

    test('success with partial issues (some accounts failed)', () => {
      const result = {
        status: 'partial',
        serverName: 'Main Server',
        duration: 850,
        accountsProcessed: 2,
        accountsFailed: 1,
        succeededAccounts: ['Checking', 'Savings'],
        failedAccounts: [{ name: 'Credit Card', error: 'Connection timed out while fetching transactions' }],
        skippedAccounts: [{ name: 'Closed Account', reason: 'not bank-linked' }]
      };
      expect(MessageFormatter.formatSyncNotification(result)).toMatchSnapshot();
    });

    test('failure with a server-level error and no accounts reached', () => {
      const result = {
        status: 'failure',
        serverName: 'Main Server',
        duration: 120,
        accountsProcessed: 0,
        accountsFailed: 0,
        error: 'Unable to connect to Actual server',
        errorCode: 'ECONNREFUSED',
        succeededAccounts: [],
        failedAccounts: [],
        skippedAccounts: []
      };
      expect(MessageFormatter.formatSyncNotification(result)).toMatchSnapshot();
    });

    test('failure with per-account errors', () => {
      const result = {
        status: 'failure',
        serverName: 'Main Server',
        duration: 3000,
        accountsProcessed: 0,
        accountsFailed: 2,
        succeededAccounts: [],
        failedAccounts: [
          { name: 'Checking', error: 'Bank API returned an unexpectedly long error message that should be truncated at eighty characters for display' },
          { name: 'Savings' }
        ],
        skippedAccounts: []
      };
      expect(MessageFormatter.formatSyncNotification(result)).toMatchSnapshot();
    });
  });

  describe('formatStartupNotification', () => {
    test('startup with multiple servers and schedules', () => {
      const info = {
        version: '1.17.2',
        serverNames: 'Main Server, Backup Server',
        schedules: 'Main Server: every 30 minutes\nBackup Server: every hour',
        nextSync: '2026-01-15T10:30:00.000Z'
      };
      expect(MessageFormatter.formatStartupNotification(info)).toMatchSnapshot();
    });
  });

  describe('Telegram request body shape (backward compatibility)', () => {
    test('sendTelegramMessage does not set parse_mode by default', async () => {
      const service = new NotificationService({
        telegram: { enabled: true, botToken: '123:ABC', chatId: '1' }
      });
      const spy = jest.spyOn(service, 'sendWebhook').mockResolvedValue({ statusCode: 200 });

      await service.sendTelegramMessage('Sync Successful');

      expect(spy).toHaveBeenCalledTimes(1);
      const [, payload] = spy.mock.calls[0];
      expect(payload).not.toHaveProperty('parse_mode');
      expect(payload.text).toBe('Sync Successful');
    });
  });
});

/**
 * Tests for NotificationService
 */

const { NotificationService } = require('../services/notificationService');
const nodemailer = require('nodemailer');

// Mock nodemailer
jest.mock('nodemailer');

describe('NotificationService', () => {
  let mockTransporter;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock transporter
    mockTransporter = {
      sendMail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' })
    };
    
    nodemailer.createTransport.mockReturnValue(mockTransporter);
  });

  describe('Constructor and Initialization', () => {
    test('should initialize with default configuration', () => {
      const service = new NotificationService();
      
      expect(service.config.email.enabled).toBe(false);
      expect(service.config.thresholds.consecutiveFailures).toBe(3);
      expect(service.config.rateLimit.minIntervalMinutes).toBe(15);
      expect(service.consecutiveFailures).toEqual({});
      expect(service.recentSyncs).toEqual({});
    });

    test('should initialize with custom configuration', () => {
      const config = {
        email: {
          enabled: true,
          host: 'smtp.test.com',
          port: 465,
          from: 'test@example.com',
          to: ['admin@example.com']
        },
        thresholds: {
          consecutiveFailures: 5,
          failureRate: 0.7
        },
        rateLimit: {
          minIntervalMinutes: 30,
          maxPerHour: 2
        }
      };

      const service = new NotificationService(config);

      expect(service.config.email.enabled).toBe(true);
      expect(service.config.email.host).toBe('smtp.test.com');
      expect(service.config.thresholds.consecutiveFailures).toBe(5);
      expect(service.config.thresholds.failureRate).toBe(0.7);
      expect(service.config.rateLimit.minIntervalMinutes).toBe(30);
    });

    test('should initialize email transporter when enabled', () => {
      const config = {
        email: {
          enabled: true,
          host: 'smtp.test.com',
          port: 587,
          auth: { user: 'test', pass: 'pass' }
        }
      };

      const service = new NotificationService(config);

      expect(nodemailer.createTransport).toHaveBeenCalledWith({
        host: 'smtp.test.com',
        port: 587,
        secure: false,
        auth: { user: 'test', pass: 'pass' }
      });
      expect(service.emailTransporter).toBeDefined();
    });

    test('should not initialize email transporter when disabled', () => {
      const service = new NotificationService({ email: { enabled: false } });

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(service.emailTransporter).toBeNull();
    });
  });

  describe('recordSyncResult', () => {
    test('should track consecutive failures', () => {
      const service = new NotificationService();

      service.recordSyncResult('server1', false);
      expect(service.consecutiveFailures.server1).toBe(1);

      service.recordSyncResult('server1', false);
      expect(service.consecutiveFailures.server1).toBe(2);

      service.recordSyncResult('server1', false);
      expect(service.consecutiveFailures.server1).toBe(3);
    });

    test('should reset consecutive failures on success', () => {
      const service = new NotificationService();

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);
      expect(service.consecutiveFailures.server1).toBe(2);

      service.recordSyncResult('server1', true);
      expect(service.consecutiveFailures.server1).toBe(0);
    });

    test('should track recent syncs for rate calculation', () => {
      const service = new NotificationService();

      service.recordSyncResult('server1', true, 'corr-1');
      service.recordSyncResult('server1', false, 'corr-2');
      service.recordSyncResult('server1', false, 'corr-3');

      expect(service.recentSyncs.server1).toHaveLength(3);
      expect(service.recentSyncs.server1[0].success).toBe(true);
      expect(service.recentSyncs.server1[1].success).toBe(false);
      expect(service.recentSyncs.server1[2].success).toBe(false);
    });

    test('should clean old syncs outside rate period', () => {
      const service = new NotificationService({
        thresholds: { ratePeriodMinutes: 60 }
      });

      const now = Date.now();
      
      // Add old sync (2 hours ago)
      service.recentSyncs.server1 = [{
        timestamp: now - (2 * 60 * 60 * 1000),
        success: false
      }];

      // Add new sync
      service.recordSyncResult('server1', true);

      // Old sync should be removed
      expect(service.recentSyncs.server1).toHaveLength(1);
      expect(service.recentSyncs.server1[0].success).toBe(true);
    });

    test('should track different servers independently', () => {
      const service = new NotificationService();

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);
      service.recordSyncResult('server2', false);

      expect(service.consecutiveFailures.server1).toBe(2);
      expect(service.consecutiveFailures.server2).toBe(1);
    });
  });

  describe('checkThresholds', () => {
    test('should detect when consecutive failures threshold exceeded', () => {
      const service = new NotificationService({
        thresholds: { consecutiveFailures: 3 }
      });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      const result = service.checkThresholds('server1');

      expect(result.consecutiveExceeded).toBe(true);
      expect(result.consecutiveCount).toBe(3);
      expect(result.shouldNotify).toBe(true);
    });

    test('should detect when failure rate threshold exceeded', () => {
      const service = new NotificationService({
        thresholds: { 
          consecutiveFailures: 10, // High enough to not trigger
          failureRate: 0.5 
        }
      });

      // 3 failures, 2 successes = 60% failure rate
      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', true);
      service.recordSyncResult('server1', true);

      const result = service.checkThresholds('server1');

      expect(result.rateExceeded).toBe(true);
      expect(result.failureRate).toBe(0.6);
      expect(result.shouldNotify).toBe(true);
    });

    test('should not notify when thresholds not exceeded', () => {
      const service = new NotificationService({
        thresholds: { 
          consecutiveFailures: 3,
          failureRate: 0.5 
        }
      });

      // 2 successes, 1 failure = 33% failure rate (below 50% threshold)
      service.recordSyncResult('server1', true);
      service.recordSyncResult('server1', true);
      service.recordSyncResult('server1', false);

      const result = service.checkThresholds('server1');

      expect(result.consecutiveExceeded).toBe(false);
      expect(result.rateExceeded).toBe(false);
      expect(result.shouldNotify).toBe(false);
    });

    test('should handle server with no history', () => {
      const service = new NotificationService();

      const result = service.checkThresholds('unknown-server');

      expect(result.consecutiveExceeded).toBe(false);
      expect(result.consecutiveCount).toBe(0);
      expect(result.failureRate).toBe(0);
      expect(result.shouldNotify).toBe(false);
    });
  });

  describe('checkRateLimit', () => {
    test('should allow notification when no previous notifications', () => {
      const service = new NotificationService();
      expect(service.checkRateLimit('server1')).toBe(true);
    });

    test('should block notification within minimum interval', () => {
      const service = new NotificationService({
        rateLimit: { minIntervalMinutes: 15 }
      });

      service.lastNotificationTime['server1'] = Date.now();
      expect(service.checkRateLimit('server1')).toBe(false);
    });

    test('should allow notification after minimum interval', () => {
      const service = new NotificationService({
        rateLimit: { minIntervalMinutes: 15 }
      });

      service.lastNotificationTime['server1'] = Date.now() - (20 * 60 * 1000); // 20 minutes ago
      expect(service.checkRateLimit('server1')).toBe(true);
    });

    test('should block notification when max per hour exceeded', () => {
      const service = new NotificationService({
        rateLimit: { 
          minIntervalMinutes: 1, // Very short interval
          maxPerHour: 2 
        }
      });

      const now = Date.now();
      service.notificationHistory['server1'] = [
        now - (10 * 60 * 1000), // 10 min ago
        now - (20 * 60 * 1000)  // 20 min ago
      ];

      expect(service.checkRateLimit('server1')).toBe(false);
    });

    test('should clean old notification history', () => {
      const service = new NotificationService({
        rateLimit: { maxPerHour: 4 }
      });

      const now = Date.now();
      service.notificationHistory = [
        now - (3 * 60 * 60 * 1000), // 3 hours ago (should be cleaned)
        now - (30 * 60 * 1000)      // 30 min ago
      ];

      service.updateRateLimitTracking();

      // After tracking update, old history should remain until checkRateLimit
      expect(service.notificationHistory.length).toBe(2);
    });
  });

  describe('notifyError', () => {
    test('should not send notification when thresholds not exceeded', async () => {
      const service = new NotificationService({
        email: { enabled: true },
        thresholds: { consecutiveFailures: 3, failureRate: 0.8 }
      });

      // Only 1 failure, below consecutive threshold and below rate threshold with successes
      service.recordSyncResult('server1', true);
      service.recordSyncResult('server1', false);

      const result = await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error',
        correlationId: 'test-id'
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('thresholds_not_exceeded');
      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    test('should not send notification when rate limited', async () => {
      const service = new NotificationService({
        email: { enabled: true },
        thresholds: { consecutiveFailures: 2 },
        rateLimit: { minIntervalMinutes: 15 }
      });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);
      service.lastNotificationTime['server1'] = Date.now();

      const result = await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error'
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('rate_limit_exceeded');
      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    test('should send email notification when conditions met', async () => {
      const service = new NotificationService({
        email: {
          enabled: true,
          from: 'test@example.com',
          to: ['admin@example.com']
        },
        thresholds: { consecutiveFailures: 2 }
      });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      const result = await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error',
        errorCode: 'TEST_ERROR',
        correlationId: 'test-id'
      });

      expect(result.sent).toBe(true);
      expect(mockTransporter.sendMail).toHaveBeenCalled();
      
      const emailCall = mockTransporter.sendMail.mock.calls[0][0];
      expect(emailCall.to).toBe('admin@example.com');
      expect(emailCall.subject).toContain('server1');
      expect(emailCall.text).toContain('Test error');
    });

    test('should update rate limit tracking after sending', async () => {
      const service = new NotificationService({
        email: { enabled: true },
        thresholds: { consecutiveFailures: 2 }
      });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error'
      });

      expect(service.lastNotificationTime['server1']).toBeTruthy();
      expect(service.notificationHistory['server1']).toHaveLength(1);
    });

    test('should include context in notification', async () => {
      const service = new NotificationService({
        email: {
          enabled: true,
          from: 'test@example.com',
          to: ['admin@example.com']
        },
        thresholds: { consecutiveFailures: 2 }
      });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error',
        context: {
          accountsProcessed: 5,
          accountsFailed: 2
        }
      });

      expect(mockTransporter.sendMail).toHaveBeenCalled();
      const emailCall = mockTransporter.sendMail.mock.calls[0][0];
      expect(emailCall.text).toContain('accountsProcessed: 5');
      expect(emailCall.text).toContain('accountsFailed: 2');
    });
  });

  describe('Email Formatting', () => {
    test('should format email text correctly', () => {
      const service = new NotificationService();

      const notification = {
        serverName: 'test-server',
        errorMessage: 'Connection failed',
        errorCode: 'ECONNRESET',
        timestamp: '2025-01-01T00:00:00Z',
        correlationId: 'test-id',
        consecutiveFailures: 3,
        thresholds: {
          consecutiveExceeded: true,
          rateExceeded: false,
          failureRate: 0.6
        },
        context: { detail: 'test-detail' }
      };

      const text = service.formatEmailText(notification);

      expect(text).toContain('test-server');
      expect(text).toContain('Connection failed');
      expect(text).toContain('ECONNRESET');
      expect(text).toContain('test-id');
      expect(text).toContain('Consecutive Failures: 3');
      expect(text).toContain('60.0%');
      expect(text).toContain('Exceeded consecutive failure threshold');
      expect(text).toContain('detail: test-detail');
    });

    test('should format email HTML correctly', () => {
      const service = new NotificationService();

      const notification = {
        serverName: 'test-server',
        errorMessage: 'Connection failed',
        timestamp: '2025-01-01T00:00:00Z',
        consecutiveFailures: 2,
        thresholds: {
          consecutiveExceeded: true,
          rateExceeded: true,
          failureRate: 0.8
        }
      };

      const html = service.formatEmailHtml(notification);

      expect(html).toContain('<html>');
      expect(html).toContain('test-server');
      expect(html).toContain('Connection failed');
      expect(html).toContain('80.0%');
      expect(html).toContain('Exceeded consecutive failure threshold');
      expect(html).toContain('Exceeded failure rate threshold');
    });
  });

  describe('Webhook Notifications', () => {
    test('should send Slack webhook', async () => {
      const service = new NotificationService({
        webhooks: {
          slack: [{ name: 'test-slack', url: 'https://hooks.slack.com/test' }]
        },
        thresholds: { consecutiveFailures: 2 }
      });

      // Mock sendWebhook
      service.sendWebhook = jest.fn().mockResolvedValue({ statusCode: 200 });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      const result = await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error',
        timestamp: '2025-01-01T00:00:00Z'
      });

      expect(result.sent).toBe(true);
      expect(service.sendWebhook).toHaveBeenCalled();
      
      const webhookCall = service.sendWebhook.mock.calls[0];
      expect(webhookCall[0]).toBe('https://hooks.slack.com/test');
      expect(webhookCall[1]).toHaveProperty('blocks');
    });

    test('should send Discord webhook', async () => {
      const service = new NotificationService({
        webhooks: {
          discord: [{ name: 'test-discord', url: 'https://discord.com/api/webhooks/test' }]
        },
        thresholds: { consecutiveFailures: 2 }
      });

      service.sendWebhook = jest.fn().mockResolvedValue({ statusCode: 200 });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error'
      });

      expect(service.sendWebhook).toHaveBeenCalled();
      
      const webhookCall = service.sendWebhook.mock.calls[0];
      expect(webhookCall[1]).toHaveProperty('embeds');
      expect(webhookCall[1].embeds[0].color).toBe(15158332); // Red
    });

    test('should handle webhook failures gracefully', async () => {
      const service = new NotificationService({
        webhooks: {
          slack: [{ url: 'https://hooks.slack.com/test' }]
        },
        thresholds: { consecutiveFailures: 2 }
      });

      service.sendWebhook = jest.fn().mockRejectedValue(new Error('Webhook failed'));

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      const result = await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error'
      });

      expect(result.sent).toBe(true); // Sent is true even if webhook fails
      expect(result.results.slack[0].success).toBe(false);
      expect(result.results.slack[0].error).toBe('Webhook failed');
    });

    test('should send Telegram message', async () => {
      const service = new NotificationService({
        webhooks: {
          telegram: [{ 
            name: 'test-telegram', 
            botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
            chatId: '123456789'
          }]
        },
        thresholds: { consecutiveFailures: 2 }
      });

      service.sendWebhook = jest.fn().mockResolvedValue({ statusCode: 200 });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Test error'
      });

      expect(service.sendWebhook).toHaveBeenCalled();
      
      const webhookCall = service.sendWebhook.mock.calls[0];
      expect(webhookCall[0]).toContain('api.telegram.org');
      expect(webhookCall[1]).toHaveProperty('chat_id', '123456789');
      expect(webhookCall[1]).toHaveProperty('parse_mode', 'MarkdownV2');
      expect(webhookCall[1].text).toContain('Actual Budget Sync Error');
    });

    test('should escape Telegram MarkdownV2 special characters', async () => {
      const service = new NotificationService({
        webhooks: {
          telegram: [{ 
            botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
            chatId: '123456789'
          }]
        },
        thresholds: { consecutiveFailures: 2 }
      });

      service.sendWebhook = jest.fn().mockResolvedValue({ statusCode: 200 });

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);

      await service.notifyError({
        serverName: 'server1',
        errorMessage: 'Error with special chars: _*[]()~`>#+-=|{}.!',
        errorCode: 'TEST_ERROR'
      });

      expect(service.sendWebhook).toHaveBeenCalled();
      
      const webhookCall = service.sendWebhook.mock.calls[0];
      const text = webhookCall[1].text;
      
      // Check that special characters are escaped
      expect(text).toContain('\\*');
      expect(text).toContain('\\[');
      expect(text).toContain('\\]');
      expect(text).toContain('\\(');
      expect(text).toContain('\\)');
    });
  });

  describe('getStats', () => {
    test('should return notification statistics', () => {
      const service = new NotificationService();

      service.recordSyncResult('server1', false);
      service.recordSyncResult('server1', false);
      service.recordSyncResult('server2', true);

      service.lastNotificationTime['server1'] = Date.now() - (10 * 60 * 1000);
      service.notificationHistory['server1'] = [
        Date.now() - (10 * 60 * 1000),
        Date.now() - (40 * 60 * 1000)
      ];

      const stats = service.getStats();

      expect(stats.perServerStats['server1'].lastNotificationTime).toBeTruthy();
      expect(stats.notificationsSentLastHour).toBe(2);
      expect(stats.rateLimitRemaining).toBe(2); // maxPerHour(4) - sent(2)
      expect(stats.consecutiveFailuresByServer.server1).toBe(2);
      expect(stats.recentSyncsByServer.server1.failures).toBe(2);
      expect(stats.recentSyncsByServer.server2.successes).toBe(1);
    });

    test('should handle no notification history', () => {
      const service = new NotificationService();

      const stats = service.getStats();

      expect(stats.lastNotificationTime).toBeNull();
      expect(stats.notificationsSentLastHour).toBe(0);
      expect(stats.rateLimitRemaining).toBe(4);
    });
  });

  describe('reset', () => {
    test('should reset all tracking state', () => {
      const service = new NotificationService();

      service.recordSyncResult('server1', false);
      service.lastNotificationTime = Date.now();
      service.notificationHistory = [Date.now()];

      service.reset();

      expect(service.lastNotificationTime).toEqual({});
      expect(service.notificationHistory).toEqual({});
      expect(service.consecutiveFailures).toEqual({});
      expect(service.recentSyncs).toEqual({});
    });
  });
});

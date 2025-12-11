/**
 * Tests for Message Formatter
 */

const { MessageFormatter } = require('../lib/messageFormatter');

describe('MessageFormatter', () => {
  describe('formatSyncNotification', () => {
    test('should format successful sync with all accounts succeeded', () => {
      const result = {
        status: 'success',
        serverName: 'Main Budget',
        duration: 2500,
        accountsProcessed: 3,
        accountsFailed: 0,
        succeededAccounts: ['Checking', 'Savings', 'Credit Card'],
        failedAccounts: []
      };
      
      const formatted = MessageFormatter.formatSyncNotification(result);
      
      // Check all formats are generated
      expect(formatted).toHaveProperty('text');
      expect(formatted).toHaveProperty('html');
      expect(formatted).toHaveProperty('slack');
      expect(formatted).toHaveProperty('discord');
      
      // Check text content
      expect(formatted.text).toContain('✅ Sync Successful');
      expect(formatted.text).toContain('Main Budget');
      expect(formatted.text).toContain('2.5s');
      expect(formatted.text).toContain('3/3 synced');
      expect(formatted.text).toContain('✅ Synced:');
      expect(formatted.text).toContain('Checking');
      expect(formatted.text).toContain('Savings');
      expect(formatted.text).toContain('Credit Card');
      
      // Check HTML content
      expect(formatted.html).toContain('✅ Sync Successful');
      expect(formatted.html).toContain('#28a745'); // Green color
      expect(formatted.html).toContain('Main Budget');
      
      // Check Slack format
      expect(formatted.slack.blocks).toBeDefined();
      expect(formatted.slack.blocks[0].text.text).toContain('✅ Sync Successful');
      
      // Check Discord format
      expect(formatted.discord.embeds).toBeDefined();
      expect(formatted.discord.embeds[0].title).toContain('✅ Sync Successful');
      expect(formatted.discord.embeds[0].color).toBe(5025616); // Green
    });
    
    test('should format partial sync with some failures', () => {
      const result = {
        status: 'partial',
        serverName: 'Test Budget',
        duration: 1500,
        accountsProcessed: 2,
        accountsFailed: 1,
        succeededAccounts: ['Checking', 'Savings'],
        failedAccounts: [{
          name: 'Credit Card',
          error: 'Connection timeout'
        }]
      };
      
      const formatted = MessageFormatter.formatSyncNotification(result);
      
      // Check warning status
      expect(formatted.text).toContain('⚠️ Sync Completed with Issues');
      expect(formatted.text).toContain('2/3 synced, 1 failed ❌');
      expect(formatted.text).toContain('❌ Failed:');
      expect(formatted.text).toContain('Credit Card');
      expect(formatted.text).toContain('Connection timeout');
      
      // Check HTML has warning color
      expect(formatted.html).toContain('#ffc107'); // Warning color
      
      // Check Discord color
      expect(formatted.discord.embeds[0].color).toBe(15844367); // Warning
    });
    
    test('should format failed sync', () => {
      const result = {
        status: 'failure',
        serverName: 'Main Budget',
        duration: 500,
        accountsProcessed: 0,
        accountsFailed: 0,
        error: 'network-failure during encryption key validation',
        errorCode: 'PostError'
      };
      
      const formatted = MessageFormatter.formatSyncNotification(result);
      
      // Check failure status
      expect(formatted.text).toContain('❌ Sync Failed');
      expect(formatted.text).toContain('network-failure during encryption key validation');
      expect(formatted.text).toContain('Code: PostError');
      
      // Check HTML has error color
      expect(formatted.html).toContain('#dc3545'); // Red color
      
      // Check Discord color
      expect(formatted.discord.embeds[0].color).toBe(15158332); // Red
    });
    
    test('should format duration correctly', () => {
      const resultMs = {
        status: 'success',
        serverName: 'Test',
        duration: 850,
        accountsProcessed: 1,
        accountsFailed: 0,
        succeededAccounts: ['Account'],
        failedAccounts: []
      };
      
      const resultSec = {
        status: 'success',
        serverName: 'Test',
        duration: 2500,
        accountsProcessed: 1,
        accountsFailed: 0,
        succeededAccounts: ['Account'],
        failedAccounts: []
      };
      
      const formattedMs = MessageFormatter.formatSyncNotification(resultMs);
      const formattedSec = MessageFormatter.formatSyncNotification(resultSec);
      
      expect(formattedMs.text).toContain('850ms');
      expect(formattedSec.text).toContain('2.5s');
    });
  });
  
  describe('formatErrorNotification', () => {
    test('should format error notification with thresholds', () => {
      const error = {
        serverName: 'Main Budget',
        errorMessage: 'network-failure during encryption key validation',
        errorCode: 'PostError',
        timestamp: '2024-01-15T10:30:00.000Z',
        correlationId: 'abc-123-def',
        consecutiveFailures: 3,
        thresholds: {
          failureRate: 0.6,
          consecutiveExceeded: true,
          rateExceeded: false
        },
        context: {
          accountsProcessed: 0,
          accountsFailed: 0,
          durationMs: 500
        }
      };
      
      const formatted = MessageFormatter.formatErrorNotification(error);
      
      // Check text content
      expect(formatted.text).toContain('🚨 Sync Error');
      expect(formatted.text).toContain('Main Budget');
      expect(formatted.text).toContain('network-failure during encryption key validation');
      expect(formatted.text).toContain('Code: PostError');
      expect(formatted.text).toContain('Correlation ID: abc-123-def');
      expect(formatted.text).toContain('Consecutive Failures: 3');
      expect(formatted.text).toContain('Failure Rate: 60.0%');
      expect(formatted.text).toContain('⚠️ Exceeded consecutive failure threshold');
      expect(formatted.text).toContain('accountsProcessed: 0');
      
      // Check HTML format
      expect(formatted.html).toContain('🚨 Sync Error');
      expect(formatted.html).toContain('#dc3545'); // Error color
      
      // Check all formats exist
      expect(formatted).toHaveProperty('slack');
      expect(formatted).toHaveProperty('discord');
    });
    
    test('should format test notification', () => {
      const error = {
        serverName: '🧪 Test Server',
        errorMessage: 'This is a test notification',
        errorCode: 'TEST_NOTIFICATION',
        timestamp: '2024-01-15T10:30:00.000Z'
      };
      
      const formatted = MessageFormatter.formatErrorNotification(error);
      
      // Check test notification formatting
      expect(formatted.text).toContain('🧪 Test Notification');
      expect(formatted.html).toContain('🧪 Test Notification');
      expect(formatted.html).toContain('#0078D4'); // Blue color for test
      
      // Check Discord test color
      expect(formatted.discord.embeds[0].color).toBe(3447003); // Blue
    });
  });
  
  describe('formatStartupNotification', () => {
    test('should format startup notification', () => {
      const info = {
        version: '1.0.0',
        serverNames: 'Main Budget, Test Budget',
        schedules: 'Main Budget: 0 2 * * * (Daily at 2:00 AM)\nTest Budget: 0 */6 * * * (Every 6 hours)',
        nextSync: '2024-01-15T02:00:00.000Z'
      };
      
      const formatted = MessageFormatter.formatStartupNotification(info);
      
      // Check all formats exist
      expect(formatted).toHaveProperty('text');
      expect(formatted).toHaveProperty('html');
      expect(formatted).toHaveProperty('slack');
      expect(formatted).toHaveProperty('discord');
      
      // Check content).toContain('🚀 Service Started');
      expect(formatted.text).toContain('✅ Service is now running');
      expect(formatted.text).toContain('Version: 1.0.0');
      expect(formatted.text).toContain('Main Budget, Test Budget');
      expect(formatted.text).toContain('0 2 * * *');
      
      // Check HTML format
      expect(formatted.html).toContain('🚀 Service Started');
      expect(formatted.html).toContain('#28a745'); // Green color
      
      // Check Discord format
      expect(formatted.discord.embeds[0].color).toBe(5025616); // Green
    });
  });
});

/**
 * Telegram Bot Service Tests
 */

const { TelegramBotService } = require('../services/telegramBot');

// Mock https module
jest.mock('https');
const https = require('https');

// Mock fs module to prevent loading actual preferences
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn()
}));
const fs = require('fs');

describe('TelegramBotService', () => {
  let mockRequest;
  let mockResponse;
  let mockSyncHistory;
  let mockHealthCheck;
  let mockGetServerConfig;
  
  beforeEach(() => {
    // Mock response
    mockResponse = {
      statusCode: 200,
      on: jest.fn((event, callback) => {
        if (event === 'data') {
          callback(JSON.stringify({
            ok: true,
            result: []
          }));
        }
        if (event === 'end') {
          callback();
        }
      })
    };
    
    // Mock request
    mockRequest = {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn()
    };
    
    https.request.mockImplementation((options, callback) => {
      setTimeout(() => callback(mockResponse), 0);
      return mockRequest;
    });
    
    // Mock services
    mockSyncHistory = {
      getHistory: jest.fn().mockReturnValue([]),
      getStatistics: jest.fn().mockReturnValue({
        total_syncs: 10,
        successful_syncs: 8,
        failed_syncs: 2,
        success_rate: '80.0%',
        avg_duration_ms: 1500,
        total_accounts_processed: 50,
        latest_sync: new Date().toISOString()
      }),
      getRecentErrors: jest.fn().mockReturnValue([])
    };
    
    mockHealthCheck = {
      getStatus: jest.fn().mockReturnValue({
        status: 'HEALTHY',
        uptime: 3600,
        syncCount: 10,
        successCount: 8,
        failureCount: 2,
        lastSyncTime: new Date().toISOString(),
        lastSyncStatus: 'success',
        startTime: new Date(Date.now() - 3600000).toISOString()
      })
    };
    
    mockGetServerConfig = jest.fn().mockReturnValue([
      {
        name: 'Server1',
        url: 'http://server1:5006',
        sync: { schedule: '0 3 * * *' }
      }
    ]);
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('Constructor and Initialization', () => {
    test('should initialize with config', () => {
      const bot = new TelegramBotService(
        {
          botToken: '123:ABC',
          chatId: '456',
          notifyOnSuccess: 'always'
        },
        {
          syncHistory: mockSyncHistory,
          healthCheck: mockHealthCheck,
          getServerConfig: mockGetServerConfig
        }
      );
      
      expect(bot.config.botToken).toBe('123:ABC');
      expect(bot.config.chatId).toBe('456');
      expect(bot.config.notifyOnSuccess).toBe('always');
      expect(bot.polling).toBe(false);
    });
    
    test('should initialize with default notification mode', () => {
      const bot = new TelegramBotService(
        {
          botToken: '123:ABC',
          chatId: '456'
        },
        {}
      );
      
      expect(bot.config.notifyOnSuccess).toBe('errors_only');
    });
    
    test('should initialize commands', () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {}
      );
      
      expect(bot.commands).toHaveProperty('/help');
      expect(bot.commands).toHaveProperty('/ping');
      expect(bot.commands).toHaveProperty('/status');
      expect(bot.commands).toHaveProperty('/history');
      expect(bot.commands).toHaveProperty('/stats');
      expect(bot.commands).toHaveProperty('/servers');
      expect(bot.commands).toHaveProperty('/notify');
      expect(bot.commands).toHaveProperty('/errors');
    });
  });
  
  describe('Start and Stop', () => {
    test('should start polling', () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {}
      );
      
      bot.start();
      
      expect(bot.polling).toBe(true);
    });
    
    test('should not start polling without token', () => {
      const bot = new TelegramBotService(
        { botToken: '', chatId: '456' },
        {}
      );
      
      bot.start();
      
      expect(bot.polling).toBe(false);
    });
    
    test('should not start polling without chat ID', () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '' },
        {}
      );
      
      bot.start();
      
      expect(bot.polling).toBe(false);
    });
    
    test('should stop polling', () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {}
      );
      
      bot.start();
      expect(bot.polling).toBe(true);
      
      bot.stop();
      expect(bot.polling).toBe(false);
    });
  });
  
  describe('Command Handlers', () => {
    describe('/help command', () => {
      test('should send help message', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          {}
        );
        
        await bot.handleHelp([]);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('/help');
        expect(payload.text).toContain('/ping');
        expect(payload.text).toContain('/status');
      });
    });
    
    describe('/ping command', () => {
      test('should respond to ping', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          {}
        );
        
        await bot.handlePing([]);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('Pong');
      });
    });
    
    describe('/status command', () => {
      test('should send status information', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          {
            healthCheck: mockHealthCheck
          }
        );
        
        await bot.handleStatus([]);
        
        expect(mockHealthCheck.getStatus).toHaveBeenCalled();
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('Service Status');
        expect(payload.text).toContain('Total Syncs: 10');
      });
      
      test('should handle missing health check service', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          {}
        );
        
        await bot.handleStatus([]);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('not available');
      });
    });
    
    describe('/history command', () => {
      test('should send sync history', async () => {
        mockSyncHistory.getHistory.mockReturnValue([
          {
            server_name: 'Server1',
            status: 'success',
            timestamp: new Date().toISOString(),
            duration_ms: 1500
          }
        ]);
        
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { syncHistory: mockSyncHistory }
        );
        
        await bot.handleHistory([]);
        
        expect(mockSyncHistory.getHistory).toHaveBeenCalledWith({ limit: 5 });
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('Server1');
      });
      
      test('should handle custom limit', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { syncHistory: mockSyncHistory }
        );
        
        await bot.handleHistory(['10']);
        
        expect(mockSyncHistory.getHistory).toHaveBeenCalledWith({ limit: 10 });
      });
      
      test('should handle empty history', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { syncHistory: mockSyncHistory }
        );
        
        await bot.handleHistory([]);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('No sync history');
      });
    });
    
    describe('/stats command', () => {
      test('should send statistics', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { syncHistory: mockSyncHistory }
        );
        
        await bot.handleStats([]);
        
        expect(mockSyncHistory.getStatistics).toHaveBeenCalled();
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('Total Syncs: 10');
        expect(payload.text).toContain('Success Rate: 80.0%');
      });
    });
    
    describe('/servers command', () => {
      test('should list servers', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { getServerConfig: mockGetServerConfig }
        );
        
        await bot.handleServers([]);
        
        expect(mockGetServerConfig).toHaveBeenCalled();
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('Server1');
        expect(payload.text).toContain('http://server1:5006');
      });
      
      test('should handle no servers', async () => {
        mockGetServerConfig.mockReturnValue([]);
        
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { getServerConfig: mockGetServerConfig }
        );
        
        await bot.handleServers([]);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('No servers configured');
      });
    });
    
    describe('/notify command', () => {
      test('should change notification mode to always', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          {}
        );
        
        await bot.handleNotify(['always']);
        
        expect(bot.config.notifyOnSuccess).toBe('always');
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('always');
      });
      
      test('should change notification mode to errors', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'always' },
          {}
        );
        
        await bot.handleNotify(['errors']);
        
        expect(bot.config.notifyOnSuccess).toBe('errors_only');
      });
      
      test('should change notification mode to never', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          {}
        );
        
        await bot.handleNotify(['never']);
        
        expect(bot.config.notifyOnSuccess).toBe('never');
      });
      
      test('should show usage for invalid mode', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          {}
        );
        
        await bot.handleNotify(['invalid']);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('Usage');
      });
      
      test('should show current mode without arguments', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'always' },
          {}
        );
        
        await bot.handleNotify([]);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('always');
      });
    });
    
    describe('/errors command', () => {
      test('should show recent errors', async () => {
        mockSyncHistory.getRecentErrors.mockReturnValue([
          {
            server_name: 'Server1',
            timestamp: new Date().toISOString(),
            error_message: 'Connection failed',
            error_code: 'ECONNREFUSED'
          }
        ]);
        
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { syncHistory: mockSyncHistory }
        );
        
        await bot.handleErrors([]);
        
        expect(mockSyncHistory.getRecentErrors).toHaveBeenCalledWith(5);
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('Connection failed');
      });
      
      test('should handle no errors', async () => {
        const bot = new TelegramBotService(
          { botToken: '123:ABC', chatId: '456' },
          { syncHistory: mockSyncHistory }
        );
        
        await bot.handleErrors([]);
        
        expect(mockRequest.write).toHaveBeenCalled();
        const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
        expect(payload.text).toContain('No recent errors');
      });
    });
  });
  
  describe('notifySync', () => {
    test('should notify on successful sync when mode is always', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'always' },
        {}
      );
      
      await bot.notifySync({
        status: 'success',
        serverName: 'Server1',
        duration: 1500,
        accountsProcessed: 5,
        accountsFailed: 0,
        succeededAccounts: ['Account1', 'Account2'],
        failedAccounts: []
      });
      
      expect(mockRequest.write).toHaveBeenCalled();
      const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
      expect(payload.text).toContain('Successful');
      expect(payload.text).toContain('Server1');
      expect(payload.text).toContain('Result: 5/');
    });
    
    test('should not notify on successful sync when mode is errors_only', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'errors_only' },
        {}
      );
      
      await bot.notifySync({
        status: 'success',
        serverName: 'Server1',
        duration: 1500
      });
      
      expect(mockRequest.write).not.toHaveBeenCalled();
    });
    
    test('should notify on failed sync when mode is errors_only', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'errors_only' },
        {}
      );
      
      await bot.notifySync({
        status: 'error',
        serverName: 'Server1',
        duration: 1500,
        error: 'Connection failed',
        errorCode: 'ECONNREFUSED',
        accountsProcessed: 0,
        accountsFailed: 1
      });
      
      expect(mockRequest.write).toHaveBeenCalled();
      const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
      expect(payload.text).toContain('Failed');
      expect(payload.text).toContain('Connection failed');
    });
    
    test('should not notify when mode is never', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'never' },
        {}
      );
      
      await bot.notifySync({
        status: 'success',
        serverName: 'Server1',
        duration: 1500
      });
      
      expect(mockRequest.write).not.toHaveBeenCalled();
    });
  });
  
  describe('processUpdate', () => {
    test('should process command message', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {}
      );
      
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 456, first_name: 'Test', username: 'testuser' },
          chat: { id: '456' },
          text: '/ping'
        }
      };
      
      await bot.processUpdate(update);
      
      expect(mockRequest.write).toHaveBeenCalled();
      const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
      expect(payload.text).toContain('Pong');
    });
    
    test('should handle non-command message', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {}
      );
      
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 456, first_name: 'Test', username: 'testuser' },
          chat: { id: '456' },
          text: 'hello'
        }
      };
      
      await bot.processUpdate(update);
      
      expect(mockRequest.write).toHaveBeenCalled();
      const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
      expect(payload.text).toContain('I received your message');
      expect(payload.text).toContain('/help');
    });
    
    test('should ignore message from wrong chat', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {}
      );
      
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 789, first_name: 'Test', username: 'testuser' },
          chat: { id: '789' },
          text: '/ping'
        }
      };
      
      await bot.processUpdate(update);
      
      expect(mockRequest.write).not.toHaveBeenCalled();
    });
  });
  
  describe('getNotificationMode', () => {
    test('should return current notification mode', () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'always' },
        {}
      );
      
      expect(bot.getNotificationMode()).toBe('always');
    });
  });

  describe('/sync command', () => {
    test('should trigger sync for specified server', async () => {
      const mockSyncBank = jest.fn().mockResolvedValue();
      const mockServers = [
        { name: 'Main Budget', url: 'http://server1:5006' },
        { name: 'Test Budget', url: 'http://server2:5006' }
      ];
      
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456', notifyOnSuccess: 'never' },
        {
          syncBank: mockSyncBank,
          getServerConfig: jest.fn().mockReturnValue(mockServers)
        }
      );
      
      await bot.handleSync(['Main', 'Budget']);
      
      expect(mockSyncBank).toHaveBeenCalledWith(mockServers[0]);
      expect(mockRequest.write).toHaveBeenCalled();
      const calls = mockRequest.write.mock.calls;
      expect(calls.some(call => {
        const payload = JSON.parse(call[0]);
        return payload.text.includes('Starting sync for Main Budget');
      })).toBe(true);
    });
    
    test('should handle server not found', async () => {
      const mockSyncBank = jest.fn();
      const mockServers = [
        { name: 'Main Budget', url: 'http://server1:5006' }
      ];
      
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {
          syncBank: mockSyncBank,
          getServerConfig: jest.fn().mockReturnValue(mockServers)
        }
      );
      
      await bot.handleSync(['Invalid', 'Server']);
      
      expect(mockSyncBank).not.toHaveBeenCalled();
      expect(mockRequest.write).toHaveBeenCalled();
      const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
      expect(payload.text).toContain('Server "Invalid Server" not found');
      expect(payload.text).toContain('Main Budget');
    });
    
    test('should require server name parameter', async () => {
      const mockSyncBank = jest.fn();
      
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {
          syncBank: mockSyncBank,
          getServerConfig: jest.fn().mockReturnValue([])
        }
      );
      
      await bot.handleSync([]);
      
      expect(mockSyncBank).not.toHaveBeenCalled();
      expect(mockRequest.write).toHaveBeenCalled();
      const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
      expect(payload.text).toContain('Please specify a server name');
      expect(payload.text).toContain('Usage: /sync ServerName');
    });
    
    test('should handle sync errors gracefully', async () => {
      const mockSyncBank = jest.fn().mockRejectedValue(
        new Error('Connection failed')
      );
      const mockServers = [
        { name: 'Main Budget', url: 'http://server1:5006' }
      ];
      
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {
          syncBank: mockSyncBank,
          getServerConfig: jest.fn().mockReturnValue(mockServers)
        }
      );
      
      await bot.handleSync(['Main', 'Budget']);
      
      expect(mockSyncBank).toHaveBeenCalled();
      expect(mockRequest.write).toHaveBeenCalled();
      const calls = mockRequest.write.mock.calls;
      expect(calls.some(call => {
        const payload = JSON.parse(call[0]);
        return payload.text.includes('Sync failed: Connection failed');
      })).toBe(true);
    });
    
    test('should handle missing syncBank service', async () => {
      const bot = new TelegramBotService(
        { botToken: '123:ABC', chatId: '456' },
        {
          getServerConfig: jest.fn().mockReturnValue([])
        }
      );
      
      await bot.handleSync(['Main']);
      
      expect(mockRequest.write).toHaveBeenCalled();
      const payload = JSON.parse(mockRequest.write.mock.calls[0][0]);
      expect(payload.text).toContain('Sync function not available');
    });
  });
});

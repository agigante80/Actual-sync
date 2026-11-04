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
      expect(formatted.text).toContain('Accounts: 3 synced, 0 failed, 0 skipped');
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
      expect(formatted.text).toContain('Accounts: 2 synced, 1 failed, 0 skipped');
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

  describe('skipped accounts (#98)', () => {
    test('F5: reports real synced count and a skipped section', () => {
      const result = {
        status: 'success',
        serverName: "Main's Budget",
        duration: 9600,
        accountsProcessed: 1,
        accountsFailed: 0,
        succeededAccounts: ['SabadellSync'],
        failedAccounts: [],
        skippedAccounts: [
          { name: 'Mortgage', reason: 'not-linked' },
          { name: 'House Asset', reason: 'not-linked' },
          { name: 'Old Card', reason: 'closed' }
        ]
      };
      const f = MessageFormatter.formatSyncNotification(result);

      expect(f.text).toContain('Accounts: 1 synced, 0 failed, 3 skipped');
      expect(f.text).toContain('SabadellSync');
      expect(f.text).not.toContain('Mortgage\n  • House'); // manual accts not under Synced
      expect(f.text).toMatch(/Skipped.*3/);                 // skipped count shown
      expect(f.text).toContain('Mortgage (not-linked)');
      expect(f.text).toContain('Old Card (closed)');
    });

    test('F6: no Skipped section when there are no skipped accounts', () => {
      const result = {
        status: 'success', serverName: 'X', duration: 1000,
        accountsProcessed: 2, accountsFailed: 0,
        succeededAccounts: ['A', 'B'], failedAccounts: [], skippedAccounts: []
      };
      const f = MessageFormatter.formatSyncNotification(result);
      expect(f.text).toContain('Accounts: 2 synced, 0 failed, 0 skipped');
      expect(f.text).not.toMatch(/Skipped/);
    });

    test('F7: zero-syncable budget renders 0/0 + skipped, no broken render', () => {
      const result = {
        status: 'success', serverName: 'All Manual', duration: 500,
        accountsProcessed: 0, accountsFailed: 0,
        succeededAccounts: [], failedAccounts: [],
        skippedAccounts: [
          { name: 'Mortgage', reason: 'not-linked' },
          { name: 'House Asset', reason: 'not-linked' }
        ]
      };
      const f = MessageFormatter.formatSyncNotification(result);
      expect(f.text).toContain('Accounts: 0 synced, 0 failed, 2 skipped');
      expect(f.text).not.toContain('✅ Synced:');     // nothing actually synced
      expect(f.text).toMatch(/Skipped.*2/);
      expect(f.text).toContain('Mortgage (not-linked)');
    });
  });

  describe('failed-account error parity on Slack and Discord (#108)', () => {
    const slackText = (f) => JSON.stringify(f.slack);
    const discordText = (f) => JSON.stringify(f.discord);
    const base = {
      status: 'partial',
      serverName: 'My Budget',
      duration: 1200,
      accountsProcessed: 1,
      accountsFailed: 1,
      succeededAccounts: ['Checking'],
      failedAccounts: [{ name: 'Sabadell *5650', error: 'Failed syncing account' }],
      skippedAccounts: []
    };

    test('Slack failed section includes the per-account error message', () => {
      const s = slackText(MessageFormatter.formatSyncNotification(base));
      expect(s).toContain('Sabadell *5650');
      expect(s).toContain('Failed syncing account');
    });

    test('Discord failed section includes the per-account error message', () => {
      const d = discordText(MessageFormatter.formatSyncNotification(base));
      expect(d).toContain('Sabadell *5650');
      expect(d).toContain('Failed syncing account');
    });

    test('long errors are truncated with ellipsis in Slack and Discord', () => {
      const longErr = 'x'.repeat(120);
      const f = MessageFormatter.formatSyncNotification({
        ...base,
        failedAccounts: [{ name: 'Acc', error: longErr }]
      });
      expect(slackText(f)).toContain('...');
      expect(discordText(f)).toContain('...');
      expect(slackText(f)).not.toContain('x'.repeat(120));
    });

    test('a failed account with no error still renders the name', () => {
      const f = MessageFormatter.formatSyncNotification({
        ...base,
        failedAccounts: [{ name: 'NoErr' }]
      });
      expect(slackText(f)).toContain('NoErr');
      expect(discordText(f)).toContain('NoErr');
    });

    test('caps the Discord failed field within the 1024-char limit on a large batch', () => {
      const failed = Array.from({ length: 30 }, (_, i) => ({
        name: `Account ${i}`,
        error: 'Failed syncing account: a fairly long error message goes here'
      }));
      const f = MessageFormatter.formatSyncNotification({
        ...base, accountsFailed: 30, succeededAccounts: [], failedAccounts: failed
      });
      const field = f.discord.embeds[0].fields.find(x => x.name.includes('Failed'));
      expect(field.value.length).toBeLessThanOrEqual(1024);
      expect(field.value).toMatch(/…and \d+ more/);
    });

    test('_joinCapped: empty, fits, and overflow cases', () => {
      expect(MessageFormatter._joinCapped([], 100)).toBe('');
      expect(MessageFormatter._joinCapped(['a', 'b'], 100)).toBe('a\nb');
      const capped = MessageFormatter._joinCapped(['line1', 'line2', 'line3', 'line4'], 12);
      expect(capped.length).toBeLessThanOrEqual(12);
      expect(capped).toMatch(/…and \d+ more/);
    });
  });

  describe('notification clarity (#100)', () => {
    const slackText = (f) => JSON.stringify(f.slack);
    const discordText = (f) => JSON.stringify(f.discord);

    test('M1: failure shows error + Accounts summary + failed + skipped (all channels)', () => {
      const result = {
        status: 'failure',
        serverName: "Main's Budget",
        duration: 1100,
        accountsProcessed: 0,
        accountsFailed: 1,
        succeededAccounts: [],
        failedAccounts: [{ name: 'SabadellSync', error: 'Rate limit exceeded. Please try again later.' }],
        skippedAccounts: [
          { name: 'Old Card', reason: 'closed' },
          { name: 'MCP-Test', reason: 'closed' }
        ],
        error: '1 account(s) failed to sync: Failed syncing account SabadellSync. Rate limit exceeded.'
      };
      const f = MessageFormatter.formatSyncNotification(result);

      // text
      expect(f.text).toContain('Error:');
      expect(f.text).toContain('Accounts: 0 synced, 1 failed, 2 skipped');
      expect(f.text).toContain('SabadellSync');
      expect(f.text).toMatch(/Skipped.*2/);
      expect(f.text).toContain('Old Card (closed)');
      // slack + discord carry the same summary + skipped info
      expect(slackText(f)).toContain('Accounts:');
      expect(slackText(f)).toContain('0 synced, 1 failed, 2 skipped');
      expect(slackText(f)).toContain('Skipped');
      expect(discordText(f)).toContain('0 synced, 1 failed, 2 skipped');
      expect(discordText(f)).toContain('Skipped');
    });

    test('M2: success Accounts summary appears in text, slack, and discord', () => {
      const result = {
        status: 'success', serverName: 'X', duration: 9600,
        accountsProcessed: 1, accountsFailed: 0,
        succeededAccounts: ['SabadellSync'], failedAccounts: [],
        skippedAccounts: [
          { name: 'a', reason: 'closed' }, { name: 'b', reason: 'closed' },
          { name: 'c', reason: 'closed' }, { name: 'd', reason: 'closed' },
          { name: 'e', reason: 'closed' }, { name: 'f', reason: 'closed' }
        ]
      };
      const f = MessageFormatter.formatSyncNotification(result);
      expect(f.text).toContain('Accounts: 1 synced, 0 failed, 6 skipped');
      expect(slackText(f)).toContain('1 synced, 0 failed, 6 skipped');
      expect(discordText(f)).toContain('1 synced, 0 failed, 6 skipped');
    });

    test('M3: server-level failure with no accounts shows no Accounts/Skipped sections', () => {
      const result = {
        status: 'failure', serverName: 'X', duration: 500,
        accountsProcessed: 0, accountsFailed: 0,
        succeededAccounts: [], failedAccounts: [], skippedAccounts: [],
        error: 'Connection refused'
      };
      const f = MessageFormatter.formatSyncNotification(result);
      expect(f.text).toContain('Connection refused');
      expect(f.text).not.toContain('Accounts:');
      expect(f.text).not.toMatch(/Skipped/);
      expect(slackText(f)).not.toContain('Accounts:');
      expect(slackText(f)).not.toContain('Skipped');
      expect(discordText(f)).not.toContain('"Accounts"');
      expect(discordText(f)).not.toContain('Skipped');
    });
  });

  describe('generic webhook payload (#111)', () => {
    test('formatSyncNotification.generic has the documented shape', () => {
      const f = MessageFormatter.formatSyncNotification({
        status: 'partial', serverName: 'My Budget', duration: 1200,
        accountsProcessed: 1, accountsFailed: 1,
        succeededAccounts: ['Checking'],
        failedAccounts: [{ name: 'Sabadell', error: 'boom' }],
        skippedAccounts: [{ name: 'Loan', reason: 'not-linked' }]
      });
      const g = f.generic;
      expect(g.event).toBe('sync');
      expect(g.status).toBe('partial');
      expect(g.server).toBe('My Budget');
      expect(g.durationMs).toBe(1200);
      expect(g.accounts).toEqual({ synced: 1, failed: 1, skipped: 1 });
      expect(g.failedAccounts).toEqual([{ name: 'Sabadell', error: 'boom' }]);
      expect(g.skippedAccounts[0].reason).toBe('not-linked');
      expect(typeof g.timestamp).toBe('string');
      // a clean success maps to status "success"
      expect(MessageFormatter.formatSyncNotification({
        status: 'success', serverName: 'X', duration: 100,
        accountsProcessed: 2, accountsFailed: 0, succeededAccounts: ['A', 'B'], failedAccounts: [], skippedAccounts: []
      }).generic.status).toBe('success');
    });

    test('startup notifications include a generic payload', () => {
      const s = MessageFormatter.formatStartupNotification({
        version: '1.5.0', serverNames: 'A, B', schedules: '...', nextSync: 'soon'
      });
      expect(s.generic.event).toBe('startup');
      expect(s.generic.version).toBe('1.5.0');
    });
  });

  describe('transaction counts (#391)', () => {
    const base = {
      status: 'success', serverName: 'My Budget', duration: 1200,
      accountsProcessed: 2, accountsFailed: 0,
      succeededAccounts: ['Checking', 'Savings'], failedAccounts: [], skippedAccounts: []
    };

    test('the generic payload carries both counts', () => {
      const g = MessageFormatter.formatSyncNotification({ ...base, transactionsAdded: 2, transactionsUpdated: 1 }).generic;
      expect(g.transactionsAdded).toBe(2);
      expect(g.transactionsUpdated).toBe(1);
    });

    test('the generic payload reports 0 when the counts are absent or malformed', () => {
      expect(MessageFormatter.formatSyncNotification(base).generic).toMatchObject({ transactionsAdded: 0, transactionsUpdated: 0 });
      const bad = MessageFormatter.formatSyncNotification({ ...base, transactionsAdded: -3, transactionsUpdated: '4' }).generic;
      expect(bad).toMatchObject({ transactionsAdded: 0, transactionsUpdated: 0 });
      const fractional = MessageFormatter.formatSyncNotification({ ...base, transactionsAdded: 1.5 }).generic;
      expect(fractional.transactionsAdded).toBe(0);
    });

    test('every template shows the counts line when a count is nonzero', () => {
      const f = MessageFormatter.formatSyncNotification({ ...base, transactionsAdded: 2, transactionsUpdated: 1 });
      expect(f.text).toContain('Accounts: 2 synced, 0 failed, 0 skipped\nTransactions: 2 new, 1 updated\n');
      expect(f.html).toContain('<span class="label">Transactions:</span>');
      expect(f.html).toContain('<span class="value">2 new, 1 updated</span>');
      expect(JSON.stringify(f.slack)).toContain('*Transactions:* 2 new, 1 updated');
      expect(f.discord.embeds[0].fields).toContainEqual({ name: 'Transactions', value: '2 new, 1 updated' });
      expect(f.ntfy.message).toContain('Transactions: 2 new, 1 updated');
    });

    test('a single nonzero count still shows the line, with the other as 0', () => {
      const f = MessageFormatter.formatSyncNotification({ ...base, transactionsAdded: 0, transactionsUpdated: 3 });
      expect(f.text).toContain('Transactions: 0 new, 3 updated');
    });

    test('templates are byte-identical to the pre-#391 output when both counts are 0', () => {
      const without = MessageFormatter.formatSyncNotification(base);
      const zero = MessageFormatter.formatSyncNotification({ ...base, transactionsAdded: 0, transactionsUpdated: 0 });
      for (const key of ['text', 'html', 'slack', 'discord', 'ntfy']) {
        expect(zero[key]).toEqual(without[key]);
      }
      expect(zero.text).not.toContain('Transactions');
      expect(zero.html).not.toContain('Transactions');
      expect(JSON.stringify(zero.slack)).not.toContain('Transactions');
      expect(JSON.stringify(zero.discord)).not.toContain('Transactions');
    });
  });

  describe('ntfy fields (#112)', () => {
    test('sync ntfy has title/message/level/tags; level reflects outcome', () => {
      const ok = MessageFormatter.formatSyncNotification({
        status: 'success', serverName: 'B', duration: 100,
        accountsProcessed: 1, accountsFailed: 0, succeededAccounts: ['A'], failedAccounts: [], skippedAccounts: []
      }).ntfy;
      expect(ok.title).toContain('Sync Successful: B');
      expect(ok.level).toBe('success');
      expect(ok.message).toContain('Accounts: 1 synced');

      const fail = MessageFormatter.formatSyncNotification({
        status: 'failure', serverName: 'B', duration: 100, error: 'nope',
        accountsProcessed: 0, accountsFailed: 0, succeededAccounts: [], failedAccounts: [], skippedAccounts: []
      }).ntfy;
      expect(fail.level).toBe('failure');

      // partial (has failures) is treated as failure-priority
      const partial = MessageFormatter.formatSyncNotification({
        status: 'partial', serverName: 'B', duration: 100,
        accountsProcessed: 1, accountsFailed: 1, succeededAccounts: ['A'], failedAccounts: [{ name: 'F' }], skippedAccounts: []
      }).ntfy;
      expect(partial.level).toBe('failure');
    });
  });

  describe('per-account transaction counts (#427)', () => {
    const r = (id, name, added, updated = 0, extra = {}) =>
      ({ id, name, status: 'synced', added, updated, countsKnown: true, ...extra });
    const build = (accountResults, extra = {}) => MessageFormatter.formatSyncNotification({
      status: 'success',
      serverName: 'Vega II',
      duration: 1000,
      accountsProcessed: accountResults.length,
      accountsFailed: 0,
      succeededAccounts: accountResults.map(a => a.name),
      transactionsAdded: 20,
      transactionsUpdated: 0,
      accountResults,
      ...extra
    });
    const three = [r('1', 'Account 1', 5), r('2', 'Account 2', 0), r('3', 'Account 3', 15)];

    test('text lists each synced account with its count', () => {
      const { text } = build(three);
      expect(text).toContain('  • Account 1: 5 new transactions\n');
      expect(text).toContain('  • Account 2: no new transactions\n');
      expect(text).toContain('  • Account 3: 15 new transactions\n');
      expect(text).toContain('Transactions: 20 new, 0 updated');
    });

    test('singular for one, and updated only when above 0', () => {
      const { text } = build([r('1', 'A', 1, 2), r('2', 'B', 1), r('3', 'C', 0, 3)]);
      expect(text).toContain('• A: 1 new transaction, 2 updated\n');
      expect(text).toContain('• B: 1 new transaction\n');
      expect(text).toContain('• C: 0 new transactions, 3 updated\n');
    });

    test('a late success reads count unknown, never no new transactions', () => {
      const { text, html, slack, discord } = build([r('1', 'Late', 0, 0, { countsKnown: false })]);
      expect(text).toContain('• Late: synced, count unknown');
      expect(text).not.toContain('no new transactions');
      expect(html).toContain('Late: synced, count unknown');
      expect(JSON.stringify(slack)).toContain('Late: synced, count unknown');
      expect(JSON.stringify(discord)).toContain('Late: synced, count unknown');
    });

    test('html, slack and discord carry the per-account lines', () => {
      const { html, slack, discord } = build(three);
      expect(html).toContain('Account 1: 5 new transactions');
      expect(html).toContain('Account 3: 15 new transactions');
      const slackText = JSON.stringify(slack);
      expect(slackText).toContain('Account 2: no new transactions');
      const field = discord.embeds[0].fields.find(f => f.name.includes('Synced'));
      expect(field.value).toContain('Account 1: 5 new transactions');
    });

    test('failed and skipped accounts keep their lines and are not in the synced list', () => {
      const { text } = build([r('1', 'Good', 2), { id: '2', name: 'Bad', status: 'failed', added: 0, updated: 0, countsKnown: false }], {
        failedAccounts: [{ name: 'Bad', error: 'boom' }],
        skippedAccounts: [{ name: 'Manual', reason: 'not-linked' }],
        accountsFailed: 1
      });
      expect(text).toContain('• Good: 2 new transactions');
      expect(text).toContain('  • Bad\n    boom');
      expect(text).toContain('• Manual (not-linked)');
      expect(text).not.toContain('Bad: ');
    });

    test('without accountResults the synced list is the bare names as before', () => {
      const { text } = MessageFormatter.formatSyncNotification({
        status: 'success', serverName: 's', duration: 5, accountsProcessed: 1, accountsFailed: 0,
        succeededAccounts: ['Checking']
      });
      expect(text).toContain('  • Checking\n');
      expect(text).not.toContain('Checking:');
    });

    test('account names are escaped in html, slack and discord lines', () => {
      const evil = '<b>x</b> & *y* @everyone';
      const { html, slack, discord } = build([r('1', evil, 1)]);
      expect(html).not.toContain('<b>x</b>');
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp;');
      expect(JSON.stringify(slack)).toContain('&lt;b&gt;x&lt;/b&gt; &amp;');
      const field = discord.embeds[0].fields.find(f => f.name.includes('Synced'));
      expect(field.value).not.toContain('@everyone');
      expect(field.value).toContain('\\*y\\*');
    });

    test('40 accounts stay within the Discord field and Slack section limits with "and N more"', () => {
      const many = Array.from({ length: 40 }, (_, i) => r(String(i), `Account number ${i}`, i));
      const { slack, discord } = build(many);
      const field = discord.embeds[0].fields.find(f => f.name.includes('Synced'));
      expect(field.value.length).toBeLessThanOrEqual(1024);
      expect(field.value).toMatch(/…and \d+ more$/);
      const section = slack.blocks.find(b => b.text && b.text.text.includes('Synced:'));
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
      expect(section.text.text).toMatch(/…and \d+ more/);
    });

    test('generic payload adds accountResults and keeps the existing fields', () => {
      const { generic } = build(three);
      expect(generic.accountResults).toEqual(three);
      expect(generic.succeededAccounts).toEqual(['Account 1', 'Account 2', 'Account 3']);
      expect(generic.transactionsAdded).toBe(20);
      expect(generic.accounts).toEqual({ synced: 3, failed: 0, skipped: 0 });
    });

    test('generic accountResults is an empty array when the caller passes none', () => {
      const { generic } = MessageFormatter.formatSyncNotification({
        status: 'success', serverName: 's', duration: 5, accountsProcessed: 0, accountsFailed: 0
      });
      expect(generic.accountResults).toEqual([]);
    });
  });
});

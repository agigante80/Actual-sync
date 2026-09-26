// Healthy servers plus one budget left in history after it was removed from
// config, so Settings lists an orphaned server; notifications have history. (#263)
const healthy = require('./healthy');

module.exports = {
  ...healthy,
  orphan: 'Old Budget',
  notificationStats: {
    notificationsSentLastHour: 1,
    rateLimitRemaining: 3,
    perServerStats: {
      'Family Budget': { lastNotificationTime: null, notificationsSentLastHour: 1, rateLimitRemaining: 3 }
    },
    consecutiveFailuresByServer: { 'Family Budget': 1 },
    recentSyncsByServer: {}
  },
  seed(s) {
    healthy.seed(s);
    for (const minutesAgo of [4000, 3000, 2000]) {
      s.sync('Old Budget', minutesAgo, { succeeded: 1, historyOnly: true });
    }
  }
};

# Dashboard Screenshots

This directory contains automatically generated screenshots of the Actual-sync dashboard for documentation purposes.

## Automated Screenshot Generation

Screenshots are generated using the `generateDashboardScreenshots.js` script with fake data to demonstrate various scenarios.

### Prerequisites

1. Service must be running:
   ```bash
   npm start
   ```

2. Puppeteer dependency installed (dev dependency):
   ```bash
   npm install
   ```

### Generate Screenshots

Run the automated screenshot generator:

```bash
npm run screenshots
```

This will create 10 screenshots:
- `dashboard-overview-healthy.png` - Healthy system with 2-column layout
- `dashboard-overview-degraded.png` - Degraded system with error states
- `dashboard-overview-multi-server.png` - 6 servers with encryption badges
- `dashboard-analytics.png` - All-time statistics and charts
- `dashboard-analytics-degraded.png` - Performance issues visualization
- `dashboard-history.png` - Sync history with filters
- `dashboard-history-errors.png` - Error details and filtering
- `dashboard-settings.png` - Date format preferences and data management
- `dashboard-settings-danger-zone.png` - Reset history and orphaned servers
- `dashboard-hero.png` - Full dashboard hero shot

### How It Works

The script:
1. Checks if the service is running
2. Launches a headless Chrome browser via Puppeteer
3. Injects fake data for each scenario
4. Navigates to the dashboard
5. Switches between tabs (Overview, Analytics, History, Settings)
6. Waits for charts and data to render
7. Takes full-page screenshots

### Screenshot Scenarios

#### Overview Tab
- **Healthy** (`dashboard-overview-healthy.png`) - 2-column layout, all servers operational, status badges showing success
- **Degraded** (`dashboard-overview-degraded.png`) - Multiple server errors, partial sync failures, error logs visible
- **Multi-Server** (`dashboard-overview-multi-server.png`) - 6 budget servers with encryption badges, high-scale deployment

#### Analytics Tab
- **All-Time Statistics** (`dashboard-analytics.png`) - Success rate charts, sync duration trends, server performance breakdown
- **Performance Issues** (`dashboard-analytics-degraded.png`) - Degraded system with declining metrics visualization

#### History Tab
- **Sync History** (`dashboard-history.png`) - Searchable table with date range filters, status badges, CSV export
- **Error Details** (`dashboard-history-errors.png`) - Failed sync filtering, error message display

#### Settings Tab
- **Preferences** (`dashboard-settings.png`) - Date format options (11 formats including 3-letter months), orphaned server management
- **Danger Zone** (`dashboard-settings-danger-zone.png`) - Reset all history, delete orphaned server data

#### Hero Shot
- **Full Dashboard** (`dashboard-hero.png`) - Complete overview showing all features, used for README and documentation

### When to Regenerate

Regenerate screenshots when:
- Dashboard UI changes
- New features are added to the dashboard
- Chart visualizations are updated
- Layout or styling is modified

### Customizing Scenarios

To add new scenarios or modify existing ones, edit `scripts/generateDashboardScreenshots.js`:

1. Add new scenario data in the `scenarios` object
2. Add new screenshot call in the `main()` function:
   ```javascript
   await takeScreenshot(
       browser,
       'your-scenario-name',
       'output-filename.png',
       'Description for logs'
   );
   ```
3. Update README.md to include the new screenshot

### Technical Details

- **Browser**: Puppeteer (headless Chrome)
- **Viewport**: 1920x1080
- **Format**: PNG
- **Type**: Full-page screenshots
- **Mock Data**: Injected via `evaluateOnNewDocument`

### Troubleshooting

**Service not running:**
```bash
⚠️  Service not running. Please start the service first:
   npm start
```

**Puppeteer not installed:**
```bash
npm install --save-dev puppeteer
```

**Screenshots not updating:**
- Clear `docs/screenshots/*.png` and regenerate
- Check if service is responding: `curl http://localhost:3000/health`

**Charts not rendering:**
- Increase wait time in script (default: 2000ms)
- Check browser console in non-headless mode

## File Sizes

Typical screenshot sizes:
- `dashboard-overview.png`: ~500-800 KB
- `dashboard-degraded.png`: ~600-900 KB
- `dashboard-multi-server.png`: ~700-1000 KB

Consider optimizing with image compression tools if needed.

## Maintenance

These screenshots are part of the documentation and should be kept up-to-date with dashboard changes. The automated script ensures consistency across regenerations.

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

This will create:
- `dashboard-overview.png` - Healthy system with 3 servers
- `dashboard-degraded.png` - Degraded system with errors
- `dashboard-multi-server.png` - Multi-server setup (6 instances)

### How It Works

The script:
1. Checks if the service is running
2. Launches a headless Chrome browser via Puppeteer
3. Injects fake data for each scenario
4. Navigates to the dashboard
5. Waits for charts to render
6. Takes full-page screenshots

### Screenshot Scenarios

#### Healthy System (`dashboard-overview.png`)
- 3 budget servers (Main, Personal, Family)
- 96.67% success rate
- Recent successful syncs
- Interactive charts showing good health

#### Degraded System (`dashboard-degraded.png`)
- 4 budget servers with mixed status
- 85% success rate
- Multiple failed syncs
- Error logs visible
- Charts showing declining performance

#### Multi-Server Setup (`dashboard-multi-server.png`)
- 6 budget servers
- 97% success rate
- High-scale deployment example
- All servers synchronized

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

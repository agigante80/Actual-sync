/**
 * Dashboard client script, served at /dashboard.js. Kept out of dashboard.html
 * so the page's Content-Security-Policy can use script-src 'self' with no
 * 'unsafe-inline'. (#243)
 */
let ws = null;
let wsConnecting = false; // a ticket request is in flight (#242)
let reconnectTimer = null; // the one pending retry, if any (#280)
let reconnectAttempts = 0;
let reconnectDelay = 1000; // Start with 1 second
const maxReconnectDelay = 30000; // Cap at 30 seconds
let isPageVisible = true;
let lastPingTime = Date.now();
let pingInterval = null;

// Ring buffer for logs (memory efficient)
const MAX_LOGS = 500; // Increased from 100
const logBuffer = [];
let logBufferIndex = 0;

// Tab switching
function switchTab(tabName, button) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Remove active from all tab buttons
    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Show selected tab
    document.getElementById(tabName + '-tab').classList.add('active');
    
    // Activate button
    if (button) button.classList.add('active');
    
    // Load tab-specific data
    if (tabName === 'analytics') {
        loadAnalyticsTab();
    } else if (tabName === 'history') {
        loadHistoryTab();
    } else if (tabName === 'payments') {
        loadPaymentsTab();
    } else if (tabName === 'settings') {
        loadSettingsTab();
    }
}

// Get auth headers from current page request
// Page visibility handling - pause log streaming when tab is hidden
document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;
    if (isPageVisible && paymentsTabActive()) loadPaymentsTab();
    // One loop only: skip while a socket is open or still connecting, or a
    // ticket request is in flight. A pending retry is replaced, not doubled. (#280)
    const busy = wsConnecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING));
    if (isPageVisible && !busy) {
        console.log('Tab became visible, reconnecting WebSocket...');
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connectWebSocket();
    }
});

// Browser will automatically include credentials for same-origin requests
function getFetchOptions() {
    return {
        credentials: 'include'
    };
}

// Fetch and update dashboard data
async function updateDashboard() {
    try {
        // Refresh server info (encryption and schedules) first
        await fetchServerInfo();
        
        const response = await fetch('/api/dashboard/status', getFetchOptions());
        const data = await response.json();

        // Update system status
        const versionEl = document.getElementById('version');
        const uptimeEl = document.getElementById('uptime');
        
        if (versionEl) versionEl.textContent = data.version || 'unknown';
        const testedUpToEl = document.getElementById('tested-up-to');
        if (testedUpToEl) testedUpToEl.textContent = data.testedUpTo || 'unknown';
        if (uptimeEl) uptimeEl.textContent = formatUptime(data.uptime);

        // Update status badge and subtitle
        const statusBadge = document.getElementById('status-badge');
        const subtitleInfo = document.getElementById('subtitle-info');
        
        // Map PENDING to READY if no syncs yet
        let displayStatus = data.status;
        if (data.status === 'PENDING' && data.sync.totalSyncs === 0) {
            displayStatus = 'READY';
            subtitleInfo.textContent = '(No syncs yet this session)';
        } else if (data.status === 'PENDING') {
            displayStatus = 'READY';
            subtitleInfo.textContent = '';
        } else {
            subtitleInfo.textContent = '';
        }
        
        statusBadge.textContent = displayStatus;
        statusBadge.className = `status-badge status-${displayStatus === 'READY' ? 'healthy' : data.status.toLowerCase()}`;

        // Name the sync holding the queue, so a stuck one is visible (#272, #284)
        const runningSyncEl = document.getElementById('running-sync');
        if (runningSyncEl) runningSyncEl.textContent = formatRunningSync(data.runningSync);

        // Update servers list (now with fresh schedule info)
        updateServersList(data.servers);

        // Update server buttons
        updateServerButtons(data.servers);

        // Refresh the per-account syncability snapshot
        loadAccounts();

    } catch (error) {
        console.error('Failed to update dashboard:', error);
    }
}

// Text for the sync holding the queue, or '' when none. Plain text only: it is
// assigned with textContent, never innerHTML, because the key is a server name. (#284)
function formatRunningSync(running) {
    if (!running || typeof running.key !== 'string') return '';
    const started = new Date(running.startedAt);
    const since = Number.isNaN(started.getTime()) ? '' : ` since ${started.toLocaleTimeString()}`;
    return `Syncing: ${running.key}${since}`;
}

// Escape user-supplied text (account/server names) before innerHTML. (#99)
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Account syncability snapshot (#99): fetched on each dashboard refresh and
// cached so the "Show closed" toggle re-renders without re-fetching.
let accountsData = [];

let accountsUnavailable = false;
// Monotonic request id: poll() runs on an interval, so a slow response
// could otherwise land after a newer one and overwrite fresh data. Only
// the latest in-flight request is allowed to commit/render. (#99)
let accountsRequestSeq = 0;

async function loadAccounts() {
    const seq = ++accountsRequestSeq;
    try {
        const response = await fetch('/api/dashboard/accounts', getFetchOptions());
        if (!response.ok) {
            // Don't leave the card stuck on "Loading…" forever: show an
            // explicit unavailable state (e.g. 503 before any sync). (#99)
            if (seq === accountsRequestSeq) {
                accountsUnavailable = true;
                accountsData = [];
                renderAccounts();
            }
            return;
        }
        const data = await response.json();
        if (seq !== accountsRequestSeq) return; // superseded by a newer poll
        accountsUnavailable = false;
        accountsData = data;
        renderAccounts();
    } catch (error) {
        if (seq !== accountsRequestSeq) return;
        // Network/transient error (not a definitive 503): clear the
        // unavailable flag and re-render — keeps existing data, or shows the
        // empty state on first load instead of hanging on "Loading…".
        accountsUnavailable = false;
        renderAccounts();
    }
}

function renderAccounts() {
    const container = document.getElementById('accounts-list');
    if (!container) return;
    const showClosed = document.getElementById('show-closed-accounts')?.checked;

    if (!accountsData || accountsData.length === 0) {
        container.innerHTML = accountsUnavailable
            ? '<div style="color:#64748b;font-size:0.9rem;">Account data unavailable.</div>'
            : '<div style="color:#64748b;font-size:0.9rem;">No account data yet — run a sync.</div>';
        return;
    }

    const badge = (c) => `<span class="acct-badge ${c}">${c}</span>`;
    container.innerHTML = accountsData.map(group => {
        const accounts = (group.accounts || []).filter(a => showClosed || a.classification !== 'closed');
        const hiddenClosed = (group.accounts || []).length - accounts.length;
        const rows = accounts.length
            ? accounts.map(a => `
                <div class="acct-row ${a.classification}">
                    <span>${escapeHtml(a.name || a.id)}</span>
                    ${badge(a.classification)}
                </div>`).join('')
            : `<div style="color:#64748b;font-size:0.85rem;">No open accounts.</div>`;
        const hint = (!showClosed && hiddenClosed > 0)
            ? `<div style="color:#64748b;font-size:0.75rem;margin-top:4px;">${hiddenClosed} closed hidden</div>`
            : '';
        return `<div class="acct-server"><div class="acct-server-name">${escapeHtml(group.server)}</div>${rows}${hint}</div>`;
    }).join('');
}

function updateServersList(servers) {
    const serversList = document.getElementById('servers');
    if (!servers || Object.keys(servers).length === 0) {
        serversList.innerHTML = '<li class="server-item">No servers configured</li>';
        return;
    }

    serversList.innerHTML = Object.entries(servers).map(([name, status]) => {
        const serverData = serverScheduleInfo[name] || {};
        const isEncrypted = serverData.encrypted === true;
        const schedule = serverData.schedule;
        
        const encryptionBadge = isEncrypted 
            ? `<span class="encryption-badge encrypted">
                <svg class="encryption-icon" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                </svg>
                Encrypted
            </span>`
            : `<span class="encryption-badge unencrypted">
                <svg class="encryption-icon" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z" />
                </svg>
                Unencrypted
            </span>`;
        
        // Show both cron format and human-readable schedule
        let scheduleInfo = "";
        if (serverData.cronHuman && serverData.cron) {
            scheduleInfo = `<br><span style="color: #60a5fa;">⏰</span> ${serverData.cronHuman} <span style="color: #94a3b8; font-size: 0.85em;">(${serverData.cron})</span>`;
            if (serverData.nextInvocation) {
                const nextSync = new Date(serverData.nextInvocation);
                const now = new Date();
                const diffMs = nextSync - now;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMins / 60);
                const diffDays = Math.floor(diffHours / 24);
                
                let timeUntil = '';
                if (diffDays > 0) {
                    timeUntil = `${diffDays}d ${diffHours % 24}h`;
                } else if (diffHours > 0) {
                    timeUntil = `${diffHours}h ${diffMins % 60}m`;
                } else if (diffMins > 0) {
                    timeUntil = `${diffMins}m`;
                } else {
                    timeUntil = 'soon';
                }
                
                scheduleInfo += `<br><span style="color: #60a5fa;">📅</span> Next: ${nextSync.toLocaleString()} <span style="color: #94a3b8; font-size: 0.85em;">(in ${timeUntil})</span>`;
            }
        } else if (schedule) {
            scheduleInfo = `<br><span style="color: #60a5fa;">⏰</span> Next sync: ${schedule}`;
        }

        // Format last sync with status badge
        let lastSyncText = 'Never';
        if (status.lastSync) {
            const statusBadge = status.lastSyncStatus ? 
                `<span style="display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 0.75rem; font-weight: 600; margin-left: 4px; background: ${
                    status.lastSyncStatus === 'success' ? '#065f46' : 
                    status.lastSyncStatus === 'partial' ? '#92400e' : '#7f1d1d'
                }; color: ${
                    status.lastSyncStatus === 'success' ? '#10b981' : 
                    status.lastSyncStatus === 'partial' ? '#fbbf24' : '#ef4444'
                };">${status.lastSyncStatus}</span>` : '';
            lastSyncText = `${formatTime(status.lastSync)}${statusBadge}`;
        }

        // Per-account breakdown for the last sync (#101)
        let accountCountsText = '';
        if (status.lastSyncCounts) {
            const counts = formatAccountCounts(
                status.lastSyncCounts.succeeded,
                status.lastSyncCounts.failed,
                status.lastSyncCounts.skipped
            );
            if (counts !== '-') {
                accountCountsText = `<br><span style="color: #94a3b8; font-size: 0.85em;">Accounts: ${counts}</span>`;
            }
        }
        
        // Version compatibility badge (#158): each server's running version + verdict
        let versionBadge = '';
        if (status.serverVersion || status.versionVerdict) {
            const verdict = status.versionVerdict || 'unknown';
            const vb = {
                'compatible':    { bg: '#065f46', fg: '#10b981', label: 'compatible' },
                'server-behind': { bg: '#1e3a5f', fg: '#60a5fa', label: 'server behind' },
                'server-ahead':  { bg: '#92400e', fg: '#fbbf24', label: 'server ahead — update Actual-sync' },
                'unknown':       { bg: '#334155', fg: '#94a3b8', label: 'unknown' }
            }[verdict] || { bg: '#334155', fg: '#94a3b8', label: 'unknown' };
            const ver = status.serverVersion ? escapeHtml(status.serverVersion) : 'unknown';
            versionBadge = `<br><span style="color: #94a3b8; font-size: 0.85em;">Server version: ${ver} <span style="display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 0.75rem; font-weight: 600; margin-left: 4px; background: ${vb.bg}; color: ${vb.fg};">${vb.label}</span></span>`;
        }

        // Escape server name for safe HTML rendering
        const escapedName = escapeHtml(name);

        const errorDisplay = status.error ? `
            <br>
            <span style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                <span style="color: #ef4444;">Error: ${escapeHtml(status.error)}</span>
                <button data-action="dismissErrorByName" data-server-name="${escapedName}" style="padding: 2px 8px; font-size: 0.75rem; background: #7f1d1d; border-radius: 4px;">Dismiss</button>
            </span>
        ` : '';

        return `
            <li class="server-item ${status.status === 'failure' && !status.errorDismissed ? 'error' : ''}" id="server-${name.replace(/[^a-zA-Z0-9]/g, '_')}">
                <div class="server-name">${escapedName}${encryptionBadge}</div>
                <div class="server-info">
                    Last sync: ${lastSyncText}
                    ${accountCountsText}
                    ${versionBadge}
                    ${scheduleInfo}
                    ${errorDisplay}
                </div>
            </li>
        `;
    }).join('');
}

function updateServerButtons(servers) {
    const container = document.getElementById('server-buttons');
    if (!servers || Object.keys(servers).length === 0) {
        container.innerHTML = '<div class="loading">No servers available</div>';
        return;
    }
    
    // Store server names globally to avoid string escaping issues
    window.__serverNames = Object.keys(servers);

    container.innerHTML = `
        <div class="button-group">
            <button data-action="triggerSync" data-arg="all" class="secondary">Sync All Servers</button>
        </div>
        <div class="button-group" style="margin-top: 10px;">
            ${Object.keys(servers).map((name, index) => {
                return `<button data-action="triggerSyncByIndex" data-arg="${index}">${escapeHtml(name)}</button>`;
            }).join('')}
        </div>
    `;
}

async function triggerSyncByIndex(index) {
    const serverName = window.__serverNames && window.__serverNames[index];
    if (!serverName) {
        alert('Failed to identify server for sync');
        return;
    }
    await triggerSync(serverName);
}

async function triggerSync(serverName) {
    const messageDiv = document.getElementById('sync-message');
    messageDiv.innerHTML = '<div class="loading">Triggering sync...</div>';

    try {
        const response = await fetch('/api/dashboard/sync', {
            ...getFetchOptions(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server: serverName })
        });

        const result = await response.json();

        if (response.ok) {
            messageDiv.innerHTML = `<div class="success-message">✓ Sync triggered for ${serverName === 'all' ? 'all servers' : serverName}</div>`;
            setTimeout(() => { messageDiv.innerHTML = ''; updateDashboard(); }, 3000);
        } else {
            messageDiv.innerHTML = `<div class="error-message">✗ ${result.error || 'Failed to trigger sync'}</div>`;
        }
    } catch (error) {
        messageDiv.innerHTML = `<div class="error-message">✗ Error: ${error.message}</div>`;
    }
}

// The log stream authenticates with a single-use ticket fetched over
// the same authenticated HTTP the rest of the dashboard uses, because a
// browser cannot set an Authorization header on a WebSocket. (#242)
async function fetchWsTicket() {
    const response = await fetch('/api/dashboard/ws-ticket', getFetchOptions());
    if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
    const data = await response.json();
    return data.ticket;
}

function scheduleReconnect(delay) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, delay);
}

async function connectWebSocket() {
    reconnectTimer = null;
    // Don't reconnect if tab is hidden
    if (!isPageVisible) {
        console.log('Tab hidden, deferring WebSocket connection');
        return;
    }
    
    // A ticket request is async, so guard against a second connect
    // (e.g. from the visibility handler) starting while one is in flight.
    if (wsConnecting) return;
    // A live or connecting socket already owns the stream (e.g. a retry timer
    // firing after the visibility handler reconnected). (#280)
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    wsConnecting = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    try {
        const ticket = await fetchWsTicket();
        const wsUrl = `${protocol}//${window.location.host}/ws/logs?ticket=${encodeURIComponent(ticket)}`;
        // Handlers are bound to their own socket: a socket replaced while it was
        // still CLOSING must not schedule a retry or stop the new one's keep-alive. (#280)
        const sock = new WebSocket(wsUrl);
        ws = sock;

        sock.onopen = () => {
            if (sock !== ws) return;
            console.log('WebSocket connected');
            reconnectAttempts = 0;
            reconnectDelay = 1000; // Reset backoff
            // A fresh socket starts with a fresh pong clock; a stale value from
            // before a keep-alive timeout would close it at its first tick. (#280)
            lastPingTime = Date.now();
            addLogEntry('info', 'Connected to log stream');
            
            // Start keep-alive ping
            startKeepAlive();
        };

        sock.onmessage = (event) => {
            if (sock !== ws) return;
            try {
                const data = JSON.parse(event.data);
                
                // Handle pong response
                if (data.type === 'pong') {
                    lastPingTime = Date.now();
                    return;
                }
                
                // Handle log message
                if (data.level) {
                    addLogEntry(data.level, data.message, data.metadata);
                }
            } catch (e) {
                // Plain text message
                addLogEntry('info', event.data);
            }
        };

        sock.onerror = (error) => {
            if (sock !== ws) return;
            console.error('WebSocket error:', error);
            addLogEntry('error', 'WebSocket connection error');
        };

        sock.onclose = () => {
            if (sock !== ws) return;
            console.log('WebSocket disconnected');
            addLogEntry('warn', 'Disconnected from log stream. Reconnecting...');
            
            // Stop keep-alive
            stopKeepAlive();
            
            // Infinite retry with exponential backoff
            reconnectAttempts++;
            const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts), maxReconnectDelay);
            console.log(`Reconnect attempt ${reconnectAttempts} in ${delay}ms`);
            scheduleReconnect(delay);
        };
    } catch (error) {
        console.error('Failed to create WebSocket:', error);
        // Retry with the same backoff as a dropped connection, so a
        // refused ticket request does not poll the server every second.
        reconnectAttempts++;
        const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts), maxReconnectDelay);
        scheduleReconnect(delay);
    } finally {
        wsConnecting = false;
    }
}

function startKeepAlive() {
    stopKeepAlive(); // Clear any existing interval
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            // Check if last pong was too long ago (90s timeout)
            if (Date.now() - lastPingTime > 90000) {
                console.warn('Keep-alive timeout, reconnecting...');
                ws.close();
                return;
            }
            // Send ping to keep connection alive
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000); // Ping every 30 seconds
}

function stopKeepAlive() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

function addLogEntry(level, message, metadata) {
    // Add to ring buffer
    const logEntry = {
        timestamp: new Date().toLocaleTimeString(),
        level: level.toLowerCase(),
        message: message,
        metadata: metadata
    };
    
    if (logBuffer.length < MAX_LOGS) {
        logBuffer.push(logEntry);
    } else {
        // Overwrite oldest entry in ring buffer
        logBuffer[logBufferIndex] = logEntry;
        logBufferIndex = (logBufferIndex + 1) % MAX_LOGS;
    }
    
    // Only update DOM if page is visible (reduce CPU usage)
    if (!isPageVisible) return;
    
    renderLogs();
}

function renderLogs() {
    const logsDiv = document.getElementById('logs');
    const shouldAutoScroll = logsDiv.scrollHeight - logsDiv.scrollTop <= logsDiv.clientHeight + 50;
    
    // Batch DOM updates for better performance
    const fragment = document.createDocumentFragment();
    
    // Get last 200 logs to display (more than visible, less than buffer)
    const displayLogs = logBuffer.slice(-200);
    
    // Clear existing (prevents memory leak from orphaned nodes)
    logsDiv.innerHTML = '';
    
    displayLogs.forEach(log => {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${log.level}`;
        const metaStr = log.metadata ? ` ${JSON.stringify(log.metadata)}` : '';
        entry.textContent = `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}${metaStr}`;
        fragment.appendChild(entry);
    });
    
    logsDiv.appendChild(fragment);
    
    // Auto-scroll to bottom only if user was already at bottom
    if (shouldAutoScroll) {
        logsDiv.scrollTop = logsDiv.scrollHeight;
    }
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// Render the per-sync account breakdown: "N synced · M failed · K skipped".
// Returns '-' for server-level failures where no account was reached
// (all three counts zero/absent), matching notification wording (#101).
function formatAccountCounts(succeeded, failed, skipped) {
    const s = Number(succeeded) || 0;
    const f = Number(failed) || 0;
    const k = Number(skipped) || 0;
    if (s === 0 && f === 0 && k === 0) return '-';
    return `${s} synced · ${f} failed · ${k} skipped`;
}

function formatTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;
    
    // Get user preference from localStorage (default: relative)
    const format = localStorage.getItem('dateFormat') || 'relative';
    
    // For relative format, use time-based logic
    if (format === 'relative') {
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
        // Fall through to formatted date for older entries
    }
    
    // Format based on user preference
    switch (format) {
        case 'locale':
            return date.toLocaleString();
        case 'iso':
            return date.toISOString().replace('T', ' ').substring(0, 19);
        case 'us':
            return date.toLocaleString('en-US', { 
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: true 
            });
        case 'us-short':
            return date.toLocaleString('en-US', { 
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true 
            });
        case 'us-long':
            return date.toLocaleString('en-US', { 
                year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true 
            });
        case 'eu':
            return date.toLocaleString('en-GB', { 
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false 
            });
        case 'eu-short':
            return date.toLocaleString('en-GB', { 
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false 
            });
        case 'eu-long':
            return date.toLocaleString('en-GB', { 
                year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false 
            });
        case 'full':
            return date.toLocaleString('en-US', { 
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true 
            });
        default:
            return date.toLocaleString();
    }
}

// Chart.js configuration
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = '#334155';
Chart.defaults.backgroundColor = 'rgba(59, 130, 246, 0.1)';

let successRateChart = null;
let durationChart = null;
let timelineChart = null;
let serverScheduleInfo = {};

async function dismissErrorByName(button) {
    // Get server name from data attribute (already in correct format)
    const serverName = button.getAttribute('data-server-name');
    if (!serverName) {
        console.error('Failed to get server name from button');
        return;
    }
    
    // Server name is already properly formatted, use directly
    await dismissError(serverName);
}

async function dismissError(serverName) {
    try {
        // Call API to dismiss error on backend
        const response = await fetch('/api/dashboard/dismiss-error', {
            ...getFetchOptions(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server: serverName })
        });

        if (response.ok) {
            // Update UI to remove error display
            const serverId = 'server-' + serverName.replace(/[^a-zA-Z0-9]/g, '_');
            const serverElement = document.getElementById(serverId);
            if (serverElement) {
                serverElement.classList.remove('error');
                const errorSpan = serverElement.querySelector('.server-info span[style*="color: #ef4444"]');
                if (errorSpan && errorSpan.parentElement) {
                    errorSpan.parentElement.remove();
                }
            }
            
            // Refresh dashboard to ensure consistency
            setTimeout(updateDashboard, 500);
        } else {
            console.error('Failed to dismiss error:', await response.text());
        }
    } catch (error) {
        console.error('Error dismissing notification:', error);
    }
}

async function updateCharts() {
    try {
        const response = await fetch('/api/dashboard/metrics', getFetchOptions());
        const metrics = await response.json();

        // Success Rate Chart (Bar Chart)
        const servers = Object.keys(metrics.byServer);
        const successRates = servers.map(s => (metrics.byServer[s].successRate * 100).toFixed(1));
        
        if (successRateChart) {
            successRateChart.data.labels = servers;
            successRateChart.data.datasets[0].data = successRates;
            successRateChart.update();
        } else {
            const ctx1 = document.getElementById('successRateChart').getContext('2d');
            successRateChart = new Chart(ctx1, {
                type: 'bar',
                data: {
                    labels: servers,
                    datasets: [{
                        label: 'Success Rate (%)',
                        data: successRates,
                        backgroundColor: 'rgba(34, 197, 94, 0.5)',
                        borderColor: 'rgba(34, 197, 94, 1)',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            grid: { color: '#334155' }
                        },
                        x: { grid: { display: false } }
                    },
                    plugins: {
                        legend: { display: false }
                    }
                }
            });
        }

        // Duration Chart (Line Chart)
        const durationData = servers.map(s => {
            const recentSyncs = metrics.byServer[s].recentSyncs || [];
            return {
                label: s,
                data: recentSyncs.map((sync, idx) => ({
                    x: idx,
                    y: (sync.duration / 1000).toFixed(1)
                })),
                borderColor: getServerColor(s),
                backgroundColor: getServerColor(s, 0.1),
                tension: 0.3
            };
        });

        if (durationChart) {
            durationChart.data.datasets = durationData;
            durationChart.update();
        } else {
            const ctx2 = document.getElementById('durationChart').getContext('2d');
            durationChart = new Chart(ctx2, {
                type: 'line',
                data: { datasets: durationData },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: 'Duration (seconds)' },
                            grid: { color: '#334155' }
                        },
                        x: {
                            type: 'linear',
                            title: { display: true, text: 'Recent Syncs' },
                            grid: { color: '#334155' }
                        }
                    },
                    plugins: {
                        legend: { position: 'top' }
                    }
                }
            });
        }

        // Timeline Chart (Bar Chart showing success/failure over time)
        const timelineLabels = metrics.timeline.map((s, idx) => {
            const date = new Date(s.timestamp);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        });
        const timelineData = metrics.timeline.map(s => s.status === 'success' ? 1 : -1);
        const timelineColors = metrics.timeline.map(s => 
            s.status === 'success' ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)'
        );

        if (timelineChart) {
            timelineChart.data.labels = timelineLabels;
            timelineChart.data.datasets[0].data = timelineData;
            timelineChart.data.datasets[0].backgroundColor = timelineColors;
            timelineChart.update();
        } else {
            const ctx3 = document.getElementById('timelineChart').getContext('2d');
            timelineChart = new Chart(ctx3, {
                type: 'bar',
                data: {
                    labels: timelineLabels,
                    datasets: [{
                        label: 'Sync Status',
                        data: timelineData,
                        backgroundColor: timelineColors,
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        y: {
                            display: false,
                            min: -1.5,
                            max: 1.5
                        },
                        x: {
                            grid: { display: false }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const sync = metrics.timeline[context.dataIndex];
                                    return [
                                        `Server: ${sync.server}`,
                                        `Status: ${sync.status}`,
                                        `Duration: ${(sync.duration / 1000).toFixed(1)}s`
                                    ];
                                }
                            }
                        }
                    }
                }
            });
        }
    } catch (error) {
        console.error('Failed to update charts:', error);
    }
}

function getServerColor(serverName, alpha = 1) {
    const colors = [
        `rgba(59, 130, 246, ${alpha})`,   // blue
        `rgba(168, 85, 247, ${alpha})`,   // purple
        `rgba(236, 72, 153, ${alpha})`,   // pink
        `rgba(251, 146, 60, ${alpha})`,   // orange
        `rgba(34, 197, 94, ${alpha})`,    // green
        `rgba(14, 165, 233, ${alpha})`,   // sky
    ];
    let hash = 0;
    for (let i = 0; i < serverName.length; i++) {
        hash = serverName.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

// Fetch server information (encryption and schedules)
async function fetchServerInfo() {
    try {
        const response = await fetch('/api/dashboard/servers', getFetchOptions());
        if (response.ok) {
            const data = await response.json();
            serverScheduleInfo = {};
            data.servers.forEach(server => {
                serverScheduleInfo[server.name] = {
                    encrypted: server.encrypted,
                    schedule: server.schedule,
                    cron: server.cron,
                    cronHuman: server.cronHuman,
                    nextInvocation: server.nextInvocation
                };
            });
        }
    } catch (error) {
        console.error('Failed to fetch server information:', error);
    }
}



// Load Analytics Tab
async function loadAnalyticsTab() {
    try {
        const response = await fetch('/api/dashboard/history?limit=1000', getFetchOptions());
        const history = await response.json();
        
        if (history.length > 0) {
            const totalSyncs = history.length;
            const successfulSyncs = history.filter(s => s.status === 'success').length;
            const successRate = ((successfulSyncs / totalSyncs) * 100).toFixed(1);
            const durations = history.filter(s => s.duration_ms).map(s => s.duration_ms);
            const avgDuration = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length / 1000).toFixed(1) : 0;
            const fastestSync = durations.length ? (Math.min(...durations) / 1000).toFixed(1) : 0;
            
            document.getElementById('analytics-total-syncs').textContent = totalSyncs;
            document.getElementById('analytics-success-rate').textContent = `${successRate}%`;
            document.getElementById('analytics-avg-duration').textContent = `${avgDuration}s`;
            document.getElementById('analytics-fastest').textContent = `${fastestSync}s`;
        }
        
        // Reload charts
        updateCharts();
    } catch (error) {
        console.error('Failed to load analytics:', error);
    }
}

// Load History Tab
// Each change of the filter or limit select starts a load; only the newest
// one may render, so a slow earlier response cannot overwrite it. (#288)
let historyRequestSeq = 0;
async function loadHistoryTab() {
    const seq = ++historyRequestSeq;
    try {
        const serverFilter = document.getElementById('history-server-filter')?.value || '';
        const limit = document.getElementById('history-limit')?.value || 50;
        
        let url = `/api/dashboard/history?limit=${limit}`;
        if (serverFilter) {
            url += `&serverName=${encodeURIComponent(serverFilter)}`;
        }
        
        const response = await fetch(url, getFetchOptions());
        const history = response.ok ? await response.json() : null;
        if (seq !== historyRequestSeq) return;

        const tbody = document.getElementById('history-body');
        // A 401/503 reply is an error object, not rows: say so instead of
        // leaving the previous filter's rows under the new label.
        if (!Array.isArray(history)) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center;">Failed to load sync history (HTTP ${escapeHtml(response.status)})</td></tr>`;
            return;
        }
        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No sync history available</td></tr>';
            return;
        }

        tbody.innerHTML = history.map(record => `
            <tr>
                <td>${formatTime(record.timestamp)}</td>
                <td>${escapeHtml(record.server_name)}</td>
                <td>
                    <span class="status-icon ${escapeHtml(record.status)}"></span>
                    ${escapeHtml(record.status)}
                </td>
                <td>${record.duration_ms ? record.duration_ms + 'ms' : '-'}</td>
                <td>${formatAccountCounts(record.accounts_succeeded, record.accounts_failed, record.accounts_skipped)}</td>
                <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(record.error_message || '-')}">
                    ${record.error_message ? `<span style="color: #ef4444;">${escapeHtml(record.error_message)}</span>` : '-'}
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Failed to load history:', error);
    }
}

// Load Settings Tab
// Notification activity + remaining rate-limit budget (#188). Rate
// limiting was previously invisible: a user whose failure alerts were
// being suppressed had nothing telling them so.
async function loadNotificationStats() {
    const el = document.getElementById('notification-stats');
    if (!el) return;
    try {
        const response = await fetch('/api/dashboard/notifications', getFetchOptions());
        if (!response.ok) {
            // Don't leave the card on "Loading…" forever (e.g. 503 when
            // notifications are not configured at all).
            el.innerHTML = '<div style="color: #94a3b8;">Notification statistics unavailable.</div>';
            return;
        }
        const data = await response.json();
        const max = data.rateLimit?.maxPerHour;
        const servers = Object.entries(data.perServerStats || {});

        const summary = `
            <div style="margin-bottom: 12px;">
                <strong>${data.notificationsSentLastHour ?? 0}</strong> failure alerts in the last hour
                ${max ? ` &middot; <strong>${data.rateLimitRemaining ?? 0}</strong> of ${max} remaining` : ''}
            </div>`;

        const rows = servers.length === 0
            ? '<div style="color: #94a3b8;">No notifications sent yet.</div>'
            : servers.map(([name, s]) => {
                const exhausted = (s.rateLimitRemaining ?? 1) === 0;
                const failures = data.consecutiveFailuresByServer?.[name] || 0;
                return `
                    <div style="display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid #1e293b;">
                        <span>${name}</span>
                        <span style="color: ${exhausted ? '#f87171' : '#94a3b8'};">
                            ${s.notificationsSentLastHour ?? 0} alerts
                            ${max ? ` &middot; ${s.rateLimitRemaining ?? 0} left` : ''}
                            ${exhausted ? ' &middot; suppressed' : ''}
                            ${failures ? ` &middot; ${failures} consecutive failures` : ''}
                        </span>
                    </div>`;
            }).join('');

        el.innerHTML = summary + rows;
    } catch (error) {
        console.error('Failed to load notification stats:', error);
        el.innerHTML = '<div style="color: #94a3b8;">Notification statistics unavailable.</div>';
    }
}

async function loadSettingsTab() {
    loadNotificationStats();
    try {
        const response = await fetch('/api/dashboard/status', getFetchOptions());
        const data = await response.json();
        
        // Populate server select dropdown
        const select = document.getElementById('reset-server-select');
        if (select && data.servers) {
            select.innerHTML = '<option value="">Select a server...</option>' +
                Object.keys(data.servers).map(name => 
                    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
                ).join('');
        }
        
        // Also populate history filter
        const historyFilter = document.getElementById('history-server-filter');
        if (historyFilter && data.servers) {
            const currentValue = historyFilter.value;
            historyFilter.innerHTML = '<option value="">All Servers</option>' +
                Object.keys(data.servers).map(name => 
                    `<option value="${escapeHtml(name)}" ${currentValue === name ? 'selected' : ''}>${escapeHtml(name)}</option>`
                ).join('');
        }
        
        // Load orphaned servers (servers in history but not in config)
        await loadOrphanedServers(Object.keys(data.servers));
        
        // Load date format preference
        loadDateFormatPreference();
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

async function loadOrphanedServers(configuredServers) {
    try {
        const response = await fetch('/api/dashboard/orphaned-servers', getFetchOptions());
        const result = await response.json();
        
        const orphanedDiv = document.getElementById('orphaned-servers-list');
        
        if (result.orphaned && result.orphaned.length > 0) {
            orphanedDiv.innerHTML = result.orphaned.map((server, index) => {
                // Escape HTML entities to prevent XSS and handle special characters
                const escapedName = escapeHtml(server.server_name);

                return `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: #1e293b; border-radius: 4px; margin-bottom: 8px;">
                    <div>
                        <div style="color: #e2e8f0; font-weight: 500;">${escapedName}</div>
                        <div style="color: #94a3b8; font-size: 0.85rem;">${server.sync_count} sync records</div>
                    </div>
                    <button data-action="deleteOrphanedServerByIndex" data-arg="${index}" data-server-name="${escapedName}" class="danger" style="padding: 6px 12px; font-size: 0.85rem;">Delete History</button>
                </div>
            `;
            }).join('');
            
            // Store orphaned servers in a global variable for deletion
            window.__orphanedServers = result.orphaned;
        } else {
            orphanedDiv.innerHTML = '<div style="color: #94a3b8; padding: 10px; background: #1e293b; border-radius: 4px;">No orphaned servers found</div>';
        }
    } catch (error) {
        console.error('Failed to load orphaned servers:', error);
        document.getElementById('orphaned-servers-list').innerHTML = '<div style="color: #ef4444;">Failed to load orphaned servers</div>';
    }
}

async function deleteOrphanedServerByIndex(index) {
    // Get server name from global storage (avoids string escaping issues)
    const server = window.__orphanedServers && window.__orphanedServers[index];
    if (!server) {
        alert('Failed to identify server for deletion');
        return;
    }
    
    await deleteOrphanedServer(server.server_name);
}

async function deleteOrphanedServer(serverName) {
    if (!confirm(`Delete all sync history for "${serverName}"?\n\nThis server is no longer in your configuration.`)) {
        return;
    }
    
    try {
        const response = await fetch('/api/dashboard/reset-history', {
            ...getFetchOptions(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server: serverName })
        });
        
        if (response.ok) {
            // Reload orphaned servers list
            const statusResponse = await fetch('/api/dashboard/status', getFetchOptions());
            const statusData = await statusResponse.json();
            await loadOrphanedServers(Object.keys(statusData.servers));
            
            // Refresh other tabs
            loadHistoryTab();
            loadAnalyticsTab();
        }
    } catch (error) {
        console.error('Failed to delete orphaned server:', error);
        alert('Failed to delete server history');
    }
}

let savedDateFormat = null; // Track saved state for unsaved changes detection

function loadDateFormatPreference() {
    const select = document.getElementById('date-format-select');
    savedDateFormat = localStorage.getItem('dateFormat') || 'relative';
    if (select) {
        select.value = savedDateFormat;
    }
    updateDateFormatPreview();
    updateDateFormatButtons();
}

function onDateFormatChange() {
    updateDateFormatPreview();
    updateDateFormatButtons();
}

function updateDateFormatButtons() {
    const select = document.getElementById('date-format-select');
    const saveBtn = document.getElementById('save-date-format-btn');
    const resetBtn = document.getElementById('reset-date-format-btn');
    const unsavedIndicator = document.getElementById('date-format-unsaved');
    
    if (!select || !saveBtn || !resetBtn || !unsavedIndicator) return;
    
    const currentValue = select.value;
    const hasChanges = currentValue !== savedDateFormat;
    
    // Show/hide unsaved changes indicator
    unsavedIndicator.style.display = hasChanges ? 'inline' : 'none';
    
    // Enable/disable save button
    if (hasChanges) {
        saveBtn.disabled = false;
        saveBtn.style.opacity = '1';
        saveBtn.style.cursor = 'pointer';
        saveBtn.style.background = '#3b82f6';
        resetBtn.style.display = 'inline-block';
    } else {
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.5';
        saveBtn.style.cursor = 'not-allowed';
        saveBtn.style.background = '';
        resetBtn.style.display = 'none';
    }
}

function saveDateFormat() {
    const select = document.getElementById('date-format-select');
    const messageDiv = document.getElementById('date-format-message');
    
    if (!select) return;
    
    const format = select.value;
    localStorage.setItem('dateFormat', format);
    savedDateFormat = format;
    
    // Show success message
    messageDiv.innerHTML = '<div class="success-message">✓ Preferences saved</div>';
    setTimeout(() => { messageDiv.innerHTML = ''; }, 2000);
    
    // Update UI
    updateDateFormatButtons();
    
    // Refresh all displays to show new format
    updateDashboard();
    loadRecentActivity();
    const currentTab = document.querySelector('.tab.active');
    if (currentTab && currentTab.textContent.includes('History')) {
        loadHistoryTab();
    }
}

function resetDateFormat() {
    const select = document.getElementById('date-format-select');
    if (select && savedDateFormat) {
        select.value = savedDateFormat;
        updateDateFormatPreview();
        updateDateFormatButtons();
    }
}

function updateDateFormatPreview() {
    const previewText = document.getElementById('date-preview-text');
    const select = document.getElementById('date-format-select');
    
    if (!previewText || !select) return;
    
    // Temporarily set format to preview
    const originalFormat = localStorage.getItem('dateFormat');
    localStorage.setItem('dateFormat', select.value);
    
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    previewText.textContent = formatTime(fiveMinutesAgo.toISOString());
    
    // Restore original format
    if (originalFormat) {
        localStorage.setItem('dateFormat', originalFormat);
    } else {
        localStorage.removeItem('dateFormat');
    }
}

// Reset history functions
async function resetHistory(server) {
    if (!confirm(`⚠️ Are you ABSOLUTELY SURE you want to delete ${server === 'all' ? 'ALL sync history' : 'history for ' + server}?\n\nThis action CANNOT be undone!`)) {
        return;
    }
    
    const messageDiv = document.getElementById('reset-all-message');
    messageDiv.innerHTML = '<div class="loading">Resetting history...</div>';
    
    try {
        const response = await fetch('/api/dashboard/reset-history', {
            ...getFetchOptions(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            messageDiv.innerHTML = `<div class="success-message">✓ ${result.message}</div>`;
            setTimeout(() => {
                messageDiv.innerHTML = '';
                updateDashboard();
                loadAnalyticsTab();
                loadHistoryTab();
            }, 2000);
        } else {
            messageDiv.innerHTML = `<div class="error-message">✗ ${result.error || 'Failed to reset history'}</div>`;
        }
    } catch (error) {
        messageDiv.innerHTML = `<div class="error-message">✗ Error: ${error.message}</div>`;
    }
}

async function resetServerHistory() {
    const select = document.getElementById('reset-server-select');
    const server = select?.value;
    
    if (!server) {
        alert('Please select a server first');
        return;
    }
    
    if (!confirm(`⚠️ Are you sure you want to delete all sync history for "${server}"?\n\nThis action CANNOT be undone!`)) {
        return;
    }
    
    const messageDiv = document.getElementById('reset-server-message');
    messageDiv.innerHTML = '<div class="loading">Resetting history...</div>';
    
    try {
        const response = await fetch('/api/dashboard/reset-history', {
            ...getFetchOptions(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            messageDiv.innerHTML = `<div class="success-message">✓ ${result.message}</div>`;
            setTimeout(() => {
                messageDiv.innerHTML = '';
                updateDashboard();
                loadAnalyticsTab();
                loadHistoryTab();
            }, 2000);
        } else {
            messageDiv.innerHTML = `<div class="error-message">✗ ${result.error || 'Failed to reset history'}</div>`;
        }
    } catch (error) {
        messageDiv.innerHTML = `<div class="error-message">✗ Error: ${error.message}</div>`;
    }
}

async function clearAllErrors() {
    const messageDiv = document.getElementById('clear-errors-message');
    messageDiv.innerHTML = '<div class="loading">Clearing errors...</div>';
    
    try {
        const statusResponse = await fetch('/api/dashboard/status', getFetchOptions());
        const data = await statusResponse.json();
        
        const servers = Object.keys(data.servers || {});
        let cleared = 0;
        
        for (const server of servers) {
            try {
                await fetch('/api/dashboard/dismiss-error', {
                    ...getFetchOptions(),
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ server })
                });
                cleared++;
            } catch (e) {
                console.error(`Failed to clear error for ${server}:`, e);
            }
        }
        
        messageDiv.innerHTML = `<div class="success-message">✓ Cleared errors for ${cleared} server(s)</div>`;
        setTimeout(() => {
            messageDiv.innerHTML = '';
            updateDashboard();
        }, 2000);
    } catch (error) {
        messageDiv.innerHTML = `<div class="error-message">✗ Error: ${error.message}</div>`;
    }
}

// Load recent activity for Overview tab
async function loadRecentActivity() {
    try {
        const response = await fetch('/api/dashboard/history?limit=5', getFetchOptions());
        const history = await response.json();
        
        const activityDiv = document.getElementById('recent-activity');
        if (history.length === 0) {
            activityDiv.innerHTML = '<div style="color: #94a3b8; padding: 10px;">No recent activity</div>';
            return;
        }
        
        activityDiv.innerHTML = history.map(record => {
            const icon = record.status === 'success' ? '✓' : '✗';
            const color = record.status === 'success' ? '#10b981' : '#ef4444';
            const duration = record.duration_ms ? `(${(record.duration_ms / 1000).toFixed(1)}s)` : '';
            const counts = formatAccountCounts(record.accounts_succeeded, record.accounts_failed, record.accounts_skipped);
            const countsDisplay = counts !== '-'
                ? `<span style="color: #64748b;"> · ${counts}</span>`
                : '';

            return `
                <div style="padding: 8px 0; border-bottom: 1px solid #334155;">
                    <span style="color: ${color};">${icon}</span>
                    <span style="color: #e2e8f0;">${formatTime(record.timestamp)}</span>
                    <span style="color: #94a3b8;"> - ${record.server_name}</span>
                    <span style="color: #64748b;"> ${duration}</span>
                    ${countsDisplay}
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load recent activity:', error);
    }
}

// Test Notification Function
async function testNotification(channel) {
    const messageDiv = document.getElementById('test-notification-message');
    messageDiv.innerHTML = `<div class="loading">Sending test ${channel} notification...</div>`;

    try {
        const response = await fetch('/api/dashboard/test-notification', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ channel })
        });

        const data = await response.json();

        if (response.ok) {
            messageDiv.innerHTML = `<div class="success">✓ ${data.message}</div>`;
        } else {
            messageDiv.innerHTML = `<div class="error">✗ ${data.error}${data.details ? ': ' + data.details : ''}</div>`;
        }

        // Clear message after 5 seconds
        setTimeout(() => {
            messageDiv.innerHTML = '';
        }, 5000);
    } catch (error) {
        messageDiv.innerHTML = `<div class="error">✗ Failed to send test notification: ${error.message}</div>`;
        setTimeout(() => {
            messageDiv.innerHTML = '';
        }, 5000);
    }
}

// ---------------------------------------------------------------------------
// Payments tab (#341). Renders GET /api/dashboard/payments (#260), a persisted
// snapshot, so it needs no connection to Actual. Everything is built with
// textContent / setAttribute / className, never innerHTML: schedule, payee,
// account and server names are shown literally. No inline styles (CSP, #243).
// ---------------------------------------------------------------------------

// Intervals are read ONCE when this script loads, so an E2E spec can inject
// short ones with evaluateOnNewDocument. Defaults: 60 s refresh, 2 s status
// poll after "Sync now", capped by an iteration count (not Date.now(), which a
// frozen page clock would never advance) at 120 s worth of reads.
function readPositiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
const PAYMENTS_POLL_MS = readPositiveNumber(window.__paymentsPollMs, 60000);
const PAYMENTS_SYNC_POLL_MS = readPositiveNumber(window.__paymentsSyncPollMs, 2000);
const PAYMENTS_SYNC_MAX_POLLS = Math.floor(readPositiveNumber(
    window.__paymentsSyncMaxPolls, Math.ceil(120000 / PAYMENTS_SYNC_POLL_MS)
));

// Needs attention: the user must look at it. Order: attention first, then the rest.
const PAYMENT_ATTENTION_STATES = ['missing', 'wrongAmount', 'cannotCheck'];
const PAYMENT_STATE_ORDER = ['missing', 'wrongAmount', 'cannotCheck', 'late', 'upcoming', 'received', 'skipped'];
const PAYMENT_STATE_LABELS = {
    upcoming: 'Upcoming', received: 'Received', late: 'Late', missing: 'Missing',
    wrongAmount: 'Wrong amount', cannotCheck: 'Cannot check', skipped: 'Skipped'
};
const PAYMENTS_README_URL = 'https://github.com/agigante80/Actual-sync#-missing-payment-alerts';

let paymentsServers = null;       // last good response: [{ server, configured, lastRun, items }]
let paymentsServerNames = [];     // names for the select, from the last unfiltered response
let paymentsLoadError = '';       // '' when the last refresh worked
let paymentsStateFilter = 'all';  // all | attention | ok
let paymentsSearch = '';
let paymentsInFlight = false;
let paymentsRequestSeq = 0;
const paymentsExpanded = new Set();   // row keys whose occurrence strip is open
const paymentsSyncing = new Set();    // server names with a started sync being watched
const paymentsSyncErrors = new Map(); // server name -> "Could not start sync (...)"
const paymentsSyncAlertEls = new Map(); // server name -> its role=alert node, reused across renders
const paymentsQueued = new Set();     // subset of paymentsSyncing whose POST succeeded
let paymentsWatching = false;         // one shared status loop for every server in paymentsSyncing
let paymentsNullStreak = 0;           // consecutive successful null runningSync reads of that loop

function paymentsTabActive() {
    const tab = document.getElementById('payments-tab');
    return !!tab && tab.classList.contains('active');
}

// A calendar date (YYYY-MM-DD) is not an instant: new Date('2026-01-11') is UTC
// midnight and shows the previous day west of UTC, and formatTime would call a
// future date "Just now". So split the string, build the date in UTC and format
// with timeZone 'UTC', date fields only, following the same dateFormat setting.
function formatCalendarDate(ymd) {
    if (ymd == null || ymd === '') return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
    if (!m) return String(ymd);
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const format = localStorage.getItem('dateFormat') || 'relative';
    const fmt = (locale, options) => date.toLocaleDateString(locale, { ...options, timeZone: 'UTC' });
    switch (format) {
        case 'iso':
        case 'relative': // relative makes no sense for a due date
            return `${m[1]}-${m[2]}-${m[3]}`;
        case 'us':
            return fmt('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
        case 'us-short':
            return fmt('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        case 'us-long':
            return fmt('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        case 'eu':
            return fmt('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });
        case 'eu-short':
            return fmt('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
        case 'eu-long':
            return fmt('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
        case 'full':
            return fmt('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        default: // 'locale' and any unknown stored value, as formatTime's default
            return fmt(undefined, {});
    }
}

// Cents as a plain decimal, no currency symbol (as the notifications print it).
function formatPaymentAmount(amount) {
    const dec = (cents) => (cents / 100).toFixed(2);
    if (amount == null) return '';
    if (typeof amount === 'number') return dec(amount);
    if (typeof amount === 'object') return `${dec(amount.num1)} to ${dec(amount.num2)}`;
    return '';
}

function paymentNeedsAttention(item) {
    return PAYMENT_ATTENTION_STATES.includes(item.state);
}

function paymentStateRank(state) {
    const i = PAYMENT_STATE_ORDER.indexOf(state);
    return i === -1 ? PAYMENT_STATE_ORDER.length : i;
}

// Attention first, then late, upcoming, received, skipped; within a group by
// deadline ascending (null last), then name.
function sortPaymentItems(items) {
    return items.slice().sort((a, b) => {
        const byState = paymentStateRank(a.state) - paymentStateRank(b.state);
        if (byState) return byState;
        if (a.deadline !== b.deadline) {
            if (a.deadline == null) return 1;
            if (b.deadline == null) return -1;
            return a.deadline < b.deadline ? -1 : 1;
        }
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

function paymentMatchesFilters(item) {
    if (paymentsStateFilter === 'attention' && !paymentNeedsAttention(item)) return false;
    if (paymentsStateFilter === 'ok' && paymentNeedsAttention(item)) return false;
    const q = paymentsSearch.trim().toLowerCase();
    if (!q) return true;
    return [item.name, item.payee, item.account, item.cadenceText]
        .some((v) => v != null && String(v).toLowerCase().includes(q));
}

function payEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function payPill(state) {
    const known = Object.prototype.hasOwnProperty.call(PAYMENT_STATE_LABELS, state);
    return payEl('span', `pay-pill pay-${known ? state : 'unknown'}`, known ? PAYMENT_STATE_LABELS[state] : String(state));
}

function payCell(label, text, extraClass) {
    const td = payEl('td', extraClass || '', text);
    td.setAttribute('data-label', label);
    return td;
}

function paymentOccurrenceList(item) {
    const list = payEl('ul', 'pay-occ');
    for (const o of item.occurrences || []) {
        const li = document.createElement('li');
        li.appendChild(payEl('span', '', `${formatCalendarDate(o.date)} `));
        li.appendChild(payPill(o.state));
        const parts = [];
        if (o.receivedDate) parts.push(`received ${formatCalendarDate(o.receivedDate)}`);
        if (o.state === 'late' && o.daysLate != null) parts.push(`(+${o.daysLate}d)`);
        if (o.receivedAmount != null) parts.push(formatPaymentAmount(o.receivedAmount));
        if (parts.length) li.appendChild(payEl('span', '', ` ${parts.join(' ')}`));
        list.appendChild(li);
    }
    return list;
}

function paymentRowKey(server, item) {
    return JSON.stringify([server, item.alertId, item.scheduleId]);
}

function appendPaymentRows(tbody, group, items, groupIndex) {
    items.forEach((item, rowIndex) => {
        const key = paymentRowKey(group.server, item);
        const stripId = `pay-strip-${groupIndex}-${rowIndex}`;
        const open = paymentsExpanded.has(key);

        const tr = payEl('tr', 'pay-row');
        const stateTd = payCell('State', null);
        stateTd.appendChild(payPill(item.state));
        tr.appendChild(stateTd);

        const nameTd = payCell('Name', null);
        const toggle = payEl('button', 'pay-expand', open ? '▾' : '▸');
        toggle.type = 'button';
        toggle.setAttribute('data-action', 'togglePaymentRow');
        toggle.setAttribute('data-arg', stripId);
        toggle.setAttribute('data-key', key);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-controls', stripId);
        toggle.setAttribute('aria-label', `Show occurrences of ${item.name || ''}`);
        nameTd.appendChild(toggle);
        nameTd.appendChild(document.createTextNode(item.name || ''));
        tr.appendChild(nameTd);

        tr.appendChild(payCell('Cadence', item.cadenceText || ''));
        tr.appendChild(payCell('Account', item.account || '', 'pay-extra'));
        tr.appendChild(payCell('Amount', formatPaymentAmount(item.expectedAmount), 'pay-num'));
        tr.appendChild(payCell('Next due', formatCalendarDate(item.nextDate)));
        tr.appendChild(payCell('Deadline', formatCalendarDate(item.deadline)));
        tr.appendChild(payCell('Last alert', item.lastAlertAt ? formatTime(item.lastAlertAt) : '', 'pay-extra'));
        tr.appendChild(payCell('Source', item.source || '', 'pay-extra'));
        tbody.appendChild(tr);

        const strip = payEl('tr', 'pay-strip-row');
        strip.id = stripId;
        strip.hidden = !open;
        const td = payEl('td', 'pay-strip-cell');
        td.colSpan = 9;
        // Below 768 px the Account, Last alert and Source cells are hidden;
        // this list is where they live then (hidden by CSS above that width).
        const details = payEl('dl', 'pay-details');
        [['Account', item.account || ''], ['Last alert', item.lastAlertAt ? formatTime(item.lastAlertAt) : ''],
            ['Source', item.source || '']].forEach(([label, value]) => {
            const row = document.createElement('div');
            row.appendChild(payEl('dt', '', label));
            row.appendChild(payEl('dd', '', value));
            details.appendChild(row);
        });
        td.appendChild(details);
        td.appendChild(paymentOccurrenceList(item));
        strip.appendChild(td);
        tbody.appendChild(strip);
    });
}

function buildPaymentsTable(group, groupIndex) {
    const table = payEl('table', 'pay-table');
    const headRow = document.createElement('tr');
    ['State', 'Name', 'Cadence', 'Account', 'Amount', 'Next due', 'Deadline', 'Last alert', 'Source']
        .forEach((h) => headRow.appendChild(payEl('th', '', h)));
    const thead = document.createElement('thead');
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const shown = sortPaymentItems(group.items.filter(paymentMatchesFilters));
    if (shown.length === 0) {
        const tr = document.createElement('tr');
        const td = payEl('td', 'pay-empty', group.items.length === 0 ? 'No watched schedules' : 'No matching schedules');
        td.colSpan = 9;
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        appendPaymentRows(tbody, group, shown, groupIndex);
    }
    const wrap = payEl('div', 'pay-table-wrap');
    wrap.appendChild(table);
    return wrap;
}

function buildPaymentsGroup(group, groupIndex) {
    const section = payEl('section', 'pay-group');
    const head = payEl('div', 'pay-group-head');
    head.appendChild(payEl('h3', 'pay-group-title', group.server));
    const run = group.lastRun;

    if (!group.configured) {
        section.appendChild(head);
        const note = payEl('p', 'pay-note', 'Missing-payment alerts are not configured for this server. ');
        const link = payEl('a', '', 'README');
        link.href = PAYMENTS_README_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        note.appendChild(link);
        section.appendChild(note);
        return section;
    }

    // As-of line: lastSuccessAt, an instant, so formatTime.
    if (run && run.lastSuccessAt) {
        head.appendChild(payEl('span', 'pay-asof', `as of ${formatTime(run.lastSuccessAt)}`));
    } else {
        // A configured server that has never evaluated: the as-of line says so.
        head.appendChild(payEl('span', 'pay-asof', run ? 'No successful evaluation yet' : ''));
    }

    // Exactly one Sync now per configured group, whatever its lastRun.
    const syncing = paymentsSyncing.has(group.server);
    const syncBtn = payEl('button', '', syncing ? 'Syncing...' : 'Sync now');
    syncBtn.type = 'button';
    syncBtn.setAttribute('data-action', 'paymentsSyncNow');
    syncBtn.setAttribute('data-arg', group.server);
    syncBtn.disabled = syncing;
    head.appendChild(syncBtn);

    const syncError = paymentsSyncErrors.get(group.server);
    if (syncError) {
        // Reuse the node and rewrite its text only on change, so a re-render
        // (search keystroke, poll) does not make a screen reader announce it again.
        let alertEl = paymentsSyncAlertEls.get(group.server);
        if (!alertEl) {
            alertEl = payEl('div', 'pay-sync-error', '');
            alertEl.setAttribute('role', 'alert');
            paymentsSyncAlertEls.set(group.server, alertEl);
        }
        if (alertEl.textContent !== syncError) alertEl.textContent = syncError;
        head.appendChild(alertEl);
    } else {
        paymentsSyncAlertEls.delete(group.server);
    }
    section.appendChild(head);

    if (!run) {
        section.appendChild(payEl('p', 'pay-note', 'Runs after the next sync'));
        return section;
    }

    const failureParts = [];
    if (!run.ok) failureParts.push(`last evaluation failed at ${formatTime(run.at)} (${run.errorCode})`);
    if (run.rulesErrored > 0) {
        failureParts.push(`${run.rulesErrored} rule(s) could not be evaluated; their last values are shown`);
    }
    if (failureParts.length) section.appendChild(payEl('p', 'pay-failure', failureParts.join('. ')));

    if (run.lastSuccessAt) section.appendChild(buildPaymentsTable(group, groupIndex));
    return section;
}

function renderPayments() {
    const content = document.getElementById('payments-content');
    const summary = document.getElementById('payments-summary');
    const errorEl = document.getElementById('payments-error');
    if (!content) return;

    if (errorEl.textContent !== paymentsLoadError) errorEl.textContent = paymentsLoadError;
    errorEl.hidden = !paymentsLoadError;

    // Keep the server select in step with the configured servers.
    const select = document.getElementById('payments-server');
    const wanted = ['', ...paymentsServerNames];
    const have = [...select.options].map((o) => o.value);
    if (wanted.length !== have.length || wanted.some((v, i) => v !== have[i])) {
        const current = select.value;
        select.textContent = '';
        wanted.forEach((name) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name === '' ? 'All' : name;
            select.appendChild(opt);
        });
        select.value = wanted.includes(current) ? current : '';
    }

    document.querySelectorAll('[data-action="setPaymentStateFilter"]').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.arg === paymentsStateFilter ? 'true' : 'false');
    });

    content.textContent = '';
    if (!paymentsServers) {
        summary.textContent = '';
        // No data yet: an error shows with an empty table, otherwise we are loading.
        if (paymentsLoadError) {
            const empty = buildPaymentsTable({ server: '', items: [] }, 0);
            empty.querySelector('tbody').textContent = '';
            content.appendChild(empty);
        }
        else content.appendChild(payEl('div', 'loading', 'Loading payments...'));
        return;
    }

    let watched = 0;
    let attention = 0;
    for (const group of paymentsServers) {
        watched += group.items.length;
        attention += group.items.filter(paymentNeedsAttention).length;
    }
    summary.textContent = `${watched} watched · ${attention} need attention`;
    paymentsServers.forEach((group, i) => content.appendChild(buildPaymentsGroup(group, i)));
}

// Any non-2xx or a network error is a load failure: keep the last good rows and
// say so above the table; the next successful refresh clears it.
async function loadPaymentsTab(force) {
    if (paymentsInFlight && !force) return;
    const seq = ++paymentsRequestSeq;
    paymentsInFlight = true;
    try {
        const select = document.getElementById('payments-server');
        const server = select ? select.value : '';
        const url = '/api/dashboard/payments' + (server ? `?server=${encodeURIComponent(server)}` : '');
        let message = '';
        let body = null;
        try {
            const response = await fetch(url, getFetchOptions());
            if (!response.ok) message = `Could not refresh payments (HTTP ${response.status})`;
            else body = await response.json();
        } catch (e) {
            message = 'Could not refresh payments (network error)';
        }
        if (seq !== paymentsRequestSeq) return; // a newer request owns the view
        if (body && Array.isArray(body.servers)) {
            paymentsServers = body.servers;
            paymentsLoadError = '';
            if (!server) paymentsServerNames = body.servers.map((g) => g.server);
        } else if (!message) {
            message = 'Could not refresh payments (invalid response)';
        }
        if (message) paymentsLoadError = message;
        renderPayments();
    } finally {
        if (seq === paymentsRequestSeq) paymentsInFlight = false;
    }
}

function togglePaymentRow(stripId, button) {
    const strip = document.getElementById(stripId);
    if (!strip) return;
    const open = strip.hidden; // hidden now, so it is about to open
    strip.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.textContent = open ? '▾' : '▸';
    const key = button.getAttribute('data-key');
    if (open) paymentsExpanded.add(key); else paymentsExpanded.delete(key);
}

function setPaymentStateFilter(value) {
    paymentsStateFilter = ['attention', 'ok'].includes(value) ? value : 'all';
    renderPayments();
}

function onPaymentsServerChange() {
    loadPaymentsTab(true);
}

function onPaymentsSearch(arg, input) {
    paymentsSearch = input.value;
    renderPayments();
}

// "Sync now" for one server: POST, then poll /api/dashboard/status until
// runningSync has been null on two CONSECUTIVE successful reads (a read before
// the queue picks the job up is not "done"), then refresh once.
async function paymentsSyncNow(serverName) {
    if (!serverName || paymentsSyncing.has(serverName)) return;
    // Mark the server busy before the fetch: the button is disabled at once, so
    // a double-click cannot send a second POST or start a second loop.
    paymentsSyncErrors.delete(serverName);
    paymentsSyncing.add(serverName);
    renderPayments();
    let failure = '';
    try {
        const response = await fetch('/api/dashboard/sync', {
            ...getFetchOptions(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server: serverName })
        });
        if (!response.ok) failure = `Could not start sync (HTTP ${response.status})`;
    } catch (e) {
        failure = 'Could not start sync (network error)';
    }
    if (failure) {
        paymentsSyncing.delete(serverName);
        paymentsSyncErrors.set(serverName, failure);
        renderPayments();
        return; // no polling for this server; the next click retries
    }
    paymentsQueued.add(serverName);
    paymentsNullStreak = 0; // a job was just queued: earlier null reads no longer count
    if (!paymentsWatching) await watchPaymentsSync();
}

// ONE status loop serves every server in paymentsSyncing (the per-IP limiter
// is 60/min; a loop per click would exceed it and 429 its own reads).
async function watchPaymentsSync() {
    paymentsWatching = true;
    let stopped = false;
    try {
        // Counted in iterations, not time: the E2E page clock is frozen.
        for (let reads = 0; reads < PAYMENTS_SYNC_MAX_POLLS && paymentsSyncing.size > 0; reads++) {
            await new Promise((resolve) => setTimeout(resolve, PAYMENTS_SYNC_POLL_MS));
            if (paymentsSyncing.size === 0) break;
            if (document.hidden || !paymentsTabActive()) { stopped = true; break; }
            try {
                const response = await fetch('/api/dashboard/status', getFetchOptions());
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const status = await response.json();
                paymentsNullStreak = status && status.runningSync ? 0 : paymentsNullStreak + 1;
            } catch (e) {
                paymentsNullStreak = 0; // a failed read never counts toward the two
            }
            if (paymentsNullStreak >= 2) break;
        }
    } finally {
        paymentsWatching = false;
    }
    // Only servers whose POST succeeded are done; one still posting stays busy
    // and gets a fresh loop when its POST resolves.
    const hadSyncs = paymentsQueued.size > 0;
    paymentsQueued.forEach((name) => paymentsSyncing.delete(name));
    paymentsQueued.clear();
    if (stopped) { renderPayments(); return; } // switching back refreshes
    if (hadSyncs) await loadPaymentsTab(true);
    else renderPayments();
}

// 60 s refresh: skipped while the page is hidden or another tab is showing.
setInterval(() => {
    if (document.hidden || !paymentsTabActive()) return;
    loadPaymentsTab();
}, PAYMENTS_POLL_MS);

// Event wiring. The page's CSP forbids inline handler attributes, so
// buttons carry data-action (+ optional data-arg) and selects carry
// data-change; one delegated listener per event type dispatches them.
// Every action receives (arg, element). Rendered-by-innerHTML buttons
// work without rebinding because the listener sits on document. (#243)
const CLICK_ACTIONS = {
    switchTab: (arg, el) => switchTab(arg, el),
    loadHistoryTab: () => loadHistoryTab(),
    resetHistory: (arg) => resetHistory(arg),
    resetServerHistory: () => resetServerHistory(),
    testNotification: (arg) => testNotification(arg),
    saveDateFormat: () => saveDateFormat(),
    resetDateFormat: () => resetDateFormat(),
    clearAllErrors: () => clearAllErrors(),
    dismissErrorByName: (arg, el) => dismissErrorByName(el),
    triggerSync: (arg) => triggerSync(arg),
    triggerSyncByIndex: (arg) => triggerSyncByIndex(Number(arg)),
    deleteOrphanedServerByIndex: (arg) => deleteOrphanedServerByIndex(Number(arg)),
    togglePaymentRow: (arg, el) => togglePaymentRow(arg, el),
    setPaymentStateFilter: (arg) => setPaymentStateFilter(arg),
    paymentsSyncNow: (arg) => paymentsSyncNow(arg)
};
const CHANGE_ACTIONS = {
    renderAccounts: () => renderAccounts(),
    onDateFormatChange: () => onDateFormatChange(),
    loadHistoryTab: () => loadHistoryTab(),
    onPaymentsServerChange: () => onPaymentsServerChange()
};
const INPUT_ACTIONS = {
    onPaymentsSearch: (arg, el) => onPaymentsSearch(arg, el)
};

document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-action]');
    const action = el && CLICK_ACTIONS[el.dataset.action];
    if (action) action(el.dataset.arg, el);
});
document.addEventListener('change', (e) => {
    const el = e.target.closest && e.target.closest('[data-change]');
    const action = el && CHANGE_ACTIONS[el.dataset.change];
    if (action) action(undefined, el);
});
document.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('[data-input]');
    const action = el && INPUT_ACTIONS[el.dataset.input];
    if (action) action(undefined, el);
});

// Hide the header logo if /icon.png fails. 'error' does not bubble, so it
// is bound on the element; the complete/naturalWidth check covers a
// failure that happened before this script ran.
(function hideBrokenLogo() {
    const logo = document.querySelector('.header-logo');
    if (!logo) return;
    const hide = () => { logo.style.display = 'none'; };
    logo.addEventListener('error', hide);
    if (logo.complete && logo.naturalWidth === 0) hide();
})();

// Initialize
fetchServerInfo().then(() => {
    updateDashboard();
    loadRecentActivity();
    updateCharts();
    connectWebSocket();
    loadSettingsTab();
});

// Refresh dashboard every 30 seconds
setInterval(updateDashboard, 30000);
setInterval(loadRecentActivity, 30000);
setInterval(updateCharts, 60000);

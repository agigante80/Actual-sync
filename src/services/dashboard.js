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
    loadConfigAudit();
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
        await loadOrphanedOverrides();
        
        // Load date format preference
        loadDateFormatPreference();
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

// Configuration changes list (#259). Every field goes through escapeHtml().
async function loadConfigAudit() {
    const el = document.getElementById('config-audit-list');
    if (!el) return;
    try {
        const response = await fetch('/api/dashboard/config-audit?limit=50', getFetchOptions());
        if (!response.ok) {
            el.innerHTML = `<div style="color: #ef4444;">Failed to load configuration changes (HTTP ${escapeHtml(response.status)})</div>`;
            return;
        }
        const data = await response.json();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (entries.length === 0) {
            el.innerHTML = '<div style="color: #94a3b8; padding: 10px; background: #1e293b; border-radius: 4px;">No configuration changes yet</div>';
            return;
        }
        el.innerHTML = entries.map(entry => {
            const changes = entry.changes && Object.keys(entry.changes).length > 0 ? JSON.stringify(entry.changes) : '';
            const what = [entry.action, entry.target].filter(Boolean).join(' ');
            return `
                <div class="config-audit-entry" style="padding: 10px; background: #1e293b; border-radius: 4px; margin-bottom: 8px;">
                    <div style="display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
                        <span style="color: #e2e8f0; font-weight: 500;">${escapeHtml(what)}${entry.server ? ` &middot; ${escapeHtml(entry.server)}` : ''}</span>
                        <span style="color: #94a3b8; font-size: 0.85rem;">${escapeHtml(formatTime(entry.at))} &middot; ${escapeHtml(entry.remote_addr || 'unknown address')}</span>
                    </div>
                    ${changes ? `<div style="color: #94a3b8; font-size: 0.85rem; font-family: monospace; margin-top: 4px; word-break: break-all;">${escapeHtml(changes)}</div>` : ''}
                </div>`;
        }).join('');
    } catch (error) {
        console.error('Failed to load configuration changes:', error);
        el.innerHTML = '<div style="color: #ef4444;">Failed to load configuration changes</div>';
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

// Payment alert overrides whose server or alert is no longer configured (#261).
// Built with DOM calls only: the alert id comes from stored data.
async function loadOrphanedOverrides(errorText) {
    const list = document.getElementById('orphaned-overrides-list');
    if (!list) return;
    const note = (text, className) => {
        list.textContent = '';
        const div = document.createElement('div');
        div.className = className;
        div.textContent = text;
        list.appendChild(div);
    };
    try {
        const [response] = await Promise.all([
            fetch('/api/dashboard/payment-overrides', getFetchOptions()),
            loadPaymentCapabilities()
        ]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const orphans = (body.overrides || []).filter((o) => o.orphaned);
        if (orphans.length === 0) {
            note('No orphaned overrides', 'orphan-empty');
        } else {
            list.textContent = '';
            const allowed = paymentWritesAllowed();
            for (const o of orphans) {
                const row = document.createElement('div');
                row.className = 'orphan-row';
                const label = document.createElement('div');
                label.className = 'orphan-label';
                label.textContent = `${o.server} / ${o.alertId}`;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'danger orphan-delete';
                btn.textContent = 'Delete';
                btn.setAttribute('data-action', 'deleteOrphanedOverride');
                btn.setAttribute('data-server', o.server);
                btn.setAttribute('data-alert', o.alertId);
                if (!allowed) {
                    btn.setAttribute('aria-disabled', 'true');
                    btn.title = paymentWritesTip();
                }
                row.appendChild(label);
                row.appendChild(btn);
                list.appendChild(row);
            }
            if (errorText) {
                const err = document.createElement('div');
                err.className = 'orphan-error';
                err.textContent = errorText;
                list.appendChild(err);
            }
        }
    } catch (error) {
        console.error('Failed to load orphaned overrides:', error);
        note('Failed to load orphaned overrides', 'orphan-error');
    }
}

async function deleteOrphanedOverride(el) {
    if (el.getAttribute('aria-disabled') === 'true') return;
    const result = await paymentStateRequest(el.dataset.server, el.dataset.alert, 'DELETE');
    await loadOrphanedOverrides(result.ok ? '' : paymentErrorText(result));
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
let paymentsReads = 0;                // status reads of the shared loop since a server was last queued
const paymentsQueued = new Set();     // subset of paymentsSyncing whose POST succeeded
let paymentsWatching = false;         // one shared status loop for every server in paymentsSyncing
let paymentsNullStreak = 0;           // consecutive successful null runningSync reads of that loop
let paymentsCaps = null;              // GET /api/dashboard/capabilities: { configWrites, reason, channels } (#259, #262), null until read
const paymentMuteForms = new Map();   // open mute forms keyed by [server, alertId]: { until, reason, error, busy } (#261)
let paymentsFocusRequest = '';        // data-focus key to focus after the next render
let paymentControlMessage = '';       // last control error, written to #payments-control-status

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

// ---- Alert controls (#261) -------------------------------------------------
const PAYMENT_WRITES_TIPS = {
    'disabled': 'Changes from the dashboard are off. Set healthCheck.dashboard.allowConfigWrites to true.',
    'auth-none': 'Changes from the dashboard need dashboard authentication (basic or token).'
};
const PAYMENT_ERROR_TEXT = {
    disabled_in_config: 'This alert is switched off in the configuration file, so it cannot be changed here.',
    origin_rejected: 'The request was rejected by the origin check.',
    server_not_found: 'That server is no longer configured.',
    alert_not_found: 'That alert no longer exists.',
    override_not_found: 'There was nothing to reset.',
    invalid_body: 'The request was not understood.'
};

function paymentFormKey(server, alertId) {
    return JSON.stringify([server, alertId]);
}

function paymentWritesAllowed() {
    return !!(paymentsCaps && paymentsCaps.configWrites === true);
}

function paymentWritesTip() {
    if (paymentWritesAllowed()) return '';
    if (paymentsCaps && PAYMENT_WRITES_TIPS[paymentsCaps.reason]) return PAYMENT_WRITES_TIPS[paymentsCaps.reason];
    return 'Could not read what the dashboard may change.';
}

function paymentRuleState(item) {
    return item.ruleState || { enabled: true, mutedUntil: null, reason: null, lockedByConfig: false, muteEndDue: false };
}

// Only evaluated rows count: the synthetic "Replaced by config.json" row of a superseded
// twin is not a schedule the rule applies to, and it has a different source.
function paymentAlertCount(group, alertId, source) {
    const rows = group.rows || group.items.map((item) => ({ item, kind: 'evaluated' }));
    return rows.filter((r) => r.kind === 'evaluated' && r.item.alertId === alertId && r.item.source === source).length;
}

function setPaymentControlMessage(text) {
    paymentControlMessage = text || '';
    const el = document.getElementById('payments-control-status');
    if (el && el.textContent !== paymentControlMessage) el.textContent = paymentControlMessage;
}

// The separate badge beside the real pill. Never a .pay-pill, so the real state stays readable.
function buildPaymentOverrideBadge(item) {
    const st = paymentRuleState(item);
    let text = '';
    let extra = '';
    if (st.lockedByConfig) {
        text = 'Disabled in config';
        extra = ' pay-override-config';
    } else if (st.mutedUntil) {
        if (st.muteEndDue) {
            text = 'Mute ended, summary pending';
            extra = ' pay-override-ended';
        } else {
            text = `Muted until ${formatCalendarDate(st.mutedUntil)}`;
            extra = ' pay-override-muted';
        }
    }
    if (!text) return null;
    const badge = payEl('span', `pay-override${extra}`, text);
    if (st.mutedUntil && st.reason) {
        const reason = String(st.reason).slice(0, 120);
        badge.title = reason;
        badge.setAttribute('aria-label', `${text}. Reason: ${reason}`);
    }
    return badge;
}

function paymentControlButton(label, action, group, item, focusKind, className) {
    const btn = payEl('button', className || 'pay-ctl', label);
    btn.type = 'button';
    btn.setAttribute('data-action', action);
    btn.setAttribute('data-server', group.server);
    btn.setAttribute('data-alert', item.alertId);
    btn.setAttribute('data-focus', `${focusKind}:${paymentFormKey(group.server, item.alertId)}`);
    if (!paymentWritesAllowed()) {
        btn.setAttribute('aria-disabled', 'true');
        btn.title = paymentWritesTip();
    }
    return btn;
}

function buildPaymentControl(group, item, showControls, editorButtons) {
    const td = payCell('Control', null);
    const extra = editorButtons || [];
    if (!showControls && extra.length === 0) return td;
    const wrap = payEl('div', 'pay-control');
    if (showControls) appendMuteControls(wrap, group, item);
    extra.forEach((btn) => wrap.appendChild(btn));
    td.appendChild(wrap);
    return td;
}

// The #261 switch and mute controls of one evaluated rule.
function appendMuteControls(wrap, group, item) {
    const st = paymentRuleState(item);
    if (!st.lockedByConfig) {
        const on = st.enabled !== false;
        const sw = paymentControlButton(on ? 'On' : 'Off', 'togglePaymentAlert', group, item, 'sw', 'pay-ctl pay-switch');
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        sw.setAttribute('aria-label', `${on ? 'On' : 'Off'} for ${item.alertId}`);
        wrap.appendChild(sw);
    }
    if (st.mutedUntil) {
        wrap.appendChild(paymentControlButton('Unmute', 'unmutePaymentAlert', group, item, 'unmute'));
    } else if (!st.lockedByConfig) {
        wrap.appendChild(paymentControlButton('Mute...', 'openPaymentMute', group, item, 'mute'));
    }
    const n = paymentAlertCount(group, item.alertId, item.source);
    if (n > 1) wrap.appendChild(payEl('span', 'pay-applies', `Applies to ${n} schedules`));
}

// Edit, Delete, View and Copy as JSON (#268), per rule. Add/Edit/Delete follow the
// same writes switch as the #261 controls; View and Copy always work.
// The data-focus key of a row's editor button. Saving an edit returns focus to the same key.
function editorRowFocusKey(server, alertId, source, action) {
    return `ed:${JSON.stringify([server, alertId, source, action])}`;
}

// After a save, focus returns to the saved rule's Edit button ('editPaymentRule' is the row
// button's action; a different action here would fall back to Add alert).
function editorSavedFocusKey(server, ruleId) {
    return editorRowFocusKey(server, ruleId, 'dashboard', 'editPaymentRule');
}

function editorRowButton(label, action, group, row, writes) {
    const btn = payEl('button', 'pay-ctl', label);
    btn.type = 'button';
    btn.setAttribute('data-action', action);
    btn.setAttribute('data-server', group.server);
    btn.setAttribute('data-alert', row.item.alertId);
    btn.setAttribute('data-source', row.item.source);
    btn.setAttribute('data-focus', editorRowFocusKey(group.server, row.item.alertId, row.item.source, action));
    btn.setAttribute('aria-label', `${label} alert ${row.item.alertId}`);
    if (writes && !paymentWritesAllowed()) {
        btn.setAttribute('aria-disabled', 'true');
        btn.title = paymentWritesTip();
    }
    return btn;
}

function buildEditorButtons(group, row) {
    if (!group.editorControls || !row.rule) return [];
    const make = (label, action, writes) => editorRowButton(label, action, group, row, writes);
    if (row.item.source !== 'dashboard') {
        return [make('View', 'viewPaymentRule', false), make('Copy as JSON', 'copyPaymentRuleJson', false)];
    }
    if (row.kind === 'superseded') return [make('Delete', 'deletePaymentRuleAsk', true)];
    if (row.kind === 'dormant') {
        return [make('View', 'viewPaymentRule', false), make('Delete', 'deletePaymentRuleAsk', true), make('Copy as JSON', 'copyPaymentRuleJson', false)];
    }
    return [make('Edit', 'editPaymentRule', true), make('Delete', 'deletePaymentRuleAsk', true), make('Copy as JSON', 'copyPaymentRuleJson', false)];
}

const PAYMENT_ROW_PILLS = {
    pending: ['Not evaluated yet', 'pay-pending'],
    superseded: ['Replaced by config.json', 'pay-superseded'],
    dormant: ['Dormant: no scheduleAlerts block', 'pay-dormant'],
    invalid: ['Invalid, not evaluated', 'pay-invalid']
};

function buildAddAlertButton(group) {
    const btn = payEl('button', 'pay-ctl', 'Add alert');
    btn.type = 'button';
    btn.setAttribute('data-action', 'openAlertEditor');
    btn.setAttribute('data-server', group.server);
    btn.setAttribute('data-focus', `add:${group.server}`);
    let tip = '';
    if (!group.editorControls) tip = 'Alert list unavailable';
    else if (!paymentWritesAllowed()) tip = paymentWritesTip();
    else if (!group.configured) tip = NOT_CONFIGURED_TIP;
    if (tip) {
        btn.setAttribute('aria-disabled', 'true');
        btn.title = tip;
    }
    return btn;
}

// The snapshot rows joined with the rule list for one server (see mergePaymentRows).
function paymentsEffectiveGroup(group) {
    const entry = paymentsRules.get(group.server) || null;
    const merged = mergePaymentRows(group.items, entry ? entry.rules : null, group.lastRun ? group.lastRun.at : null, group.configured);
    return { ...group, rows: merged.rows, editorControls: merged.editorControls, items: merged.rows.map((r) => r.item) };
}

function buildPaymentMuteRow(group, item) {
    const key = paymentFormKey(group.server, item.alertId);
    const state = paymentMuteForms.get(key);
    const tr = payEl('tr', 'pay-mute-row');
    const td = payEl('td', 'pay-mute-cell');
    td.colSpan = 10;
    const form = payEl('form', 'pay-mute-form');
    form.setAttribute('data-form', 'paymentMute');
    form.setAttribute('data-server', group.server);
    form.setAttribute('data-alert', item.alertId);
    form.noValidate = true;

    const dateLabel = payEl('label', 'pay-label', `Mute "${paymentAlertCount(group, item.alertId, item.source) > 1 ? item.alertId : (item.name || item.alertId)}" until `);
    const date = payEl('input', 'pay-mute-date');
    date.type = 'date';
    date.value = state.until;
    date.setAttribute('data-input', 'onPaymentMuteField');
    date.setAttribute('data-field', 'until');
    date.setAttribute('data-server', group.server);
    date.setAttribute('data-alert', item.alertId);
    date.setAttribute('data-focus', `date:${key}`);
    date.setAttribute('aria-label', 'Mute until');
    dateLabel.appendChild(date);
    form.appendChild(dateLabel);
    if (state.error && state.error.field === 'until') form.appendChild(payEl('span', 'pay-field-error', state.error.message));

    const reasonLabel = payEl('label', 'pay-label', 'Reason ');
    const reason = payEl('input', 'pay-mute-reason');
    reason.type = 'text';
    reason.maxLength = 200;
    reason.value = state.reason;
    reason.setAttribute('data-input', 'onPaymentMuteField');
    reason.setAttribute('data-field', 'reason');
    reason.setAttribute('data-server', group.server);
    reason.setAttribute('data-alert', item.alertId);
    reason.setAttribute('data-focus', `reason:${key}`);
    reason.setAttribute('aria-label', 'Reason');
    reasonLabel.appendChild(reason);
    form.appendChild(reasonLabel);
    if (state.error && state.error.field === 'reason') form.appendChild(payEl('span', 'pay-field-error', state.error.message));

    const save = payEl('button', '', 'Mute');
    save.type = 'submit';
    save.disabled = !!state.busy;
    form.appendChild(save);
    const cancel = payEl('button', 'pay-ctl', 'Cancel');
    cancel.type = 'button';
    cancel.setAttribute('data-action', 'cancelPaymentMute');
    cancel.setAttribute('data-server', group.server);
    cancel.setAttribute('data-alert', item.alertId);
    form.appendChild(cancel);
    if (state.error && !state.error.field) form.appendChild(payEl('span', 'pay-field-error', state.error.message));
    form.appendChild(payEl('div', 'pay-mute-note', 'Alerts are still evaluated while muted; one summary is sent when the mute ends.'));
    td.appendChild(form);
    tr.appendChild(td);
    return tr;
}

async function paymentStateRequest(server, alertId, method, body) {
    const url = `/api/dashboard/payments/${encodeURIComponent(server)}/${encodeURIComponent(alertId)}/state`;
    try {
        const init = { method, credentials: 'include' };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        const response = await fetch(url, init);
        let json = null;
        try { json = await response.json(); } catch (e) { json = null; }
        return { ok: response.ok, status: response.status, json };
    } catch (e) {
        return { ok: false, status: 0, json: null };
    }
}

function paymentErrorText(result) {
    if (result.status === 0) return 'Could not reach the server (network error).';
    const code = result.json && result.json.error;
    if (code === 'config_writes_disabled') {
        return PAYMENT_WRITES_TIPS[result.json.reason] || 'Changes from the dashboard are not allowed.';
    }
    if (result.status === 401) return 'Authentication is required.';
    if (code && PAYMENT_ERROR_TEXT[code]) return PAYMENT_ERROR_TEXT[code];
    return `Could not save the change (HTTP ${result.status}).`;
}

function applyPaymentRuleState(server, alertId, ruleState) {
    for (const g of paymentsServers || []) {
        if (g.server !== server) continue;
        for (const i of g.items) if (i.alertId === alertId) i.ruleState = ruleState;
    }
}

function paymentControlTarget(el) {
    return { server: el.dataset.server, alertId: el.dataset.alert };
}

async function togglePaymentAlert(arg, el) {
    if (el.getAttribute('aria-disabled') === 'true' || el.getAttribute('data-busy') === 'true') return;
    const { server, alertId } = paymentControlTarget(el);
    const turnOn = el.getAttribute('aria-checked') !== 'true';
    // Flip at once; a failed request re-renders from the server state below.
    el.setAttribute('data-busy', 'true');
    el.setAttribute('aria-checked', turnOn ? 'true' : 'false');
    el.textContent = turnOn ? 'On' : 'Off';
    const result = await paymentStateRequest(server, alertId, 'PUT', { enabled: turnOn });
    if (result.ok && result.json && result.json.ruleState) {
        applyPaymentRuleState(server, alertId, result.json.ruleState);
        setPaymentControlMessage('');
    } else {
        setPaymentControlMessage(`${alertId}: ${paymentErrorText(result)}`);
    }
    paymentsFocusRequest = `sw:${paymentFormKey(server, alertId)}`;
    renderPayments();
}

function openPaymentMute(arg, el) {
    if (el.getAttribute('aria-disabled') === 'true') return;
    const { server, alertId } = paymentControlTarget(el);
    const key = paymentFormKey(server, alertId);
    if (!paymentMuteForms.has(key)) paymentMuteForms.set(key, { until: '', reason: '', error: null, busy: false });
    paymentsFocusRequest = `date:${key}`;
    renderPayments();
}

function cancelPaymentMute(arg, el) {
    const { server, alertId } = paymentControlTarget(el);
    const key = paymentFormKey(server, alertId);
    paymentMuteForms.delete(key);
    paymentsFocusRequest = `mute:${key}`;
    renderPayments();
}

function onPaymentMuteField(arg, el) {
    const state = paymentMuteForms.get(paymentFormKey(el.dataset.server, el.dataset.alert));
    if (!state) return;
    const field = el.dataset.field;
    if (field === 'until' || field === 'reason') state[field] = el.value;
    // Typing clears the message that named this field (no re-render: the field keeps focus).
    if (state.error && state.error.field === field) state.error = null;
}

async function savePaymentMute(form) {
    const { server, alertId } = paymentControlTarget(form);
    const key = paymentFormKey(server, alertId);
    const state = paymentMuteForms.get(key);
    if (!state || state.busy) return;
    // A message from an earlier attempt (network, server) has no field to clear it by typing.
    state.error = null;
    if (!paymentWritesAllowed()) {
        state.error = { field: '', message: paymentWritesTip() };
        renderPayments();
        return;
    }
    const reason = state.reason.trim();
    if (state.until === '') state.error = { field: 'until', message: 'Pick the date the mute ends.' };
    else if (reason === '') state.error = { field: 'reason', message: 'Reason is required' };
    if (state.error) {
        paymentsFocusRequest = `${state.error.field === 'until' ? 'date' : 'reason'}:${key}`;
        setPaymentControlMessage(`${alertId}: ${state.error.message}`);
        renderPayments();
        return;
    }
    state.busy = true;
    const result = await paymentStateRequest(server, alertId, 'PUT', { mutedUntil: state.until, reason });
    state.busy = false;
    if (result.ok && result.json && result.json.ruleState) {
        paymentMuteForms.delete(key);
        applyPaymentRuleState(server, alertId, result.json.ruleState);
        setPaymentControlMessage('');
        paymentsFocusRequest = `unmute:${key}`;
    } else {
        const code = result.json && result.json.error;
        const field = code === 'invalid_muted_until' ? 'until' : (code === 'reason_required' || code === 'invalid_reason' ? 'reason' : '');
        const message = code === 'invalid_muted_until' ? 'Pick a date from today up to one year ahead.'
            : code === 'reason_required' ? 'Reason is required'
                : code === 'invalid_reason' ? 'The reason can have at most 200 characters.'
                    : paymentErrorText(result);
        state.error = { field, message };
        setPaymentControlMessage(`${alertId}: ${message}`);
        paymentsFocusRequest = field ? `${field === 'until' ? 'date' : 'reason'}:${key}` : '';
    }
    renderPayments();
}

async function unmutePaymentAlert(arg, el) {
    if (el.getAttribute('aria-disabled') === 'true') return;
    const { server, alertId } = paymentControlTarget(el);
    const result = await paymentStateRequest(server, alertId, 'PUT', { mutedUntil: null });
    if (result.ok && result.json && result.json.ruleState) {
        applyPaymentRuleState(server, alertId, result.json.ruleState);
        setPaymentControlMessage('');
        paymentsFocusRequest = `mute:${paymentFormKey(server, alertId)}`;
    } else {
        setPaymentControlMessage(`${alertId}: ${paymentErrorText(result)}`);
    }
    renderPayments();
}

// Drop the open form of an alert that is no longer in the snapshot (its
// server's group is in the response but the alert is not).
function prunePaymentForms() {
    for (const key of [...paymentMuteForms.keys()]) {
        const [server, alertId] = JSON.parse(key);
        const group = (paymentsServers || []).find((g) => g.server === server);
        if (group && !group.items.some((i) => i.alertId === alertId)) paymentMuteForms.delete(key);
    }
}

async function loadPaymentCapabilities() {
    try {
        const response = await fetch('/api/dashboard/capabilities', getFetchOptions());
        if (!response.ok) return;
        const body = await response.json();
        if (body && typeof body.configWrites === 'boolean') {
            paymentsCaps = {
                configWrites: body.configWrites, reason: body.reason || null,
                channels: Array.isArray(body.channels) ? body.channels.filter((c) => typeof c === 'string') : []
            };
        }
    } catch (e) { /* keep the last known value; the controls stay disabled until it loads */ }
}

function restorePaymentsFocus(content, key) {
    if (!key || typeof content.querySelectorAll !== 'function') return;
    const all = Array.from(content.querySelectorAll('[data-focus]'));
    let node = all.find((n) => n.dataset.focus === key);
    if (!node && key.startsWith('ed:')) { // the row is gone (deleted): land on that server's Add alert
        try {
            const want = `add:${JSON.parse(key.slice(3))[0]}`;
            node = all.find((n) => n.dataset.focus === want);
        } catch (e) { node = null; }
    }
    if (node && typeof node.focus === 'function') node.focus();
}

function appendPaymentRows(tbody, group, rows, groupIndex) {
    const controlled = new Set();
    rows.forEach((row, rowIndex) => {
        const item = row.item;
        const evaluated = row.kind === 'evaluated';
        const key = paymentRowKey(group.server, item);
        const stripId = `pay-strip-${groupIndex}-${rowIndex}`;
        const open = paymentsExpanded.has(key);

        const tr = payEl('tr', 'pay-row');
        const stateTd = payCell('State', null);
        const stateWrap = payEl('div', 'pay-state');
        if (evaluated) {
            stateWrap.appendChild(payPill(item.state));
            const badge = buildPaymentOverrideBadge(item);
            if (badge) stateWrap.appendChild(badge);
        } else {
            const [label, cls] = PAYMENT_ROW_PILLS[row.kind];
            const pill = payEl('span', `pay-pill ${cls}`, label);
            if (row.kind === 'invalid') {
                const reasons = (row.rule.errors || []).map((e) => `${e.path || ''} ${e.message || ''}`.trim()).join('; ');
                if (reasons) pill.title = reasons;
            }
            stateWrap.appendChild(pill);
        }
        if (row.edited) stateWrap.appendChild(payEl('span', 'pay-edited', 'Edited, applies from the next sync'));
        stateTd.appendChild(stateWrap);
        tr.appendChild(stateTd);

        const nameTd = payCell('Name', null);
        if (evaluated) {
            const toggle = payEl('button', 'pay-expand', open ? '▾' : '▸');
            toggle.type = 'button';
            toggle.setAttribute('data-action', 'togglePaymentRow');
            toggle.setAttribute('data-arg', stripId);
            toggle.setAttribute('data-key', key);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.setAttribute('aria-controls', stripId);
            toggle.setAttribute('aria-label', `Show occurrences of ${item.name || ''}`);
            nameTd.appendChild(toggle);
        }
        nameTd.appendChild(document.createTextNode(item.name || ''));
        tr.appendChild(nameTd);

        tr.appendChild(payCell('Cadence', item.cadenceText || ''));
        tr.appendChild(payCell('Account', item.account || '', 'pay-extra'));
        tr.appendChild(payCell('Amount', formatPaymentAmount(item.expectedAmount), 'pay-num'));
        tr.appendChild(payCell('Next due', formatCalendarDate(item.nextDate)));
        tr.appendChild(payCell('Deadline', formatCalendarDate(item.deadline)));
        tr.appendChild(payCell('Last alert', item.lastAlertAt ? formatTime(item.lastAlertAt) : '', 'pay-extra'));
        tr.appendChild(payCell('Source', item.source || '', item.source === 'dashboard' ? 'pay-extra pay-src-dashboard' : 'pay-extra'));
        // Rule level controls: once per rule (alert id + source), on its first visible row.
        const ruleKey = paymentRuleKey(item.alertId, item.source);
        const firstOfRule = !controlled.has(ruleKey);
        controlled.add(ruleKey);
        const muteControls = evaluated && firstOfRule;
        tr.appendChild(buildPaymentControl(group, item, muteControls, firstOfRule ? buildEditorButtons(group, row) : []));
        tbody.appendChild(tr);
        if (muteControls && paymentMuteForms.has(paymentFormKey(group.server, item.alertId))) {
            tbody.appendChild(buildPaymentMuteRow(group, item));
        }
        if (!evaluated) return;

        const strip = payEl('tr', 'pay-strip-row');
        strip.id = stripId;
        strip.hidden = !open;
        const td = payEl('td', 'pay-strip-cell');
        td.colSpan = 10;
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
    ['State', 'Name', 'Cadence', 'Account', 'Amount', 'Next due', 'Deadline', 'Last alert', 'Source', 'Control']
        .forEach((h) => headRow.appendChild(payEl('th', '', h)));
    const thead = document.createElement('thead');
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const rowOf = new Map((group.rows || group.items.map((item) => ({ item, kind: 'evaluated', rule: null, edited: false }))).map((r) => [r.item, r]));
    const shown = sortPaymentItems(group.items.filter(paymentMatchesFilters)).map((item) => rowOf.get(item));
    if (shown.length === 0) {
        const tr = document.createElement('tr');
        const td = payEl('td', 'pay-empty', group.items.length === 0 ? 'No watched schedules' : 'No matching schedules');
        td.colSpan = 10;
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
        head.appendChild(buildAddAlertButton(group));
        section.appendChild(head);
        const note = payEl('p', 'pay-note', 'Missing-payment alerts are not configured for this server. ');
        const link = payEl('a', '', 'README');
        link.href = PAYMENTS_README_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        note.appendChild(link);
        section.appendChild(note);
        if (group.rows.some((r) => r.kind !== 'evaluated')) section.appendChild(buildPaymentsTable(group, groupIndex));
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
    head.appendChild(buildAddAlertButton(group));

    const syncError = paymentsSyncErrors.get(group.server);
    if (syncError) {
        // Plain visible text, deliberately NOT role=alert: renderPayments rebuilds
        // #payments-content on every keystroke and poll, and a rebuilt (or
        // re-appended) alert node is announced again by Chromium and Firefox.
        // The announcement comes from the persistent #payments-sync-status live
        // region instead. Do not put the role back on this node (round 2, L1).
        head.appendChild(payEl('div', 'pay-sync-error', syncError));
    }
    section.appendChild(head);

    if (!group.editorControls) section.appendChild(payEl('p', 'pay-list-note', 'Alert list unavailable'));
    const hasRuleRows = group.rows.some((r) => r.kind !== 'evaluated');
    if (!run) {
        section.appendChild(payEl('p', 'pay-note', 'Runs after the next sync'));
        if (hasRuleRows) section.appendChild(buildPaymentsTable(group, groupIndex));
        return section;
    }

    const failureParts = [];
    if (!run.ok) failureParts.push(`last evaluation failed at ${formatTime(run.at)} (${run.errorCode})`);
    if (run.rulesErrored > 0) {
        failureParts.push(`${run.rulesErrored} rule(s) could not be evaluated; their last values are shown`);
    }
    if (failureParts.length) section.appendChild(payEl('p', 'pay-failure', failureParts.join('. ')));

    if (run.lastSuccessAt || hasRuleRows) section.appendChild(buildPaymentsTable(group, groupIndex));
    return section;
}

function renderPayments() {
    const content = document.getElementById('payments-content');
    const summary = document.getElementById('payments-summary');
    const errorEl = document.getElementById('payments-error');
    if (!content) return;

    if (errorEl.textContent !== paymentsLoadError) errorEl.textContent = paymentsLoadError;
    errorEl.hidden = !paymentsLoadError;

    // Sync-start errors are announced through one live region that lives outside
    // #payments-content, so it survives re-renders, and is written only when its
    // text changes (an unchanged rewrite can still re-announce).
    const liveEl = document.getElementById('payments-sync-status');
    if (liveEl) {
        const liveText = [...paymentsSyncErrors].map(([name, msg]) => `${name}: ${msg}`).join('. ');
        if (liveEl.textContent !== liveText) liveEl.textContent = liveText;
    }

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

    const controlEl = document.getElementById('payments-control-status');
    if (controlEl && controlEl.textContent !== paymentControlMessage) controlEl.textContent = paymentControlMessage;

    // A render rebuilds every node, so remember what had focus (and the caret).
    let focusKey = paymentsFocusRequest;
    paymentsFocusRequest = '';
    let caret = null;
    const active = document.activeElement;
    if (!focusKey && active && active.dataset && active.dataset.focus && typeof content.contains === 'function' && content.contains(active)) {
        focusKey = active.dataset.focus;
        if (typeof active.selectionStart === 'number') caret = [active.selectionStart, active.selectionEnd];
    }

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
    const groups = paymentsServers.map(paymentsEffectiveGroup);
    for (const group of groups) {
        const evaluated = group.rows.filter((r) => r.kind === 'evaluated').map((r) => r.item);
        watched += evaluated.length;
        attention += evaluated.filter(paymentNeedsAttention).length;
    }
    summary.textContent = `${watched} watched · ${attention} need attention`;
    groups.forEach((group, i) => content.appendChild(buildPaymentsGroup(group, i)));
    restorePaymentsFocus(content, focusKey);
    if (caret && document.activeElement && typeof document.activeElement.setSelectionRange === 'function') {
        try { document.activeElement.setSelectionRange(caret[0], caret[1]); } catch (e) { /* e.g. a date input */ }
    }
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
        // Capabilities only change with a restart: read once, retry while unknown.
        const capsRead = paymentsCaps === null ? loadPaymentCapabilities() : Promise.resolve();
        try {
            const response = await fetch(url, getFetchOptions());
            if (!response.ok) message = `Could not refresh payments (HTTP ${response.status})`;
            else body = await response.json();
        } catch (e) {
            message = 'Could not refresh payments (network error)';
        }
        // The rule list is the source of truth for which alerts exist (#268).
        let ruleLists = [];
        if (body && Array.isArray(body.servers)) {
            ruleLists = await Promise.all(body.servers.map((g) => fetchPaymentRules(g.server)));
        }
        await capsRead;
        if (seq !== paymentsRequestSeq) return; // a newer request owns the view
        if (body && Array.isArray(body.servers)) {
            paymentsServers = body.servers;
            body.servers.forEach((g, i) => paymentsRules.set(g.server, ruleLists[i]));
            prunePaymentForms();
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
    // A newly queued server gets the full read budget, not what is left of an
    // earlier server's run (else it could be marked done on 1 or 2 reads and the
    // refresh would show pre-job data). Bounded: a server can be queued only once
    // while busy, so the loop still ends. (round 2, L2)
    paymentsReads = 0;
    if (!paymentsWatching) await watchPaymentsSync();
}

// ONE status loop serves every server in paymentsSyncing (the per-IP limiter
// is 60/min; a loop per click would exceed it and 429 its own reads).
async function watchPaymentsSync() {
    paymentsWatching = true;
    let stopped = false;
    try {
        // Counted in iterations, not time: the E2E page clock is frozen.
        paymentsReads = 0;
        while (paymentsReads < PAYMENTS_SYNC_MAX_POLLS && paymentsSyncing.size > 0) {
            await new Promise((resolve) => setTimeout(resolve, PAYMENTS_SYNC_POLL_MS));
            paymentsReads += 1;
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

// ---- Alert editor (#268): pure helpers ---------------------------------------
// Everything up to "Alert editor: dialog" is DOM free so the unit tests can
// drive it directly. The server stays the authority on validity; these only
// build the request body and word the answers.
const EDITOR_EVENTS = ['missing', 'wrongAmount', 'resolved', 'cannotCheck', 'ruleUnmatched', 'muteEnded'];
const EDITOR_EVENT_LABELS = {
    missing: 'Missing payment', wrongAmount: 'Wrong amount', resolved: 'Payment received',
    cannotCheck: 'Cannot check', ruleUnmatched: 'No matching schedule', muteEnded: 'Mute ended'
};
// The three constants this page owns. Everything else comes from the server
// (GET payment-schedules/:server `defaults`).
const DEFAULT_PERIOD = 'occurrence';
const DEFAULT_REMIND_DAYS = 3;
const NOT_CONFIGURED_TIP = 'Add a scheduleAlerts block to this server in config.json first (it can be empty)';
const RULE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Mirrors slugify() in src/lib/scheduleAlertRules.js: lowercase, runs of other
// characters become one hyphen, trimmed, empty becomes "alert", cut to 64.
function slugifyRuleId(name) {
    const slug = String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (slug || 'alert').slice(0, 64);
}

// base, then base-2, base-3 ... The base is cut first so the total stays <= 64.
function uniqueRuleId(base, taken) {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
        const suffix = `-${n}`;
        const id = base.slice(0, 64 - suffix.length) + suffix;
        if (!taken.has(id)) return id;
    }
}

// Case-sensitive startsWith, as the server matches. Completed schedules are not
// offered, so they are not counted. An empty prefix matches nothing here.
function countPrefixMatches(schedules, prefix) {
    if (!prefix) return 0;
    return (schedules || []).filter((s) => !s.completed && typeof s.name === 'string' && s.name.startsWith(prefix)).length;
}

function prefixMatchText(count) {
    return count === 0 ? 'matches 0: this rule will report ruleUnmatched' : `matches ${count}`;
}

// The picker entries: completed schedules are left out and two schedules with
// the same name get the last 6 characters of their id so they can be told apart.
function scheduleOptions(schedules) {
    const live = (schedules || []).filter((s) => !s.completed);
    const counts = new Map();
    live.forEach((s) => counts.set(s.name, (counts.get(s.name) || 0) + 1));
    return live.map((s) => ({
        value: String(s.id),
        name: s.name,
        label: counts.get(s.name) > 1 ? `${s.name} (${String(s.id).slice(-6)})` : String(s.name)
    }));
}

function scheduleAmountText(s) {
    if (s.amountOp === 'isbetween' && s.amountMin != null && s.amountMax != null) {
        const a = Math.abs(s.amountMin);
        const b = Math.abs(s.amountMax);
        return formatPaymentAmount({ num1: Math.min(a, b), num2: Math.max(a, b) });
    }
    return s.amount == null ? '' : formatPaymentAmount(Math.abs(s.amount));
}

// "Every month on the 5th · 60.00 · into Main · from Tenant A". No currency
// symbol (the snapshot has none). A negative amount is money leaving.
function formatScheduleLine(s) {
    if (!s) return '';
    const probe = s.amount != null ? s.amount : s.amountMin;
    const out = typeof probe === 'number' && probe < 0;
    const parts = [s.cadenceText || '', scheduleAmountText(s)];
    const account = s.account == null ? '(deleted account)' : s.account;
    parts.push(`${out ? 'out of' : 'into'} ${account}`);
    if (s.payee) parts.push(`${out ? 'to' : 'from'} ${s.payee}`);
    return parts.filter((p) => p !== '').join(' · ');
}

function ordinalDay(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

function shortDate(date) {
    return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

// The line under the grace field. A monthly schedule whose day + grace stays
// within 28 has the same deadline every month, so say that. Anything else gets
// the real calendar date (month length decides where day + grace lands).
function editorDeadlineText(schedule, graceDays) {
    if (!schedule || !schedule.nextDate) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(schedule.nextDate));
    if (!m) return '';
    const grace = Number.isFinite(graceDays) && graceDays >= 0 ? Math.floor(graceDays) : 0;
    const due = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const cadence = String(schedule.cadenceText || '');
    const day = /^Every month on the (\d+)/.exec(cadence);
    if (!day) return `next date ${shortDate(due)}`;
    if (Number(day[1]) + grace <= 28) return `deadline: ${ordinalDay(Number(day[1]) + grace)} of each month`;
    const deadline = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + grace));
    return `deadline: ${shortDate(deadline)} for the ${shortDate(due)} payment`;
}

function effectiveTemplate(defaults, event) {
    const d = defaults || {};
    const block = d.blockTemplates && d.blockTemplates[event];
    if (block != null) return block;
    const base = d.templates && d.templates[event];
    return base == null ? '' : base;
}

function tolerancePlaceholder(amountOp) {
    return amountOp === 'isapprox' ? 'From schedule (about 7.5%)' : 'From schedule (exact)';
}

function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// A number field: cleared deletes the key; otherwise it is written when the
// stored rule had the key or the value differs from the server default.
function applyNumberField(body, stored, key, text, fallback) {
    if (text === '' || text == null || !Number.isFinite(Number(text))) { delete body[key]; return; }
    const n = Number(text);
    if (hasOwn(stored, key) || n !== fallback) body[key] = n; else delete body[key];
}

// The request body for POST/PUT and for the preview. Starts from the stored
// definition so keys this form does not show survive an edit, then sets only
// what differs from the server defaults.
function buildRuleBody(form, storedDefinition, defaults, allChannels) {
    const stored = storedDefinition || {};
    const d = defaults || {};
    const body = { ...stored };
    body.id = form.id;
    delete body.schedule;
    delete body.schedulePrefix;
    if (form.watch === 'prefix') body.schedulePrefix = form.prefix; else body.schedule = form.schedule;

    applyNumberField(body, stored, 'graceDays', form.graceDays, d.graceDays);
    applyNumberField(body, stored, 'earlyDays', form.earlyDays, d.earlyDays);

    if (hasOwn(stored, 'period') || form.period !== DEFAULT_PERIOD) body.period = form.period; else delete body.period;

    if (form.tolerance === '' || form.tolerance == null || !Number.isFinite(Number(form.tolerance))) delete body.amountTolerancePct;
    else body.amountTolerancePct = Number(form.tolerance);

    if (form.remindOn) {
        const n = Number(form.remindDays);
        body.remindEveryDays = Number.isFinite(n) && form.remindDays !== '' ? n : DEFAULT_REMIND_DAYS;
    } else {
        delete body.remindEveryDays;
    }

    const all = allChannels || [];
    const picked = form.channels || [];
    if (all.length > 0) {
        if (Array.isArray(stored.channels)) {
            // A stored list is always written back explicitly: omitting it would widen the rule to
            // every channel (#268 round 1). Untouched boxes keep the stored list as is, including
            // entries that are not available now and so have no box.
            const initial = all.filter((c) => stored.channels.includes(c));
            const unchanged = initial.length === picked.length && initial.every((c) => picked.includes(c));
            body.channels = unchanged ? stored.channels.slice() : all.filter((c) => picked.includes(c));
        } else if (all.every((c) => picked.includes(c))) delete body.channels;
        else body.channels = all.filter((c) => picked.includes(c));
    }

    const templates = { ...(stored.templates || {}) };
    for (const event of EDITOR_EVENTS) {
        const text = form.templates ? form.templates[event] : undefined;
        if (text === undefined) continue;
        if (text === '') delete templates[event];
        else if (hasOwn(stored.templates, event) || text !== effectiveTemplate(d, event)) templates[event] = text;
        else delete templates[event];
    }
    if (Object.keys(templates).length > 0) body.templates = templates; else delete body.templates;
    return body;
}

// "Edited, applies from the next sync": a dashboard rule saved after the last evaluation.
function editedNote(rule, lastRunAt) {
    if (!rule || rule.source !== 'dashboard' || !rule.updatedAt || !lastRunAt) return false;
    const saved = Date.parse(rule.updatedAt);
    const ran = Date.parse(lastRunAt);
    return Number.isFinite(saved) && Number.isFinite(ran) && saved > ran;
}

function paymentRuleKey(id, source) {
    return JSON.stringify([id, source]);
}

function paymentRuleLabel(rule) {
    const def = rule.definition || {};
    if (def.schedule) return String(def.schedule);
    if (def.schedulePrefix) return `${def.schedulePrefix}*`;
    return String(rule.id);
}

// Joins the snapshot rows with the rule list (the source of truth for what
// exists). A rule list that failed to load (null) merges nothing: the snapshot
// rows show unchanged and the editor offers no controls. [] is different: it
// hides every snapshot row, since none of them has a rule any more.
//   kind: evaluated | pending | superseded | dormant | invalid
function mergePaymentRows(items, rules, lastRunAt, configured) {
    if (rules === null || rules === undefined) {
        return { rows: (items || []).map((item) => ({ item, kind: 'evaluated', rule: null, edited: false })), editorControls: false };
    }
    const byKey = new Map(rules.map((r) => [paymentRuleKey(r.id, r.source), r]));
    const used = new Set();
    const rows = [];
    for (const item of items || []) {
        const key = paymentRuleKey(item.alertId, item.source || 'config');
        const rule = byKey.get(key);
        if (!rule) continue;
        used.add(key);
        if (rule.invalid) continue; // shown once, as an invalid row, below
        rows.push({ item, kind: 'evaluated', rule, edited: editedNote(rule, lastRunAt) });
    }
    for (const rule of rules) {
        const key = paymentRuleKey(rule.id, rule.source);
        if (used.has(key) && !rule.invalid) continue;
        let kind = 'pending';
        if (rule.invalid) kind = 'invalid';
        else if (rule.superseded) kind = 'superseded';
        else if (configured === false) kind = 'dormant';
        const item = {
            alertId: rule.id, scheduleId: null, name: paymentRuleLabel(rule), cadenceText: '', account: '', payee: '',
            expectedAmount: null, nextDate: null, deadline: null, state: null, lastAlertAt: null,
            source: rule.source, ruleState: null, occurrences: []
        };
        rows.push({ item, kind, rule, edited: false });
    }
    return { rows, editorControls: true };
}

const EDITOR_PATH_FIELDS = [
    ['/id', 'id'], ['/schedulePrefix', 'watch'], ['/schedule', 'watch'], ['/graceDays', 'graceDays'],
    ['/earlyDays', 'earlyDays'], ['/period', 'period'], ['/amountTolerancePct', 'tolerance'],
    ['/remindEveryDays', 'reminders'], ['/channels', 'channels']
];

// The editor field an error path names, '' when none. Prefix match on a path
// boundary, so "/schedule" does not swallow "/schedulePrefix".
function editorFieldForPath(path) {
    const p = String(path == null ? '' : path);
    const t = /^\/templates\/([A-Za-z]+)(\/|$)/.exec(p);
    if (t) return `template:${t[1]}`;
    for (const [prefix, field] of EDITOR_PATH_FIELDS) {
        if (p === prefix || p.startsWith(`${prefix}/`)) return field;
    }
    return '';
}

function editorTemplateErrorText(json) {
    const token = json.token == null ? '' : json.token;
    switch (json.reason) {
        case 'unknown_variable': return `unknown variable "${token}"`;
        case 'unknown_helper': return `unknown helper "${token}"`;
        case 'parse_error': return `template syntax error near "${token}" on line ${json.line}`;
        case 'telegram_markup': return `this text breaks Telegram formatting near "${token}"; close or escape it`;
        default: return 'this message template is not valid';
    }
}

const EDITOR_WRITES_REASON = { 'disabled': 'allowConfigWrites is false', 'auth-none': 'dashboard authentication is off' };
const EDITOR_INVALID_REQUEST = 'The editor sent an invalid request. Reload the page.';
const EDITOR_NO_DESTINATION = 'No notification channel is configured for this rule.';
const EDITOR_CODE_TEXT = {
    origin_rejected: 'The request was rejected because it did not come from this dashboard\'s own address. Open the dashboard at its normal URL.',
    server_not_found: 'This server is no longer configured.',
    managed_in_config: 'This alert is managed in config.json. Copy as JSON to change it there.',
    alerts_not_configured: 'Add a scheduleAlerts block to this server in config.json first (it can be empty).',
    too_many_rules: 'Limit of 200 dashboard alerts reached. Delete one first.',
    no_configured_destination: EDITOR_NO_DESTINATION,
    test_send_rate_limited: 'Too many test messages, wait a minute.',
    send_failed: 'No destination accepted the test message',
    send_threw: 'The test message could not be sent. See the service log.',
    timeout: 'The test message timed out.',
    channel_unavailable: 'A channel is not available right now.'
};

// One answer for every failure: { banner, fields, preview, reload, close, writesOff }.
// `where` is 'save' | 'delete' | 'preview'; a preview failure fills `preview`
// instead of `banner`. Mapped by status and json.error, never by the body text.
function mapEditorError(status, json, where) {
    const out = { banner: '', fields: {}, preview: '', reload: false, close: false, writesOff: false };
    const code = json && typeof json.error === 'string' ? json.error : '';
    const say = (text) => { if (where === 'preview') out.preview = text; else out.banner = text; };
    if (status === 0) { say('Could not reach the server. Check your connection and try again.'); return out; }
    if (code === 'invalid_rule' && json && Array.isArray(json.details)) {
        const loose = [];
        for (const d of json.details) {
            const field = editorFieldForPath(d && d.path);
            const message = d && d.message ? String(d.message) : 'invalid';
            if (field) { if (!out.fields[field]) out.fields[field] = message; } else loose.push(message);
        }
        if (loose.length) say(loose.join('. '));
        return out;
    }
    if (code === 'invalid_template') {
        const text = editorTemplateErrorText(json);
        if (json.template) out.fields[`template:${json.template}`] = text; else say(text);
        return out;
    }
    if (code === 'duplicate_id') { out.fields.id = 'An alert with this id exists'; return out; }
    if (code === 'id_in_config') { out.fields.id = 'config.json already has an alert with this id'; return out; }
    if (code === 'rule_not_found') { say('This alert no longer exists.'); out.reload = true; out.close = true; return out; }
    if (code === 'config_writes_disabled') {
        const reason = json.reason;
        say(`Configuration changes are turned off (${EDITOR_WRITES_REASON[reason] || reason || 'unknown'}).`);
        out.writesOff = true;
        return out;
    }
    if (['id_mismatch', 'invalid_event', 'invalid_body', 'invalid_json', 'invalid_body_encoding'].includes(code) || status === 415) {
        say(EDITOR_INVALID_REQUEST);
        return out;
    }
    if (EDITOR_CODE_TEXT[code]) { say(EDITOR_CODE_TEXT[code]); return out; }
    if (status === 401) { say('Your session has expired or the credentials are wrong. Reload and sign in again.'); return out; }
    if (status === 413) { say('This alert is too large to save (16 KB limit). Shorten the message templates.'); return out; }
    if (status === 429) { say(json ? 'Too many failed sign-in attempts. Wait a few minutes.' : 'Too many requests. Wait a minute.'); return out; }
    if (status === 500 && where === 'preview') { say('The preview failed. See the service log.'); return out; }
    if (status === 500) { say('The server could not save this alert. Try again; see the service log.'); return out; }
    if (status === 503) { say('Sync history is not available, so alerts cannot be edited.'); return out; }
    say(`The server rejected the request (${code || `HTTP ${status}`})`);
    return out;
}

// ---- Alert editor (#268): dialog ---------------------------------------------
// The dialog markup is static in dashboard.html; this fills the dynamic parts
// once per open and then only updates text, visibility and disabled state, so
// typing never rebuilds an input. It lives outside #payments-content, so the
// 60 s poll re-render cannot drop its focus.
let paymentsEditor = null;            // the open editor's state, null when closed
const paymentsRules = new Map();      // server -> { configured, rules } | null (GET payment-rules failed)
const EDITOR_PREVIEW_DELAY_MS = 400;
let editorPreviewTimer = null;
let editorPreviewSeq = 0;

function aeEl(id) {
    return document.getElementById(id);
}

function aeText(id, text) {
    const node = aeEl(id);
    if (node && node.textContent !== text) node.textContent = text;
}

function aeShow(id, visible) {
    const node = aeEl(id);
    if (node) node.hidden = !visible;
}

async function fetchPaymentRules(server) {
    try {
        const response = await fetch(`/api/dashboard/payment-rules/${encodeURIComponent(server)}`, getFetchOptions());
        if (!response.ok) return null;
        const body = await response.json();
        if (!body || !Array.isArray(body.rules)) return null;
        return { configured: body.configured === true, rules: body.rules };
    } catch (e) {
        return null;
    }
}

async function editorRequest(method, url, body) {
    try {
        const init = { method, credentials: 'include' };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        const response = await fetch(url, init);
        let json = null;
        try { json = await response.json(); } catch (e) { json = null; }
        return { ok: response.ok, status: response.status, json };
    } catch (e) {
        return { ok: false, status: 0, json: null };
    }
}

function editorRuleUrl(server, alertId) {
    return `/api/dashboard/payment-rules/${encodeURIComponent(server)}${alertId ? `/${encodeURIComponent(alertId)}` : ''}`;
}

function editorStoredRule(server, alertId, source) {
    const entry = paymentsRules.get(server);
    return entry ? entry.rules.find((r) => r.id === alertId && r.source === source) || null : null;
}

function editorReadOnly(ed) {
    return ed.mode === 'view' || (ed.rule && ed.rule.superseded === true);
}

function editorChannels() {
    return paymentsCaps && Array.isArray(paymentsCaps.channels) ? paymentsCaps.channels : [];
}

function editorSchedule(ed) {
    const list = (ed.data && ed.data.schedules) || [];
    if (ed.form.watch === 'schedule') return list.find((s) => s.name === ed.form.schedule) || null;
    return list.find((s) => !s.completed && typeof s.name === 'string' && ed.form.prefix && s.name.startsWith(ed.form.prefix)) || null;
}

function editorTakenIds(ed) {
    const entry = paymentsRules.get(ed.server);
    return new Set(entry ? entry.rules.map((r) => r.id) : []);
}

function editorBuildBody(ed) {
    const stored = ed.mode === 'new' ? {} : (ed.rule && ed.rule.definition) || {};
    return buildRuleBody(ed.form, stored, (ed.data && ed.data.defaults) || {}, editorChannels());
}

// Save is off while any field or template error is shown (the ticket requires it); an edit
// clears that field's error, which turns Save back on.
function editorCanSave(ed, ro, writes, problems) {
    const shown = Object.values(ed.errors).some(Boolean);
    return !ro && writes && !ed.busy && Object.keys(ed.invalid).length === 0 && !shown && !problems.channels && !ed.loading;
}

function editorCanSend(ed, ro, writes) {
    return !ro && writes && !ed.busy && !ed.sending && !ed.loading;
}

// One test send at a time: false while one is already in flight.
function beginEditorSend(ed) {
    if (ed.sending) return false;
    ed.sending = true;
    return true;
}

// Local checks only for what has no server round trip worth making.
function editorProblems(ed) {
    const f = ed.form;
    const problems = {};
    if (!RULE_ID_PATTERN.test(f.id)) problems.id = 'Use 1 to 64 lowercase letters, digits or hyphens';
    if (f.watch === 'schedule' && !f.schedule) problems.watch = 'Pick a schedule';
    if (f.watch === 'prefix' && !f.prefix) problems.watch = 'Type the start of a schedule name';
    if (editorChannels().length > 0 && f.channels.length === 0) problems.channels = 'Pick at least one channel';
    return problems;
}

function editorFormFromRule(ed) {
    const d = (ed.data && ed.data.defaults) || {};
    const s = ed.mode === 'new' ? {} : (ed.rule && ed.rule.definition) || {};
    const options = scheduleOptions(ed.data ? ed.data.schedules : []);
    const watch = s.schedulePrefix !== undefined ? 'prefix' : 'schedule';
    const first = options[0];
    const templates = {};
    for (const event of EDITOR_EVENTS) {
        templates[event] = s.templates && s.templates[event] != null ? s.templates[event] : effectiveTemplate(d, event);
    }
    const all = editorChannels();
    const form = {
        id: s.id || ed.alertId || '',
        watch,
        schedule: watch === 'schedule' ? (s.schedule !== undefined ? s.schedule : (first ? first.name : '')) : '',
        prefix: watch === 'prefix' ? String(s.schedulePrefix) : '',
        graceDays: String(s.graceDays !== undefined ? s.graceDays : (d.graceDays !== undefined ? d.graceDays : 3)),
        earlyDays: String(s.earlyDays !== undefined ? s.earlyDays : (d.earlyDays !== undefined ? d.earlyDays : 2)),
        period: s.period || DEFAULT_PERIOD,
        tolerance: s.amountTolerancePct != null ? String(s.amountTolerancePct) : '',
        remindOn: s.remindEveryDays != null,
        remindDays: String(s.remindEveryDays != null ? s.remindEveryDays : DEFAULT_REMIND_DAYS),
        channels: Array.isArray(s.channels) ? all.filter((c) => s.channels.includes(c)) : all.slice(),
        templates,
        previewEvent: 'missing'
    };
    if (ed.mode === 'new') {
        ed.idTouched = false;
        form.id = editorSuggestId(ed, form);
    }
    return form;
}

function editorSuggestId(ed, form) {
    let base = 'alert';
    if (form.watch === 'prefix') base = slugifyRuleId(form.prefix);
    else {
        const opt = scheduleOptions(ed.data ? ed.data.schedules : []).find((o) => o.name === form.schedule);
        base = slugifyRuleId(opt ? opt.label : form.schedule);
    }
    return uniqueRuleId(base, editorTakenIds(ed));
}

function editorMakeField(ed, event) {
    const wrap = payEl('details', 'ae-tpl');
    if (event === 'missing') wrap.open = true;
    wrap.appendChild(payEl('summary', '', EDITOR_EVENT_LABELS[event]));
    const area = payEl('textarea');
    area.id = `ae-tpl-${event}`;
    area.setAttribute('data-input', 'onEditorInput');
    area.setAttribute('data-change', 'onEditorTemplateChange');
    area.setAttribute('data-field', `template:${event}`);
    area.setAttribute('aria-label', `${EDITOR_EVENT_LABELS[event]} message`);
    area.value = ed.form.templates[event];
    wrap.appendChild(area);
    wrap.appendChild(payEl('div', 'ae-err')).id = `ae-err-template-${event}`;
    return wrap;
}

// Once per open: the parts that depend on the loaded data.
function editorBuildDom(ed) {
    const f = ed.form;
    const sel = aeEl('ae-schedule');
    if (sel) {
        sel.textContent = '';
        const options = scheduleOptions(ed.data ? ed.data.schedules : []);
        options.forEach((o) => {
            const opt = payEl('option', '', o.label);
            opt.value = o.name;
            sel.appendChild(opt);
        });
        if (f.schedule && !options.some((o) => o.name === f.schedule)) {
            const opt = payEl('option', '', f.schedule);
            opt.value = f.schedule;
            sel.appendChild(opt);
        }
        sel.value = f.schedule;
    }
    const box = aeEl('ae-channels');
    if (box) {
        box.textContent = '';
        const all = editorChannels();
        if (all.length === 0) box.appendChild(payEl('span', 'ae-note', 'No notification channel is configured.'));
        all.forEach((name) => {
            const label = payEl('label');
            const cb = payEl('input');
            cb.type = 'checkbox';
            cb.value = name;
            cb.checked = f.channels.includes(name);
            cb.setAttribute('data-input', 'onEditorInput');
            cb.setAttribute('data-field', 'channel');
            label.appendChild(cb);
            label.appendChild(document.createTextNode(` ${name}`));
            box.appendChild(label);
        });
    }
    const tpls = aeEl('ae-templates');
    if (tpls) {
        tpls.textContent = '';
        EDITOR_EVENTS.forEach((event) => tpls.appendChild(editorMakeField(ed, event)));
    }
    const ev = aeEl('ae-preview-event');
    if (ev) {
        ev.textContent = '';
        EDITOR_EVENTS.forEach((event) => {
            const opt = payEl('option', '', EDITOR_EVENT_LABELS[event]);
            opt.value = event;
            ev.appendChild(opt);
        });
        ev.value = f.previewEvent;
    }
    const set = (id, value) => { const n = aeEl(id); if (n) n.value = value; };
    set('ae-id', f.id);
    set('ae-prefix', f.prefix);
    set('ae-grace', f.graceDays);
    set('ae-early', f.earlyDays);
    set('ae-tol', f.tolerance);
    set('ae-remind-days', f.remindDays);
    const check = (id, value) => { const n = aeEl(id); if (n) n.checked = value; };
    check('ae-mode-schedule', f.watch === 'schedule');
    check('ae-mode-prefix', f.watch === 'prefix');
    check('ae-period-occurrence', f.period === 'occurrence');
    check('ae-period-next', f.period === 'next');
    check('ae-remind-on', f.remindOn);
    const tol = aeEl('ae-tol');
    const sched = editorSchedule(ed);
    if (tol) tol.placeholder = tolerancePlaceholder(sched ? sched.amountOp : 'is');
    editorBuildChips(ed);
}

function editorBuildChips(ed) {
    const box = aeEl('ae-vars');
    if (!box) return;
    box.textContent = '';
    const vars = (ed.data && ed.data.defaults && ed.data.defaults.variables && ed.data.defaults.variables[ed.form.previewEvent]) || [];
    vars.forEach((name) => {
        const chip = payEl('button', 'ae-chip', name);
        chip.type = 'button';
        chip.setAttribute('data-action', 'insertTemplateVariable');
        chip.setAttribute('data-arg', name);
        box.appendChild(chip);
    });
}

function editorTitle(ed) {
    if (ed.mode === 'new') return `Add payment alert for ${ed.server}`;
    if (ed.mode === 'view') return `Alert ${ed.alertId}`;
    return `Edit alert ${ed.alertId}`;
}

// Every state-dependent bit of the dialog; never creates inputs.
function renderEditor() {
    const ed = paymentsEditor;
    if (!ed) return;
    const f = ed.form;
    const ro = editorReadOnly(ed);
    const writes = paymentWritesAllowed();
    aeText('alert-editor-title', editorTitle(ed));
    aeText('ae-server', ed.server);

    let banner = ed.banner;
    let info = false;
    if (!banner && ed.rule && ed.rule.superseded) { banner = 'Replaced by the config.json rule with the same id. You can delete this one.'; info = true; }
    else if (!banner && ed.mode === 'view' && ed.source === 'config') { banner = 'Managed in config.json. Copy as JSON to change it there.'; info = true; }
    aeText('ae-banner', banner);
    const bannerEl = aeEl('ae-banner');
    if (bannerEl) {
        bannerEl.hidden = !banner;
        bannerEl.className = info ? 'ae-banner ae-info' : 'ae-banner';
        bannerEl.setAttribute('role', info ? 'note' : 'alert');
    }
    aeShow('ae-loading', ed.loading);
    aeShow('ae-form', !ed.loading && !ed.json);
    aeShow('ae-json', !!ed.json);
    if (ed.loading || !ed.form) {
        ['ae-save', 'ae-send'].forEach((id) => { const n = aeEl(id); if (n) n.setAttribute('aria-disabled', 'true'); });
        aeShow('ae-delete', false);
        aeShow('ae-copy', false);
        aeShow('ae-confirm', false);
        return;
    }

    const noSnap = ed.mode === 'new' && !!ed.data && !ed.data.capturedAt;
    aeShow('ae-nosnap', noSnap);
    aeShow('ae-pick', !noSnap);
    const sync = aeEl('ae-sync');
    if (sync) sync.setAttribute('data-arg', ed.server);

    const errors = ed.errors;
    ['id', 'watch', 'graceDays', 'earlyDays', 'period', 'tolerance', 'reminders', 'channels'].forEach((k) => aeText(`ae-err-${k}`, errors[k] || ''));
    EDITOR_EVENTS.forEach((event) => aeText(`ae-err-template-${event}`, errors[`template:${event}`] || ''));

    const schedMode = f.watch === 'schedule';
    const sel = aeEl('ae-schedule');
    if (sel) sel.disabled = ro || !schedMode;
    const prefix = aeEl('ae-prefix');
    if (prefix) prefix.disabled = ro || schedMode;
    const matches = countPrefixMatches(ed.data ? ed.data.schedules : [], f.prefix);
    aeText('ae-matches', !schedMode && f.prefix ? prefixMatchText(matches) : '');
    const sched = editorSchedule(ed);
    aeText('ae-sline', formatScheduleLine(sched));
    const captured = ed.data && ed.data.capturedAt;
    aeText('ae-asof', captured ? `Schedules as of ${formatTime(captured)}` : '');
    const grace = Number(f.graceDays);
    aeText('ae-deadline', f.graceDays === '' ? '' : editorDeadlineText(sched, grace));
    const tol = aeEl('ae-tol');
    if (tol) tol.placeholder = tolerancePlaceholder(sched ? sched.amountOp : 'is');
    const idEl = aeEl('ae-id');
    if (idEl) idEl.disabled = ro || ed.mode === 'edit';
    ['ae-mode-schedule', 'ae-mode-prefix', 'ae-grace', 'ae-early', 'ae-period-occurrence', 'ae-period-next', 'ae-tol', 'ae-remind-on']
        .forEach((id) => { const n = aeEl(id); if (n) n.disabled = ro; });
    const rd = aeEl('ae-remind-days');
    if (rd) rd.disabled = ro || !f.remindOn;
    EDITOR_EVENTS.forEach((event) => { const n = aeEl(`ae-tpl-${event}`); if (n) n.readOnly = ro; });
    const box = aeEl('ae-channels');
    if (box && box.querySelectorAll) box.querySelectorAll('input').forEach((cb) => { cb.disabled = ro; });

    // Preview area.
    const pv = ed.preview;
    aeText('ae-preview-text', pv && pv.text != null ? pv.text : '');
    aeText('ae-preview-keys', pv && pv.sampleKeys && pv.sampleKeys.length ? `Sample values used for: ${pv.sampleKeys.join(', ')}` : '');
    aeText('ae-preview-note', pv && pv.note ? pv.note : '');
    const list = aeEl('ae-results');
    if (list) {
        list.textContent = '';
        for (const line of (pv && pv.lines) || []) list.appendChild(payEl('li', '', line));
    }

    // Footer.
    const problems = editorProblems(ed);
    const blocked = Object.keys(ed.invalid).length > 0;
    const canSave = editorCanSave(ed, ro, writes, problems);
    const hint = problems.channels || (blocked ? 'Fix the highlighted fields to save' : '') || (!writes && !ro ? paymentWritesTip() : '');
    aeText('ae-save-hint', hint);
    const flag = (id, enabled, visible) => {
        const n = aeEl(id);
        if (!n) return;
        n.hidden = !visible;
        if (enabled) n.removeAttribute('aria-disabled'); else n.setAttribute('aria-disabled', 'true');
    };
    flag('ae-save', canSave, !ro);
    flag('ae-send', editorCanSend(ed, ro, writes), !ro);
    const canDelete = ed.mode !== 'new' && ed.source === 'dashboard';
    flag('ae-delete', writes && !ed.busy, canDelete);
    const del = aeEl('ae-delete');
    if (del) del.title = writes ? '' : paymentWritesTip();
    const save = aeEl('ae-save');
    if (save) save.title = writes ? '' : paymentWritesTip();
    flag('ae-copy', true, ed.mode !== 'new' && !(ed.rule && ed.rule.superseded));
    aeText('ae-cancel', ro ? 'Close' : 'Cancel');
    aeShow('ae-foot', !ed.confirmDelete);
    aeShow('ae-confirm', !!ed.confirmDelete);
    aeText('ae-copy-status', ed.copyStatus || '');
    if (ed.json) {
        const area = aeEl('ae-json-text');
        if (area && area.value !== ed.json) area.value = ed.json;
    }
}

function editorSyncDialog(open) {
    const dlg = aeEl('alert-editor');
    if (!dlg) return;
    if (open && !dlg.open && typeof dlg.showModal === 'function') dlg.showModal();
    if (!open && dlg.open && typeof dlg.close === 'function') dlg.close();
}

function editorFocusRequest(ed) {
    if (ed.opener) paymentsFocusRequest = ed.opener;
}

async function openEditor(spec) {
    const writeMode = spec.mode === 'new' || spec.mode === 'edit' || spec.confirmDelete;
    if (writeMode && !paymentWritesAllowed()) return;
    clearTimeout(editorPreviewTimer);
    editorPreviewSeq += 1;
    const rule = spec.mode === 'new' ? null : editorStoredRule(spec.server, spec.alertId, spec.source);
    if (spec.mode !== 'new' && !rule) return;
    const ed = {
        mode: spec.mode, server: spec.server, alertId: spec.alertId || '', source: spec.source || 'dashboard', rule,
        opener: spec.opener || '', data: null, form: null, errors: {}, invalid: {}, banner: '', loading: true, busy: false,
        confirmDelete: !!spec.confirmDelete, preview: null, json: '', copyStatus: '', idTouched: true
    };
    paymentsEditor = ed;
    renderEditor();
    editorSyncDialog(true);
    const title = aeEl('alert-editor-title');
    if (title && typeof title.focus === 'function') title.focus();

    const result = await editorRequest('GET', `/api/dashboard/payment-schedules/${encodeURIComponent(spec.server)}`);
    if (paymentsEditor !== ed) return;
    if (result.ok && result.json && Array.isArray(result.json.schedules)) {
        ed.data = result.json;
    } else {
        ed.data = { configured: false, capturedAt: null, schedules: [], defaults: {} };
        if (spec.mode !== 'view') ed.banner = mapEditorError(result.status, result.json, 'save').banner;
    }
    ed.form = editorFormFromRule(ed);
    if (rule && rule.invalid) {
        for (const e of rule.errors || []) {
            const field = editorFieldForPath(e.path);
            if (field && !ed.errors[field]) { ed.errors[field] = e.message; ed.invalid[field] = true; }
        }
    }
    ed.loading = false;
    editorBuildDom(ed);
    renderEditor();
    if (title && typeof title.focus === 'function') title.focus();
    if (!editorReadOnly(ed) && writeMode) editorSchedulePreview(ed);
}

function closeEditor(reload) {
    const ed = paymentsEditor;
    if (!ed) return;
    paymentsEditor = null;
    clearTimeout(editorPreviewTimer);
    editorPreviewSeq += 1;
    editorSyncDialog(false);
    editorFocusRequest(ed);
    if (reload) {
        fetchPaymentRules(ed.server).then((entry) => { paymentsRules.set(ed.server, entry); renderPayments(); });
    }
    renderPayments();
}

function closeAlertEditor() {
    closeEditor(false);
}

function editorRowSpec(mode, el, extra) {
    return {
        mode, server: el.dataset.server, alertId: el.dataset.alert, source: el.dataset.source,
        opener: el.dataset.focus || '', ...extra
    };
}

function openAlertEditor(arg, el) {
    if (el.getAttribute('aria-disabled') === 'true') return;
    openEditor({ mode: 'new', server: el.dataset.server, opener: el.dataset.focus || '' });
}

function editPaymentRule(arg, el) {
    if (el.getAttribute('aria-disabled') === 'true') return;
    openEditor(editorRowSpec('edit', el));
}

function viewPaymentRule(arg, el) {
    openEditor(editorRowSpec('view', el));
}

function deletePaymentRuleAsk(arg, el) {
    if (el.getAttribute('aria-disabled') === 'true') return;
    const ed = paymentsEditor;
    if (ed && !el.dataset.alert) { // the dialog's own Delete button
        ed.confirmDelete = true;
        renderEditor();
        const yes = aeEl('ae-delete-yes');
        if (yes && typeof yes.focus === 'function') yes.focus();
        return;
    }
    openEditor(editorRowSpec('edit', el, { confirmDelete: true }));
}

function deletePaymentRuleKeep() {
    const ed = paymentsEditor;
    if (!ed) return;
    ed.confirmDelete = false;
    renderEditor();
    const btn = aeEl('ae-delete');
    if (btn && typeof btn.focus === 'function') btn.focus();
}

async function deletePaymentRuleConfirm() {
    const ed = paymentsEditor;
    if (!ed || ed.busy) return;
    if (!paymentWritesAllowed()) { ed.banner = paymentWritesTip(); ed.confirmDelete = false; renderEditor(); return; }
    ed.busy = true;
    renderEditor();
    const result = await editorRequest('DELETE', editorRuleUrl(ed.server, ed.alertId));
    if (paymentsEditor !== ed) return;
    ed.busy = false;
    if (result.ok && result.json && result.json.deleted === true) {
        ed.opener = `add:${ed.server}`;
        setPaymentNotice('Alert deleted.');
        closeEditor(true);
        return;
    }
    editorApplyError(ed, mapEditorError(result.status, result.json, 'delete'));
    ed.confirmDelete = false;
    renderEditor();
}

function setPaymentNotice(text) {
    aeText('payments-notice', text);
}

// Shared by save, delete and preview failures.
function editorApplyError(ed, mapped) {
    ed.banner = mapped.banner;
    for (const [field, message] of Object.entries(mapped.fields)) ed.errors[field] = message;
    if (mapped.writesOff) {
        paymentsCaps = { ...(paymentsCaps || {}), configWrites: false, reason: paymentsCaps && paymentsCaps.reason ? paymentsCaps.reason : 'disabled' };
        loadPaymentCapabilities().then(() => { renderPayments(); renderEditor(); });
        renderPayments();
    }
    if (mapped.close) {
        const server = ed.server;
        ed.opener = `add:${server}`;
        closeEditor(true);
    }
}

function editorFocusFirstError(ed) {
    const order = ['id', 'watch', 'graceDays', 'earlyDays', 'period', 'tolerance', 'reminders', 'channels'];
    const target = { id: 'ae-id', watch: ed.form.watch === 'prefix' ? 'ae-prefix' : 'ae-schedule', graceDays: 'ae-grace', earlyDays: 'ae-early', tolerance: 'ae-tol', reminders: 'ae-remind-days' };
    const field = order.find((k) => ed.errors[k]);
    const node = field ? aeEl(target[field] || 'ae-id') : null;
    if (node && typeof node.focus === 'function') node.focus();
}

async function savePaymentRule() {
    const ed = paymentsEditor;
    if (!ed || ed.busy || ed.loading || editorReadOnly(ed)) return;
    if (!paymentWritesAllowed()) { ed.banner = paymentWritesTip(); renderEditor(); return; }
    if (!editorCanSave(ed, false, true, {})) return;
    const problems = editorProblems(ed);
    ed.banner = '';
    if (Object.keys(problems).length > 0) {
        Object.assign(ed.errors, problems);
        renderEditor();
        editorFocusFirstError(ed);
        return;
    }
    ed.busy = true;
    renderEditor();
    const body = editorBuildBody(ed);
    const result = ed.mode === 'new'
        ? await editorRequest('POST', editorRuleUrl(ed.server), body)
        : await editorRequest('PUT', editorRuleUrl(ed.server, ed.alertId), body);
    if (paymentsEditor !== ed) return;
    ed.busy = false;
    if (result.ok && result.json && result.json.rule) {
        ed.opener = editorSavedFocusKey(ed.server, result.json.rule.id);
        setPaymentNotice(ed.mode === 'new' ? 'Alert saved.' : 'Alert updated.');
        closeEditor(true);
        return;
    }
    const mapped = mapEditorError(result.status, result.json, 'save');
    editorApplyError(ed, mapped);
    if (paymentsEditor === ed) {
        renderEditor();
        editorFocusFirstError(ed);
    }
}

// ---- preview ----------------------------------------------------------------
function editorSchedulePreview(ed) {
    clearTimeout(editorPreviewTimer);
    if (!paymentWritesAllowed() || editorReadOnly(ed) || ed.mode === 'view') return;
    editorPreviewTimer = setTimeout(() => runEditorPreview(ed, false), EDITOR_PREVIEW_DELAY_MS);
}

function editorResultLines(results) {
    return (results || []).map((r) => `${r.channel}${r.target ? ` (${r.target})` : ''}: ${r.ok ? 'sent' : `failed${r.error ? ` (${r.error})` : ''}`}`);
}

async function runEditorPreview(ed, send) {
    if (paymentsEditor !== ed || ed.loading || !paymentWritesAllowed() || editorReadOnly(ed)) return;
    const problems = editorProblems(ed);
    if (Object.keys(problems).length > 0) {
        ed.preview = { text: '', sampleKeys: [], note: send ? 'Complete the form first.' : '', lines: [] };
        renderEditor();
        return;
    }
    editorPreviewSeq += 1;
    const seq = editorPreviewSeq;
    const result = await editorRequest('POST', `/api/dashboard/payment-preview/${encodeURIComponent(ed.server)}`,
        { rule: editorBuildBody(ed), event: ed.form.previewEvent, send });
    if (paymentsEditor !== ed || seq !== editorPreviewSeq) return;
    // Each answer replaces the earlier template errors.
    for (const k of Object.keys(ed.errors)) if (k.startsWith('template:') && !ed.invalid[k]) delete ed.errors[k];
    const json = result.json || {};
    if (result.ok || (result.status === 502 && json.error === 'send_failed')) {
        const lines = send ? editorResultLines(json.results) : [];
        if (send && result.ok) {
            const ok = (json.results || []).filter((r) => r.ok).length;
            const total = (json.results || []).length;
            lines.unshift(ok === total ? `Sent to ${total} destination${total === 1 ? '' : 's'}` : `Sent to ${ok} of ${total} destinations`);
        }
        ed.preview = {
            text: json.text, sampleKeys: json.sampleKeys || [], lines,
            note: result.ok ? '' : mapEditorError(502, json, 'preview').preview
        };
    } else {
        const mapped = mapEditorError(result.status, result.json, 'preview');
        for (const [field, message] of Object.entries(mapped.fields)) ed.errors[field] = message;
        ed.preview = { text: '', sampleKeys: [], lines: [], note: mapped.preview || mapped.banner };
        if (mapped.writesOff) editorApplyError(ed, { banner: '', fields: {}, writesOff: true });
    }
    renderEditor();
}

function sendPaymentTest(arg, el) {
    const ed = paymentsEditor;
    if (!ed || el.getAttribute('aria-disabled') === 'true' || !beginEditorSend(ed)) return;
    clearTimeout(editorPreviewTimer);
    renderEditor();
    runEditorPreview(ed, true).finally(() => {
        ed.sending = false;
        if (paymentsEditor === ed) renderEditor();
    });
}

// ---- form events ------------------------------------------------------------
function onEditorInput(arg, el) {
    const ed = paymentsEditor;
    if (!ed || !ed.form) return;
    const f = ed.form;
    const field = el.dataset.field;
    if (field === 'id') { f.id = el.value; ed.idTouched = true; }
    else if (field === 'prefix') { f.prefix = el.value; if (ed.mode === 'new' && !ed.idTouched) { f.id = editorSuggestId(ed, f); const n = aeEl('ae-id'); if (n) n.value = f.id; } }
    else if (field === 'graceDays' || field === 'earlyDays') f[field] = el.value;
    else if (field === 'tolerance') f.tolerance = el.value;
    else if (field === 'period') f.period = el.value;
    else if (field === 'remindOn') f.remindOn = !!el.checked;
    else if (field === 'remindDays') f.remindDays = el.value;
    else if (field === 'previewEvent') { f.previewEvent = el.value; editorBuildChips(ed); }
    else if (field === 'channel') f.channels = editorChannels().filter((name) => {
        const box = aeEl('ae-channels');
        const cbs = box && box.querySelectorAll ? Array.from(box.querySelectorAll('input')) : [];
        const cb = cbs.find((c) => c.value === name);
        return cb ? cb.checked : f.channels.includes(name);
    });
    else if (field && field.startsWith('template:')) {
        const event = field.slice('template:'.length);
        f.templates[event] = el.value;
        if (f.previewEvent !== event) {
            f.previewEvent = event;
            const sel = aeEl('ae-preview-event');
            if (sel) sel.value = event;
            editorBuildChips(ed);
        }
    }
    const errKey = field === 'remindOn' || field === 'remindDays' ? 'reminders' : field === 'prefix' ? 'watch'
        : field === 'channel' ? 'channels' : field === 'previewEvent' ? '' : field;
    if (errKey) { delete ed.errors[errKey]; delete ed.invalid[errKey]; }
    renderEditor();
    editorSchedulePreview(ed);
}

// An emptied message falls back to the default text (and the key is dropped on save).
function onEditorTemplateChange(arg, el) {
    const ed = paymentsEditor;
    if (!ed || !ed.form || el.value !== '') return;
    const event = el.dataset.field.slice('template:'.length);
    el.value = effectiveTemplate((ed.data && ed.data.defaults) || {}, event);
    ed.form.templates[event] = '';
}

function onEditorWatchModeChange(arg, el) {
    const ed = paymentsEditor;
    if (!ed || !ed.form) return;
    ed.form.watch = el.value === 'prefix' ? 'prefix' : 'schedule';
    delete ed.errors.watch;
    delete ed.invalid.watch;
    if (ed.form.watch === 'schedule' && !ed.form.schedule) {
        const sel = aeEl('ae-schedule');
        if (sel) ed.form.schedule = sel.value;
    }
    if (ed.mode === 'new' && !ed.idTouched) { ed.form.id = editorSuggestId(ed, ed.form); const n = aeEl('ae-id'); if (n) n.value = ed.form.id; }
    renderEditor();
    editorSchedulePreview(ed);
}

function onEditorScheduleChange(arg, el) {
    const ed = paymentsEditor;
    if (!ed || !ed.form) return;
    ed.form.schedule = el.value;
    delete ed.errors.watch;
    delete ed.invalid.watch;
    if (ed.mode === 'new' && !ed.idTouched) { ed.form.id = editorSuggestId(ed, ed.form); const n = aeEl('ae-id'); if (n) n.value = ed.form.id; }
    renderEditor();
    editorSchedulePreview(ed);
}

function insertTemplateVariable(name) {
    const ed = paymentsEditor;
    if (!ed || !ed.form || editorReadOnly(ed)) return;
    const event = ed.form.previewEvent;
    const area = aeEl(`ae-tpl-${event}`);
    if (!area) return;
    const token = `{{${name}}}`;
    const start = typeof area.selectionStart === 'number' ? area.selectionStart : area.value.length;
    const end = typeof area.selectionEnd === 'number' ? area.selectionEnd : start;
    area.value = area.value.slice(0, start) + token + area.value.slice(end);
    ed.form.templates[event] = area.value;
    delete ed.errors[`template:${event}`];
    delete ed.invalid[`template:${event}`];
    if (typeof area.focus === 'function') area.focus();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(start + token.length, start + token.length);
    renderEditor();
    editorSchedulePreview(ed);
}

// ---- Copy as JSON -------------------------------------------------------------
async function copyPaymentRuleJson(arg, el) {
    let ed = paymentsEditor;
    let text = '';
    if (el.dataset.alert) { // a row button: the stored definition, no dialog unless the clipboard fails
        const rule = editorStoredRule(el.dataset.server, el.dataset.alert, el.dataset.source);
        if (!rule) return;
        text = JSON.stringify(rule.definition, null, 2);
    } else if (ed && ed.form) {
        const stored = ed.rule && ed.rule.definition;
        text = JSON.stringify(ed.mode === 'view' || editorReadOnly(ed) ? stored : editorBuildBody(ed), null, 2);
    } else return;
    let copied = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { copied = false; }
    }
    if (copied) {
        if (ed && ed === paymentsEditor) { ed.copyStatus = 'Copied.'; renderEditor(); } else setPaymentNotice('Copied to the clipboard.');
        return;
    }
    // Fallback: a read-only, preselected textarea the user copies from.
    if (!ed || ed !== paymentsEditor) {
        await openEditor(editorRowSpec('view', el));
        ed = paymentsEditor;
        if (!ed) return;
    }
    ed.json = text;
    ed.copyStatus = '';
    renderEditor();
    const area = aeEl('ae-json-text');
    if (area) {
        if (typeof area.focus === 'function') area.focus();
        if (typeof area.select === 'function') area.select();
    }
}

// The dialog's Esc/cancel event is bound on the element, once, after the DOM exists.
function bindAlertEditorDialog() {
    const dlg = aeEl('alert-editor');
    if (!dlg || typeof dlg.addEventListener !== 'function') return;
    dlg.addEventListener('cancel', (e) => {
        e.preventDefault(); // closeEditor closes it and puts the focus back
        if (paymentsEditor && paymentsEditor.busy) return;
        closeEditor(false);
    });
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
    reloadConfigAudit: () => loadConfigAudit(),
    togglePaymentRow: (arg, el) => togglePaymentRow(arg, el),
    setPaymentStateFilter: (arg) => setPaymentStateFilter(arg),
    paymentsSyncNow: (arg) => paymentsSyncNow(arg),
    togglePaymentAlert: (arg, el) => togglePaymentAlert(arg, el),
    openPaymentMute: (arg, el) => openPaymentMute(arg, el),
    cancelPaymentMute: (arg, el) => cancelPaymentMute(arg, el),
    unmutePaymentAlert: (arg, el) => unmutePaymentAlert(arg, el),
    deleteOrphanedOverride: (arg, el) => deleteOrphanedOverride(el),
    openAlertEditor: (arg, el) => openAlertEditor(arg, el),
    editPaymentRule: (arg, el) => editPaymentRule(arg, el),
    viewPaymentRule: (arg, el) => viewPaymentRule(arg, el),
    copyPaymentRuleJson: (arg, el) => copyPaymentRuleJson(arg, el),
    deletePaymentRuleAsk: (arg, el) => deletePaymentRuleAsk(arg, el),
    deletePaymentRuleConfirm: () => deletePaymentRuleConfirm(),
    deletePaymentRuleKeep: () => deletePaymentRuleKeep(),
    savePaymentRule: (arg, el) => { if (el.getAttribute('aria-disabled') !== 'true') savePaymentRule(); },
    sendPaymentTest: (arg, el) => sendPaymentTest(arg, el),
    insertTemplateVariable: (arg) => insertTemplateVariable(arg),
    closeAlertEditor: () => closeAlertEditor()
};
const CHANGE_ACTIONS = {
    renderAccounts: () => renderAccounts(),
    onDateFormatChange: () => onDateFormatChange(),
    loadHistoryTab: () => loadHistoryTab(),
    onPaymentsServerChange: () => onPaymentsServerChange(),
    onEditorWatchModeChange: (arg, el) => onEditorWatchModeChange(arg, el),
    onEditorScheduleChange: (arg, el) => onEditorScheduleChange(arg, el),
    onEditorTemplateChange: (arg, el) => onEditorTemplateChange(arg, el)
};
const INPUT_ACTIONS = {
    onPaymentsSearch: (arg, el) => onPaymentsSearch(arg, el),
    onPaymentMuteField: (arg, el) => onPaymentMuteField(arg, el),
    onEditorInput: (arg, el) => onEditorInput(arg, el)
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
// The inline mute form: Enter (submit) saves, Esc cancels. (#261)
document.addEventListener('submit', (e) => {
    const form = e.target.closest && e.target.closest('[data-form="paymentMute"]');
    if (!form) return;
    e.preventDefault();
    savePaymentMute(form);
});
// Enter in a single line field of the alert editor saves (the form has no submit button).
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target || !e.target.closest) return;
    if (e.target.tagName !== 'INPUT' || e.target.type === 'checkbox' || e.target.type === 'radio') return;
    if (!e.target.closest('[data-form="alertEditor"]')) return;
    e.preventDefault();
    savePaymentRule();
});
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const form = e.target.closest && e.target.closest('[data-form="paymentMute"]');
    if (form) cancelPaymentMute(undefined, form);
});
document.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('[data-input]');
    const action = el && INPUT_ACTIONS[el.dataset.input];
    if (action) action(undefined, el);
});

bindAlertEditorDialog();

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

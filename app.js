// Import Express.js
const express = require('express');
const path = require('path');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Enable CORS for dashboard cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Set port and verify_token
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// --- Multi-App Webhook Log Store ---
const webhookLogs = {};  // { appName: [logs] }
const MAX_LOGS = 500;

function storeLog(appName, entry) {
  if (!webhookLogs[appName]) webhookLogs[appName] = [];
  webhookLogs[appName].unshift(entry);
  if (webhookLogs[appName].length > MAX_LOGS) webhookLogs[appName].pop();
}

function getAllLogs(limit) {
  var all = [];
  for (var app in webhookLogs) {
    for (var i = 0; i < webhookLogs[app].length; i++) {
      all.push(webhookLogs[app][i]);
    }
  }
  all.sort(function(a, b) { return new Date(b.received_at) - new Date(a.received_at); });
  return all.slice(0, limit);
}
// --- End Log Store ---

// --- Google Sheets Logging ---
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyW8VlturFb-m2KTMMw1uj5dTZgOaAhQCR1LtPHLHpd8bT_qfAbuSM2-LRrY7n-uhyf/exec';

function logToSheet(data) {
  fetch(GOOGLE_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).catch(err => console.error('Sheet logging error:', err));
}
// --- End Google Sheets Logging ---

// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Auto-refreshing logs viewer (all apps or specific app)
app.get('/logs/live', (req, res) => {
  res.send('<!DOCTYPE html>\n' +
    '<html><head><meta charset="UTF-8"><title>Live Logs</title>' +
    '<style>body{font-family:monospace;background:#1c2b33;color:#a7f3d0;padding:20px;}' +
    'pre{white-space:pre-wrap;}</style></head>' +
    '<body><h3 style="color:white;">Live Webhook Logs - All Apps (auto-refresh 10s)</h3>' +
    '<pre id="logs">Loading...</pre>' +
    '<script>' +
    'function refresh(){' +
    'fetch("/logs?limit=500").then(function(r){return r.json();}).then(function(d){' +
    'document.getElementById("logs").textContent=JSON.stringify(d,null,2);' +
    '});}' +
    'refresh();setInterval(refresh,10000);' +
    '</script></body></html>');
});

app.get('/logs/live/:appName', (req, res) => {
  var appName = req.params.appName;
  res.send('<!DOCTYPE html>\n' +
    '<html><head><meta charset="UTF-8"><title>Live Logs - ' + appName + '</title>' +
    '<style>body{font-family:monospace;background:#1c2b33;color:#a7f3d0;padding:20px;}' +
    'pre{white-space:pre-wrap;}</style></head>' +
    '<body><h3 style="color:white;">Live Webhook Logs - ' + appName + ' (auto-refresh 10s)</h3>' +
    '<pre id="logs">Loading...</pre>' +
    '<script>' +
    'function refresh(){' +
    'fetch("/logs/' + appName + '?limit=500").then(function(r){return r.json();}).then(function(d){' +
    'document.getElementById("logs").textContent=JSON.stringify(d,null,2);' +
    '});}' +
    'refresh();setInterval(refresh,10000);' +
    '</script></body></html>');
});

// Webhook verification (supports both / and /webhook/:appName)
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED (root)');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

app.get('/webhook/:appName', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED for ' + req.params.appName);
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Receive webhooks - dynamic route (POST /webhook/:appName)
app.post('/webhook/:appName', (req, res) => {
  const appName = req.params.appName;
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\n[${appName}] Webhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  // Store in memory under app name
  storeLog(appName, {
    received_at: new Date().toISOString(),
    app: appName,
    payload: req.body
  });

  // Log to Google Sheets
  const body = req.body;
  const entry = body.entry && body.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const val = change && change.value;
  const msg = (val && val.messages && val.messages[0]) || (val && val.standby && val.standby.messages && val.standby.messages[0]);
  const status = val && val.statuses && val.statuses[0];

  if (msg) {
    logToSheet({
      timestamp: new Date().toISOString(),
      event_type: (change && change.field) || 'message',
      from: msg.from || '',
      to: (val && val.metadata && val.metadata.display_phone_number) || '',
      message_type: msg.type || '',
      message_body: (msg.text && msg.text.body) || msg.type || '',
      status: '',
      raw_payload: JSON.stringify(body, null, 2),
      app: appName
    });
  } else if (status) {
    logToSheet({
      timestamp: new Date().toISOString(),
      event_type: 'status',
      from: (val && val.metadata && val.metadata.display_phone_number) || '',
      to: status.recipient_id || '',
      message_type: '',
      message_body: '',
      status: status.status || '',
      raw_payload: JSON.stringify(body, null, 2),
      app: appName
    });
  } else {
    logToSheet({
      timestamp: new Date().toISOString(),
      event_type: (change && change.field) || 'unknown',
      from: '',
      to: '',
      message_type: '',
      message_body: '',
      status: '',
      raw_payload: JSON.stringify(body, null, 2),
      app: appName
    });
  }

  res.status(200).end();
});

// Also keep root POST for backward compatibility
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\n[default] Webhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  storeLog('default', {
    received_at: new Date().toISOString(),
    app: 'default',
    payload: req.body
  });

  res.status(200).end();
});

// GET /logs - All apps combined
app.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_LOGS);
  const keyword = req.query.search ? req.query.search.toLowerCase() : null;
  const registeredApps = Object.keys(webhookLogs);

  let results = getAllLogs(MAX_LOGS);

  if (keyword) {
    results = results.filter(log =>
      JSON.stringify(log).toLowerCase().includes(keyword)
    );
  }

  results = results.slice(0, limit);

  res.json({
    total_stored: registeredApps.reduce((sum, app) => sum + webhookLogs[app].length, 0),
    returned: results.length,
    apps: registeredApps,
    logs: results
  });
});

// GET /logs/:appName - Specific app logs
app.get('/logs/:appName', (req, res) => {
  const appName = req.params.appName;
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_LOGS);
  const keyword = req.query.search ? req.query.search.toLowerCase() : null;

  let appLogs = webhookLogs[appName] || [];

  if (keyword) {
    appLogs = appLogs.filter(log =>
      JSON.stringify(log).toLowerCase().includes(keyword)
    );
  }

  let results = appLogs.slice(0, limit);

  res.json({
    app: appName,
    total_stored: (webhookLogs[appName] || []).length,
    returned: results.length,
    logs: results
  });
});

// List all registered apps
app.get('/apps', (req, res) => {
  const apps = Object.keys(webhookLogs).map(name => ({
    name: name,
    total_stored: webhookLogs[name].length,
    latest: webhookLogs[name][0] ? webhookLogs[name][0].received_at : null
  }));
  res.json({ apps: apps });
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
  console.log('Routes:');
  console.log('  POST /webhook/:appName  - Receive webhooks');
  console.log('  GET  /logs/:appName     - View app logs');
  console.log('  GET  /logs              - View all logs');
  console.log('  GET  /apps              - List registered apps');
  console.log('  GET  /dashboard         - Dashboard UI');
  console.log('  GET  /logs/live         - Live auto-refresh (all)');
  console.log('  GET  /logs/live/:app    - Live auto-refresh (per app)');
});

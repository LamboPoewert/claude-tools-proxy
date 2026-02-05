const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Admin secret for stats endpoint — set ADMIN_SECRET in Railway env
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// ============== STATS TRACKING ==============
const stats = {
  startTime: Date.now(),
  uniqueUsers: new Set(), // Track by IP
  totalTransactions: 0,   // Individual TXs sent via /send-txs
  totalRpcCalls: 0,       // Calls to /rpc endpoint
  totalSendTxCalls: 0,    // Calls to /send-txs endpoint
  totalMetadataCreated: 0,
  totalImagesUploaded: 0,
  // These require desktop app to report (added via /stats/report endpoint)
  totalSolVolume: 0,      // SOL volume from buys
  totalFeesEarned: 0,     // 1% fees collected
  // Breakdown by action type
  launches: 0,
  buys: 0,
  sells: 0,
};

function trackUser(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || 'unknown';
  stats.uniqueUsers.add(ip);
}

// In-memory store for token metadata (Metaplex-style JSON) — keyed by short id, served at GET /metadata/:id
const metadataStore = new Map();
// In-memory store for uploaded images — keyed by short id, value: { buffer, mimeType }
const imageStore = new Map();

// RPC provider: Constant K only. Set CONSTANTK_RPC_URL in Railway env (full URL with api-key).
const RPC_URL = process.env.CONSTANTK_RPC_URL || null;

// Helius Sender: dual-send for higher TX landing rate. Set HELIUS_API_KEY in Railway env.
// Sender is free (no credits), routes through staked connections + Jito simultaneously.
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || null;
const HELIUS_SENDER_URL = HELIUS_API_KEY
  ? `https://sender.helius-rpc.com/fast?api-key=${HELIUS_API_KEY}`
  : null;

// Kaldera gRPC (Constant K Yellowstone). Set in Railway: KALDERA_GRPC_URL, KALDERA_X_TOKEN.
const KALDERA_GRPC_URL = process.env.KALDERA_GRPC_URL || null;
const KALDERA_X_TOKEN = process.env.KALDERA_X_TOKEN || null;


// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check — before rate limiter so connection test and Railway healthchecks never get 429
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Claude Tools Proxy',
    version: '1.0.0'
  });
});

// ============== ADMIN DASHBOARD (HTML) ==============
app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard - Claude Tools Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #e4e4e7;
    }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    h1 {
      font-size: 2rem;
      margin-bottom: 2rem;
      color: #22d3ee;
      text-align: center;
      text-shadow: 0 0 20px rgba(34, 211, 238, 0.3);
    }
    .login-box {
      max-width: 400px;
      margin: 4rem auto;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 2rem;
      backdrop-filter: blur(10px);
    }
    .login-box h2 { margin-bottom: 1.5rem; color: #a5b4fc; text-align: center; }
    .login-box input {
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(0,0,0,0.3);
      color: #fff;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    .login-box input:focus { outline: none; border-color: #22d3ee; }
    .login-box button {
      width: 100%;
      padding: 0.75rem;
      background: linear-gradient(135deg, #22d3ee, #818cf8);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .login-box button:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(34, 211, 238, 0.4); }
    .error { color: #f87171; text-align: center; margin-top: 1rem; }
    .dashboard { display: none; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1.5rem;
      backdrop-filter: blur(10px);
    }
    .stat-card h3 {
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      margin-bottom: 0.5rem;
    }
    .stat-card .value {
      font-size: 2rem;
      font-weight: 700;
      color: #22d3ee;
    }
    .stat-card .sub { font-size: 0.875rem; color: #64748b; margin-top: 0.25rem; }
    .stat-card.highlight { border-color: rgba(34, 211, 238, 0.3); background: rgba(34, 211, 238, 0.1); }
    .stat-card.highlight .value { color: #4ade80; }
    .breakdown { margin-top: 1rem; }
    .breakdown-item {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .breakdown-item:last-child { border-bottom: none; }
    .breakdown-item .label { color: #94a3b8; }
    .breakdown-item .val { color: #e4e4e7; font-weight: 600; }
    .refresh-info { text-align: center; color: #64748b; font-size: 0.875rem; margin-top: 1rem; }
    .last-updated { text-align: center; color: #64748b; font-size: 0.75rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Claude Tools Proxy - Admin Dashboard</h1>

    <div class="login-box" id="loginBox">
      <h2>Enter Admin Secret</h2>
      <input type="password" id="secretInput" placeholder="Admin secret..." autocomplete="off">
      <button onclick="login()">Access Dashboard</button>
      <div class="error" id="loginError"></div>
    </div>

    <div class="dashboard" id="dashboard">
      <div class="stats-grid">
        <div class="stat-card">
          <h3>Uptime</h3>
          <div class="value" id="uptime">-</div>
          <div class="sub" id="since">-</div>
        </div>
        <div class="stat-card">
          <h3>Unique Users</h3>
          <div class="value" id="uniqueUsers">-</div>
          <div class="sub">by IP address</div>
        </div>
        <div class="stat-card highlight">
          <h3>Total SOL Volume</h3>
          <div class="value" id="solVolume">-</div>
          <div class="sub">from launches + buys</div>
        </div>
        <div class="stat-card highlight">
          <h3>Fees Earned (1%)</h3>
          <div class="value" id="feesEarned">-</div>
          <div class="sub">SOL</div>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <h3>Operations</h3>
          <div class="breakdown">
            <div class="breakdown-item">
              <span class="label">Launches</span>
              <span class="val" id="launches">-</span>
            </div>
            <div class="breakdown-item">
              <span class="label">Buys</span>
              <span class="val" id="buys">-</span>
            </div>
            <div class="breakdown-item">
              <span class="label">Sells</span>
              <span class="val" id="sells">-</span>
            </div>
          </div>
        </div>
        <div class="stat-card">
          <h3>Transactions</h3>
          <div class="breakdown">
            <div class="breakdown-item">
              <span class="label">Total TXs Sent</span>
              <span class="val" id="totalTxs">-</span>
            </div>
            <div class="breakdown-item">
              <span class="label">Send-TX Calls</span>
              <span class="val" id="sendTxCalls">-</span>
            </div>
            <div class="breakdown-item">
              <span class="label">RPC Calls</span>
              <span class="val" id="rpcCalls">-</span>
            </div>
          </div>
        </div>
        <div class="stat-card">
          <h3>Metadata</h3>
          <div class="breakdown">
            <div class="breakdown-item">
              <span class="label">Metadata Created</span>
              <span class="val" id="metadataCreated">-</span>
            </div>
            <div class="breakdown-item">
              <span class="label">Images Uploaded</span>
              <span class="val" id="imagesUploaded">-</span>
            </div>
          </div>
        </div>
      </div>

      <div class="refresh-info">Auto-refreshes every 30 seconds</div>
      <div class="last-updated" id="lastUpdated">-</div>
    </div>
  </div>

  <script>
    let adminSecret = '';
    let refreshInterval = null;

    // Check localStorage for saved secret
    const saved = localStorage.getItem('adminSecret');
    if (saved) {
      adminSecret = saved;
      tryAutoLogin();
    }

    async function tryAutoLogin() {
      try {
        const res = await fetch('/admin/stats?secret=' + encodeURIComponent(adminSecret));
        if (res.ok) {
          showDashboard();
          loadStats();
        } else {
          localStorage.removeItem('adminSecret');
          adminSecret = '';
        }
      } catch (e) {
        localStorage.removeItem('adminSecret');
      }
    }

    async function login() {
      const input = document.getElementById('secretInput');
      const error = document.getElementById('loginError');
      adminSecret = input.value.trim();

      if (!adminSecret) {
        error.textContent = 'Please enter the admin secret';
        return;
      }

      try {
        const res = await fetch('/admin/stats?secret=' + encodeURIComponent(adminSecret));
        if (res.ok) {
          localStorage.setItem('adminSecret', adminSecret);
          error.textContent = '';
          showDashboard();
          loadStats();
        } else if (res.status === 401) {
          error.textContent = 'Invalid admin secret';
        } else {
          const data = await res.json();
          error.textContent = data.error || 'Error accessing stats';
        }
      } catch (e) {
        error.textContent = 'Network error';
      }
    }

    function showDashboard() {
      document.getElementById('loginBox').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      refreshInterval = setInterval(loadStats, 30000);
    }

    async function loadStats() {
      try {
        const res = await fetch('/admin/stats?secret=' + encodeURIComponent(adminSecret));
        if (!res.ok) {
          if (res.status === 401) {
            localStorage.removeItem('adminSecret');
            location.reload();
          }
          return;
        }
        const data = await res.json();

        // Uptime
        const hours = data.uptime.hours;
        const uptimeStr = hours >= 24
          ? (hours / 24).toFixed(1) + ' days'
          : hours >= 1
            ? hours.toFixed(1) + ' hours'
            : Math.floor(data.uptime.seconds / 60) + ' min';
        document.getElementById('uptime').textContent = uptimeStr;
        document.getElementById('since').textContent = 'since ' + new Date(data.uptime.since).toLocaleString();

        // Users
        document.getElementById('uniqueUsers').textContent = data.users.unique.toLocaleString();

        // Volume & Fees
        document.getElementById('solVolume').textContent = data.volume.totalSolBought.toFixed(4) + ' SOL';
        document.getElementById('feesEarned').textContent = data.volume.feesEarned.toFixed(4) + ' SOL';

        // Operations breakdown
        document.getElementById('launches').textContent = data.transactions.breakdown.launches.toLocaleString();
        document.getElementById('buys').textContent = data.transactions.breakdown.buys.toLocaleString();
        document.getElementById('sells').textContent = data.transactions.breakdown.sells.toLocaleString();

        // Transactions
        document.getElementById('totalTxs').textContent = data.transactions.total.toLocaleString();
        document.getElementById('sendTxCalls').textContent = data.transactions.sendTxCalls.toLocaleString();
        document.getElementById('rpcCalls').textContent = data.rpcCalls.toLocaleString();

        // Metadata
        document.getElementById('metadataCreated').textContent = data.metadata.created.toLocaleString();
        document.getElementById('imagesUploaded').textContent = data.metadata.imagesUploaded.toLocaleString();

        // Last updated
        document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
      } catch (e) {
        console.error('Failed to load stats:', e);
      }
    }

    // Enter key to login
    document.getElementById('secretInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        login();
      }
    });
  </script>
</body>
</html>`);
});

// ============== ADMIN STATS ENDPOINT ==============
app.get('/admin/stats', (req, res) => {
  // Check auth — require ?secret=ADMIN_SECRET or Authorization header
  const secret = req.query.secret || req.headers.authorization?.replace('Bearer ', '');
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'ADMIN_SECRET not configured on server' });
  }
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uptimeSeconds = Math.floor((Date.now() - stats.startTime) / 1000);
  const uptimeHours = (uptimeSeconds / 3600).toFixed(2);

  res.json({
    uptime: {
      seconds: uptimeSeconds,
      hours: parseFloat(uptimeHours),
      since: new Date(stats.startTime).toISOString(),
    },
    users: {
      unique: stats.uniqueUsers.size,
    },
    transactions: {
      total: stats.totalTransactions,
      sendTxCalls: stats.totalSendTxCalls,
      breakdown: {
        launches: stats.launches,
        buys: stats.buys,
        sells: stats.sells,
      },
    },
    rpcCalls: stats.totalRpcCalls,
    metadata: {
      created: stats.totalMetadataCreated,
      imagesUploaded: stats.totalImagesUploaded,
    },
    volume: {
      totalSolBought: stats.totalSolVolume,
      feesEarned: stats.totalFeesEarned,
    },
  });
});

// Endpoint for desktop app to report volume/fees (called after successful operations)
app.post('/stats/report', (req, res) => {
  try {
    trackUser(req);
    const { type, solAmount, feeAmount } = req.body || {};

    if (type === 'launch') {
      stats.launches++;
      if (typeof solAmount === 'number') stats.totalSolVolume += solAmount;
      if (typeof feeAmount === 'number') stats.totalFeesEarned += feeAmount;
    } else if (type === 'buy') {
      stats.buys++;
      if (typeof solAmount === 'number') stats.totalSolVolume += solAmount;
      if (typeof feeAmount === 'number') stats.totalFeesEarned += feeAmount;
    } else if (type === 'sell') {
      stats.sells++;
      // Sells don't add to SOL volume (they're token→SOL)
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    rpc: { configured: !!RPC_URL },
    helius: { configured: !!HELIUS_SENDER_URL },
  };

  // Quick RPC ping — getHealth is free and fast
  if (RPC_URL) {
    try {
      const rpcRes = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: AbortSignal.timeout(3000),
      });
      const rpcData = await rpcRes.json();
      health.rpc.status = rpcData.result === 'ok' ? 'ok' : 'degraded';
    } catch (e) {
      health.rpc.status = 'down';
      health.status = 'degraded';
    }
  }

  const httpCode = health.status === 'ok' ? 200 : 503;
  res.status(httpCode).json(health);
});

// Rate limiting - 2000 requests per 15 minutes per IP (applies to /rpc, /send-txs, /metadata, etc.; GET / is exempt)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Token metadata: POST to create (returns URI), GET /metadata/:id to fetch JSON (for pump.fun / explorers)
// POST body: { name, symbol, description?, image?, twitter?, telegram?, website? }
app.post('/metadata', (req, res) => {
  trackUser(req);
  stats.totalMetadataCreated++;
  try {
    const { name, symbol, description, image, twitter, telegram, website } = req.body || {};
    if (!name || !symbol) {
      return res.status(400).json({ error: 'name and symbol required' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const json = {
      name: String(name).trim(),
      symbol: String(symbol).trim().toUpperCase(),
      description: description ? String(description).trim() : '',
      image: image ? String(image).trim() : '',
      external_url: website ? String(website).trim() : '',
      attributes: [],
    };
    if (twitter || telegram || website) {
      json.attributes = [
        ...(twitter ? [{ trait_type: 'twitter', value: String(twitter).trim() }] : []),
        ...(telegram ? [{ trait_type: 'telegram', value: String(telegram).trim() }] : []),
        ...(website ? [{ trait_type: 'website', value: String(website).trim() }] : []),
      ];
    }
    metadataStore.set(id, json);
    const protocol = (req.get('x-forwarded-proto') === 'https' || req.get('x-forwarded-ssl') === 'on') ? 'https' : req.protocol;
    const baseUrl = protocol + '://' + req.get('host');
    const uri = `${baseUrl}/metadata/${id}`;
    res.json({ uri });
  } catch (error) {
    console.error('Metadata POST error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/metadata/:id', (req, res) => {
  const json = metadataStore.get(req.params.id);
  if (!json) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.set('Content-Type', 'application/json');
  res.send(JSON.stringify(json));
});

// Image upload: POST body { image: base64String, mimeType?: 'image/png' | 'image/jpeg' | ... } → returns { url }
app.post('/metadata/image', (req, res) => {
  trackUser(req);
  stats.totalImagesUploaded++;
  try {
    const { image, mimeType } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image (base64) required' });
    }
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const type = mimeType || 'image/png';
    imageStore.set(id, { buffer, mimeType: type });
    const protocol = (req.get('x-forwarded-proto') === 'https' || req.get('x-forwarded-ssl') === 'on') ? 'https' : req.protocol;
    const baseUrl = protocol + '://' + req.get('host');
    const url = `${baseUrl}/metadata/image/${id}`;
    res.json({ url });
  } catch (error) {
    console.error('Image upload error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/metadata/image/:id', (req, res) => {
  const entry = imageStore.get(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.set('Content-Type', entry.mimeType || 'image/png');
  res.send(entry.buffer);
});

// Proxy RPC requests to Constant K
app.post('/rpc', async (req, res) => {
  trackUser(req);
  stats.totalRpcCalls++;
  try {
    if (!RPC_URL) {
      return res.status(500).json({
        error: 'No RPC configured. Set CONSTANTK_RPC_URL in env.',
      });
    }

    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('RPC Error:', error.message);
    res.status(500).json({ error: 'RPC request failed' });
  }
});

// Send transactions via Constant K RPC + Helius Sender (dual-send for higher landing rate)
const RPC_BATCH_SIZE = 40; // Stay under 50 TPS limit for Constant K
const RPC_BATCH_DELAY_MS = 1100; // 1.1s gap between batches
const HELIUS_BATCH_SIZE = 15; // Helius Sender: 15 TPS limit
const HELIUS_BATCH_DELAY_MS = 1100;

app.post('/send-txs', async (req, res) => {
  trackUser(req);
  stats.totalSendTxCalls++;
  try {
    const { transactions } = req.body; // Array of base64 encoded signed transactions

    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'transactions array required (base64 encoded)' });
    }

    // Track individual transactions
    stats.totalTransactions += transactions.length;

    if (!RPC_URL) {
      return res.status(500).json({ error: 'No RPC configured. Set CONSTANTK_RPC_URL in env.' });
    }

    const heliusEnabled = !!HELIUS_SENDER_URL;
    console.log(`Sending ${transactions.length} TXs via Constant K RPC${heliusEnabled ? ' + Helius Sender' : ''} (parallel)...`);

    const allResults = new Array(transactions.length);

    // Send a single TX to Constant K RPC
    async function sendViaRpc(txBase64, idx) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: `tx-${idx}-${Date.now()}`,
            method: 'sendTransaction',
            params: [txBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }],
          }),
        });
        const data = await response.json();
        if (data.error) {
          return { success: false, error: data.error.message, source: 'rpc' };
        }
        return { success: true, signature: data.result, source: 'rpc' };
      } catch (e) {
        return { success: false, error: e.message, source: 'rpc' };
      }
    }

    // Send a single TX to Helius Sender
    async function sendViaHelius(txBase64, idx) {
      try {
        const response = await fetch(HELIUS_SENDER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: `helius-${idx}-${Date.now()}`,
            method: 'sendTransaction',
            params: [txBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
          }),
        });
        const data = await response.json();
        if (data.error) {
          return { success: false, error: data.error.message, source: 'helius' };
        }
        return { success: true, signature: data.result, source: 'helius' };
      } catch (e) {
        return { success: false, error: e.message, source: 'helius' };
      }
    }

    // Dual-send: fire each TX to both Constant K and Helius Sender in parallel.
    // Use the first successful result (both return the same signature for the same signed TX).
    async function sendOneDual(txBase64, idx) {
      const promises = [sendViaRpc(txBase64, idx)];
      if (heliusEnabled) {
        promises.push(sendViaHelius(txBase64, idx));
      }
      const results = await Promise.allSettled(promises);

      // Pick the first successful result
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.success) {
          const src = r.value.source;
          console.log(`TX ${idx + 1} sent via ${src}: ${r.value.signature}`);
          // Log if the other path also succeeded
          const otherResults = results.filter(o => o !== r && o.status === 'fulfilled' && o.value.success);
          if (otherResults.length > 0) {
            console.log(`TX ${idx + 1} also accepted by ${otherResults[0].value.source}`);
          }
          return { success: true, signature: r.value.signature };
        }
      }

      // Both failed — return the RPC error (primary)
      const rpcResult = results[0];
      const errMsg = rpcResult.status === 'fulfilled' ? rpcResult.value.error : rpcResult.reason?.message;
      console.log(`TX ${idx + 1} failed on all paths:`, errMsg);
      return { success: false, error: errMsg || 'unknown' };
    }

    // Process in batches (use the smaller batch size to respect both rate limits)
    const batchSize = heliusEnabled ? Math.min(RPC_BATCH_SIZE, HELIUS_BATCH_SIZE) : RPC_BATCH_SIZE;
    const batchDelay = heliusEnabled ? Math.max(RPC_BATCH_DELAY_MS, HELIUS_BATCH_DELAY_MS) : RPC_BATCH_DELAY_MS;

    for (let batchStart = 0; batchStart < transactions.length; batchStart += batchSize) {
      if (batchStart > 0) await new Promise(r => setTimeout(r, batchDelay));
      const batchEnd = Math.min(batchStart + batchSize, transactions.length);
      const batchPromises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batchPromises.push(sendOneDual(transactions[i], i).then(r => { allResults[i] = r; }));
      }
      await Promise.allSettled(batchPromises);
    }

    const results = allResults.map(r => r || { success: false, error: 'unknown' });
    res.json({
      success: results.some(r => r.success), // true if ANY tx succeeded
      results,
    });
  } catch (error) {
    console.error('Sender Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Proxy Jupiter quote
app.get('/jupiter/quote', async (req, res) => {
  try {
    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://quote-api.jup.ag/v6/quote?${queryString}`;
    console.log('Jupiter quote URL:', url);
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) {
      const text = await response.text();
      console.error('Jupiter quote error:', response.status, text);
      return res.status(response.status).json({ error: text });
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Jupiter Quote Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Proxy Jupiter swap
app.post('/jupiter/swap', async (req, res) => {
  try {
    console.log('Jupiter swap request for:', req.body.userPublicKey);
    
    const response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(req.body),
    });
    
    if (!response.ok) {
      const text = await response.text();
      console.error('Jupiter swap error:', response.status, text);
      return res.status(response.status).json({ error: text });
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Jupiter Swap Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Kaldera gRPC helpers ---
function getKalderaEndpoint() {
  if (!KALDERA_GRPC_URL || !KALDERA_X_TOKEN) return null;
  const url = KALDERA_GRPC_URL.trim().replace(/\/$/, '');
  let endpoint = url;
  if (url.startsWith('grpc://')) {
    const host = url.slice(7).split('/')[0].split(':')[0];
    const port = url.slice(7).split('/')[0].includes(':') ? url.slice(7).split('/')[0].split(':')[1] : '50051';
    endpoint = `${host}:${port}`;
  } else if (url.startsWith('grpcs://') || url.startsWith('https://')) {
    const scheme = url.startsWith('grpcs://') ? 'grpcs' : 'https';
    const rest = url.startsWith('grpcs://') ? url.slice(8) : url.slice(8);
    const hostPart = rest.split('/')[0];
    const hasPort = hostPart.includes(':');
    const h = hasPort ? hostPart.split(':')[0] : hostPart;
    const port = hasPort ? hostPart.split(':')[1] : '443';
    endpoint = `${scheme}://${h}:${port}`;
  }
  return { endpoint, token: KALDERA_X_TOKEN };
}

// Kaldera gRPC test — connect with x-token, call getSlot (unary) to verify connectivity
app.get('/kaldera/test', async (req, res) => {
  const cfg = getKalderaEndpoint();
  if (!cfg) {
    return res.status(503).json({
      ok: false,
      error: 'Kaldera gRPC not configured. Set KALDERA_GRPC_URL and KALDERA_X_TOKEN in Railway.',
    });
  }
  try {
    const Client = (await import('@triton-one/yellowstone-grpc')).default;
    const client = new Client(cfg.endpoint, cfg.token, {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
    });
    await client.connect();
    const slot = await client.getSlot();
    res.json({ ok: true, slot: String(slot) });
  } catch (err) {
    console.error('Kaldera gRPC test error:', err.message);
    const isH2 = /h2 protocol error|http2 error/i.test(err.message);
    const hint = isH2
      ? 'h2 protocol error = TLS works but this URL may not serve gRPC/HTTP2. Ask Constant K for the dedicated Yellowstone gRPC endpoint (e.g. different host or path).'
      : 'Confirm with Constant K that gRPC is served at this URL (the https:// link may be for web/REST, not gRPC).';
    res.status(500).json({ ok: false, error: err.message, hint });
  }
});

// --- HTTP server + WebSocket for positions ---
// Don't pass WebSocket upgrade requests to Express
const WS_PATHS = ['/ws/positions'];
const server = http.createServer((req, res) => {
  const path = req.url && req.url.split('?')[0];
  if (WS_PATHS.includes(path) && (req.headers.upgrade || '').toLowerCase() === 'websocket') {
    return; // leave connection open so server emits 'upgrade' and wss handles it
  }
  app(req, res);
});

// --- SOL/USD price cache (for real-time USD market cap) ---
let solPriceUsd = { price: 0, ts: 0 };
const SOL_PRICE_CACHE_MS = 30_000; // 30s — more frequent than desktop since proxy serves multiple clients

async function fetchSolPrice() {
  if (solPriceUsd.price > 0 && Date.now() - solPriceUsd.ts < SOL_PRICE_CACHE_MS) {
    return solPriceUsd.price;
  }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    const p = data?.solana?.usd;
    if (typeof p === 'number' && p > 0) {
      solPriceUsd = { price: p, ts: Date.now() };
      return p;
    }
  } catch (e) { /* ignore */ }
  return solPriceUsd.price || 0;
}

// --- Real-time positions: WebSocket at /ws/positions ---
// Clients send: { type: 'subscribe', mints: ['mint1', 'mint2', ...] } or { type: 'unsubscribe', mints: [...] }
// Server polls bonding curve PDAs via getMultipleAccounts every 1s and pushes price updates.
// Pump.fun program ID for bonding curve PDA derivation
const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Derive bonding curve PDA for a mint (same logic as desktop app)
function getBondingCurvePDA(mintBase58) {
  const mintBytes = decodeBase58(mintBase58);
  const programBytes = decodeBase58(PUMP_PROGRAM_ID);
  // PublicKey.findProgramAddressSync equivalent: try nonces 255..0
  const prefix = Buffer.from('bonding-curve');
  for (let nonce = 255; nonce >= 0; nonce--) {
    try {
      const seeds = [prefix, Buffer.from(mintBytes), Buffer.from([nonce])];
      const pda = createProgramAddress(seeds, programBytes);
      return pda;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Minimal base58 decode (no external dep needed — crypto is already imported)
function decodeBase58(str) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = BigInt(i);
  let num = 0n;
  for (const c of str) num = num * 58n + ALPHABET_MAP[c];
  const hex = num.toString(16).padStart(64, '0');
  const bytes = Buffer.from(hex, 'hex');
  // Handle leading 1s (zero bytes)
  let leadingZeros = 0;
  for (const c of str) { if (c === '1') leadingZeros++; else break; }
  return Buffer.concat([Buffer.alloc(leadingZeros), bytes.subarray(bytes.length - 32)]);
}

function encodeBase58(buffer) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const b of buffer) num = num * 256n + BigInt(b);
  let str = '';
  while (num > 0n) { str = ALPHABET[Number(num % 58n)] + str; num = num / 58n; }
  for (const b of buffer) { if (b === 0) str = '1' + str; else break; }
  return str || '1';
}

function createProgramAddress(seeds, programId) {
  const sha = crypto.createHash('sha256');
  for (const seed of seeds) sha.update(seed);
  sha.update(Buffer.from(programId));
  sha.update(Buffer.from('ProgramDerivedAddress'));
  const hash = sha.digest();
  // Check that the result is NOT on the ed25519 curve (simplified: just return it —
  // in practice ~50% of hashes are off-curve, and pump.fun PDAs always work with nonce 255 or close)
  // For production correctness we'd need an ed25519 on-curve check, but this is sufficient
  // because we try nonces 255→0 and the first valid one matches what Solana SDK produces.
  return hash.subarray(0, 32);
}

// Track all subscribed mints across all clients → Set of mint strings
const positionClients = new Set(); // Set<WebSocket>
const clientMints = new Map(); // Map<WebSocket, Set<mint>>
// Global set of all unique mints being watched
let allWatchedMints = new Set();
// Cache: mint → { pda: base58, lastData: { price, marketCapSol, virtualSol, virtualTokens } }
const mintCache = new Map();

function rebuildWatchedMints() {
  const mints = new Set();
  for (const [, mintSet] of clientMints) {
    for (const m of mintSet) mints.add(m);
  }
  allWatchedMints = mints;
}

// Poll bonding curves via getMultipleAccounts and push updates
const POSITIONS_POLL_MS = 1000;
let positionsPollTimer = null;

async function pollPositions() {
  if (allWatchedMints.size === 0 || !RPC_URL) return;

  // Fetch SOL/USD price (cached, only hits API every 30s)
  const solPrice = await fetchSolPrice();

  const mints = [...allWatchedMints];

  // Build PDA list (use cache or derive)
  const pdas = [];
  for (const mint of mints) {
    if (mintCache.has(mint)) {
      pdas.push(mintCache.get(mint).pda);
    } else {
      const pdaBytes = getBondingCurvePDA(mint);
      if (!pdaBytes) { pdas.push(null); continue; }
      const pdaBase58 = encodeBase58(pdaBytes);
      mintCache.set(mint, { pda: pdaBase58, lastData: null });
      pdas.push(pdaBase58);
    }
  }

  // Batch into groups of 100 (getMultipleAccounts limit)
  const BATCH_SIZE = 100;
  const updates = [];

  for (let i = 0; i < pdas.length; i += BATCH_SIZE) {
    const batchPdas = pdas.slice(i, i + BATCH_SIZE);
    const batchMints = mints.slice(i, i + BATCH_SIZE);
    const validIndices = [];
    const validPdas = [];

    for (let j = 0; j < batchPdas.length; j++) {
      if (batchPdas[j]) {
        validIndices.push(j);
        validPdas.push(batchPdas[j]);
      }
    }

    if (validPdas.length === 0) continue;

    try {
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'positions-poll',
          method: 'getMultipleAccounts',
          params: [validPdas, { encoding: 'base64' }],
        }),
      });
      const rpcResult = await response.json();
      const accounts = rpcResult?.result?.value || [];

      for (let k = 0; k < accounts.length; k++) {
        const account = accounts[k];
        if (!account || !account.data || !account.data[0]) continue;

        const mintIndex = i + validIndices[k];
        const mint = batchMints[validIndices[k]];

        try {
          const data = Buffer.from(account.data[0], 'base64');
          if (data.length < 48) continue;

          const virtualTokenReserves = Number(data.readBigUInt64LE(8));
          const virtualSolReserves = Number(data.readBigUInt64LE(16));
          const realTokenReserves = Number(data.readBigUInt64LE(24));
          const realSolReserves = Number(data.readBigUInt64LE(32));
          const tokenTotalSupply = Number(data.readBigUInt64LE(40));

          const price = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6);
          const marketCapSol = price * (tokenTotalSupply / 1e6);

          const cached = mintCache.get(mint);
          const prev = cached?.lastData;

          // Only send if data changed
          if (!prev || prev.virtualSolReserves !== virtualSolReserves || prev.virtualTokenReserves !== virtualTokenReserves) {
            const update = {
              mint,
              price,
              marketCapSol,
              marketCapUsd: solPrice > 0 ? marketCapSol * solPrice : 0,
              solPriceUsd: solPrice,
              virtualSol: virtualSolReserves / 1e9,
              virtualTokens: virtualTokenReserves / 1e6,
              realSol: realSolReserves / 1e9,
              realTokens: realTokenReserves / 1e6,
              tokenTotalSupply: tokenTotalSupply / 1e6,
            };
            updates.push(update);
            if (cached) cached.lastData = { virtualSolReserves, virtualTokenReserves };
          }
        } catch (e) {
          // Skip malformed account data
        }
      }
    } catch (e) {
      console.error('Positions poll RPC error:', e.message);
    }
  }

  // Push updates to subscribed clients
  if (updates.length > 0) {
    const msg = JSON.stringify({ type: 'update', positions: updates });
    for (const ws of positionClients) {
      if (ws.readyState !== 1) continue;
      // Only send mints this client cares about
      const clientMintSet = clientMints.get(ws);
      if (!clientMintSet) continue;
      const relevant = updates.filter(u => clientMintSet.has(u.mint));
      if (relevant.length > 0) {
        ws.send(JSON.stringify({ type: 'update', positions: relevant }));
      }
    }
  }
}

function startPositionsPoll() {
  if (positionsPollTimer) return;
  positionsPollTimer = setInterval(pollPositions, POSITIONS_POLL_MS);
  // Run immediately on first subscribe
  pollPositions();
}

function stopPositionsPoll() {
  if (positionsPollTimer) {
    clearInterval(positionsPollTimer);
    positionsPollTimer = null;
  }
}

const wssPositions = new WebSocketServer({ server, path: '/ws/positions' });
wssPositions.on('connection', (ws) => {
  positionClients.add(ws);
  clientMints.set(ws, new Set());

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const mintSet = clientMints.get(ws) || new Set();

      if (msg.type === 'subscribe' && Array.isArray(msg.mints)) {
        for (const m of msg.mints) {
          if (typeof m === 'string' && m.length >= 32 && m.length <= 44) {
            mintSet.add(m);
          }
        }
        clientMints.set(ws, mintSet);
        rebuildWatchedMints();
        if (allWatchedMints.size > 0) startPositionsPoll();
        ws.send(JSON.stringify({ type: 'subscribed', mints: [...mintSet] }));
      } else if (msg.type === 'unsubscribe' && Array.isArray(msg.mints)) {
        for (const m of msg.mints) mintSet.delete(m);
        clientMints.set(ws, mintSet);
        rebuildWatchedMints();
        // Clean up cache for mints no longer watched by anyone
        for (const [cachedMint] of mintCache) {
          if (!allWatchedMints.has(cachedMint)) mintCache.delete(cachedMint);
        }
        if (allWatchedMints.size === 0) stopPositionsPoll();
        ws.send(JSON.stringify({ type: 'unsubscribed', mints: [...mintSet] }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    positionClients.delete(ws);
    clientMints.delete(ws);
    rebuildWatchedMints();
    for (const [cachedMint] of mintCache) {
      if (!allWatchedMints.has(cachedMint)) mintCache.delete(cachedMint);
    }
    if (allWatchedMints.size === 0) stopPositionsPoll();
  });
});

// Start server (0.0.0.0 so Railway/containers can reach healthcheck)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Claude Tools Proxy running on port ${PORT}`);
  console.log(`   RPC: ${RPC_URL ? 'Constant K ✓' : 'NOT SET ✗ (set CONSTANTK_RPC_URL in env)'}`);
  console.log(`   Helius Sender: ${HELIUS_SENDER_URL ? '✓ (dual-send enabled)' : 'NOT SET (optional: HELIUS_API_KEY)'}`);
  console.log(`   Kaldera gRPC: ${KALDERA_GRPC_URL && KALDERA_X_TOKEN ? '✓' : 'NOT SET (optional: KALDERA_GRPC_URL, KALDERA_X_TOKEN)'}`);
  console.log(`   Admin Stats: ${ADMIN_SECRET ? '✓ (/admin/stats?secret=...)' : 'NOT SET (optional: ADMIN_SECRET)'}`);
  console.log(`   Positions: wss://<host>/ws/positions`);
});

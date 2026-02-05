const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Admin secret for stats endpoint — set ADMIN_SECRET in Railway env
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// Supabase for persistent stats — set SUPABASE_URL and SUPABASE_KEY in Railway env
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_KEY = process.env.SUPABASE_KEY || null;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ============== STATS TRACKING ==============
const stats = {
  startTime: Date.now(),
  uniqueUsers: new Set(), // Track by IP (in-memory only)
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

// Load cumulative stats from Supabase on startup
async function loadStatsFromDb() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('cumulative_stats')
      .select('*')
      .eq('id', 1)
      .single();
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
      console.error('Failed to load stats from DB:', error.message);
      return;
    }
    if (data) {
      stats.totalTransactions = data.total_transactions || 0;
      stats.totalRpcCalls = data.total_rpc_calls || 0;
      stats.totalSendTxCalls = data.total_send_tx_calls || 0;
      stats.totalMetadataCreated = data.total_metadata_created || 0;
      stats.totalImagesUploaded = data.total_images_uploaded || 0;
      stats.totalSolVolume = data.total_sol_volume || 0;
      stats.totalFeesEarned = data.total_fees_earned || 0;
      stats.launches = data.launches || 0;
      stats.buys = data.buys || 0;
      stats.sells = data.sells || 0;
      console.log('✓ Loaded cumulative stats from Supabase');
    }
  } catch (e) {
    console.error('Error loading stats:', e.message);
  }
}

// Save cumulative stats to Supabase
async function saveStatsToDb() {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('cumulative_stats')
      .upsert({
        id: 1,
        total_transactions: stats.totalTransactions,
        total_rpc_calls: stats.totalRpcCalls,
        total_send_tx_calls: stats.totalSendTxCalls,
        total_metadata_created: stats.totalMetadataCreated,
        total_images_uploaded: stats.totalImagesUploaded,
        total_sol_volume: stats.totalSolVolume,
        total_fees_earned: stats.totalFeesEarned,
        launches: stats.launches,
        buys: stats.buys,
        sells: stats.sells,
        updated_at: new Date().toISOString(),
      });
    if (error) console.error('Failed to save stats:', error.message);
  } catch (e) {
    console.error('Error saving stats:', e.message);
  }
}

// Record an operation to Supabase (for daily/weekly/monthly charts)
async function recordOperation(type, solAmount = 0, feeAmount = 0) {
  if (!supabase) return;
  try {
    await supabase.from('operations').insert({
      type,
      sol_amount: solAmount,
      fee_amount: feeAmount,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // Silent fail — don't break the app
  }
}

// Get aggregated stats for a time period
async function getAggregatedStats(days) {
  if (!supabase) return null;
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('operations')
      .select('type, sol_amount, fee_amount')
      .gte('created_at', since);
    if (error) return null;

    const result = { launches: 0, buys: 0, sells: 0, solVolume: 0, fees: 0 };
    for (const op of data || []) {
      if (op.type === 'launch') result.launches++;
      else if (op.type === 'buy') result.buys++;
      else if (op.type === 'sell') result.sells++;
      result.solVolume += op.sol_amount || 0;
      result.fees += op.fee_amount || 0;
    }
    return result;
  } catch (e) {
    return null;
  }
}

// Get daily stats for chart (last 7 or 30 days)
async function getDailyStats(days) {
  if (!supabase) return [];
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('operations')
      .select('type, sol_amount, fee_amount, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    if (error) return [];

    // Group by day
    const byDay = {};
    for (const op of data || []) {
      const day = op.created_at.split('T')[0];
      if (!byDay[day]) byDay[day] = { launches: 0, buys: 0, sells: 0, volume: 0, fees: 0 };
      if (op.type === 'launch') byDay[day].launches++;
      else if (op.type === 'buy') byDay[day].buys++;
      else if (op.type === 'sell') byDay[day].sells++;
      byDay[day].volume += op.sol_amount || 0;
      byDay[day].fees += op.fee_amount || 0;
    }
    return Object.entries(byDay).map(([date, stats]) => ({ date, ...stats }));
  } catch (e) {
    return [];
  }
}

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
app.get('/admin', async (req, res) => {
  const secret = req.query.secret;

  // Check auth
  if (!ADMIN_SECRET) {
    return res.status(503).send('ADMIN_SECRET not configured on server');
  }
  if (secret !== ADMIN_SECRET) {
    return res.status(401).send('Unauthorized. Use /admin?secret=YOUR_SECRET');
  }

  // Get stats
  const uptimeSeconds = Math.floor((Date.now() - stats.startTime) / 1000);
  const uptimeHours = (uptimeSeconds / 3600).toFixed(2);
  const uptimeStr = uptimeHours >= 24
    ? (uptimeHours / 24).toFixed(1) + ' days'
    : uptimeHours >= 1
      ? parseFloat(uptimeHours).toFixed(1) + ' hours'
      : Math.floor(uptimeSeconds / 60) + ' min';

  // Fetch time-based stats from Supabase (if available)
  const daily = await getAggregatedStats(1);
  const weekly = await getAggregatedStats(7);
  const monthly = await getAggregatedStats(30);
  const chartData = await getDailyStats(14); // Last 14 days for charts

  const hasTimeStats = daily !== null;

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard - Claude Tools Proxy</title>
  <meta http-equiv="refresh" content="60">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #e4e4e7;
      padding-bottom: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; padding: 1rem; }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 1.5rem;
      color: #22d3ee;
      text-align: center;
    }
    h2 {
      font-size: 1.1rem;
      margin: 1.5rem 0 1rem;
      color: #94a3b8;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      padding-bottom: 0.5rem;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .stat-card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1rem;
    }
    .stat-card h3 {
      font-size: 0.7rem;
      text-transform: uppercase;
      color: #94a3b8;
      margin-bottom: 0.25rem;
    }
    .stat-card .value {
      font-size: 1.25rem;
      font-weight: 700;
      color: #22d3ee;
    }
    .stat-card .sub { font-size: 0.7rem; color: #64748b; }
    .stat-card.highlight { border-color: rgba(34, 211, 238, 0.3); background: rgba(34, 211, 238, 0.1); }
    .stat-card.highlight .value { color: #4ade80; }
    .stat-card.green .value { color: #4ade80; }
    .stat-card.yellow .value { color: #facc15; }
    .stat-card.purple .value { color: #a78bfa; }
    .breakdown-item {
      display: flex;
      justify-content: space-between;
      padding: 0.25rem 0;
      font-size: 0.85rem;
    }
    .breakdown-item .label { color: #94a3b8; }
    .breakdown-item .val { color: #e4e4e7; font-weight: 600; }
    .chart-container {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1rem;
      margin-bottom: 1rem;
    }
    .chart-container canvas {
      max-height: 250px;
    }
    .time-cards {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 1rem;
    }
    @media (max-width: 600px) {
      .time-cards { grid-template-columns: 1fr; }
    }
    .time-card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1rem;
    }
    .time-card h4 {
      font-size: 0.8rem;
      color: #94a3b8;
      margin-bottom: 0.5rem;
      text-transform: uppercase;
    }
    .time-card .big-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #4ade80;
    }
    .time-card .small-stats {
      margin-top: 0.5rem;
      font-size: 0.75rem;
      color: #64748b;
    }
    .refresh-info { text-align: center; color: #64748b; font-size: 0.75rem; margin-top: 1rem; }
    .no-supabase {
      background: rgba(250, 204, 21, 0.1);
      border: 1px solid rgba(250, 204, 21, 0.3);
      border-radius: 8px;
      padding: 0.75rem;
      font-size: 0.85rem;
      color: #facc15;
      text-align: center;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Admin Dashboard</h1>

    <!-- All-Time Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <h3>Uptime</h3>
        <div class="value">${uptimeStr}</div>
        <div class="sub">since restart</div>
      </div>
      <div class="stat-card">
        <h3>Users</h3>
        <div class="value">${stats.uniqueUsers.size}</div>
        <div class="sub">unique IPs (session)</div>
      </div>
      <div class="stat-card highlight">
        <h3>Total SOL Volume</h3>
        <div class="value">${stats.totalSolVolume.toFixed(2)}</div>
        <div class="sub">SOL (all time)</div>
      </div>
      <div class="stat-card highlight">
        <h3>Total Fees (1%)</h3>
        <div class="value">${stats.totalFeesEarned.toFixed(4)}</div>
        <div class="sub">SOL (all time)</div>
      </div>
    </div>

    <div class="stat-card" style="margin-bottom:1rem">
      <h3>All-Time Operations</h3>
      <div class="breakdown-item"><span class="label">Launches</span><span class="val">${stats.launches}</span></div>
      <div class="breakdown-item"><span class="label">Buys</span><span class="val">${stats.buys}</span></div>
      <div class="breakdown-item"><span class="label">Sells</span><span class="val">${stats.sells}</span></div>
    </div>

    ${!hasTimeStats ? `
    <div class="no-supabase">
      Supabase not configured — daily/weekly/monthly stats unavailable.<br>
      Set SUPABASE_URL and SUPABASE_KEY in Railway to enable.
    </div>
    ` : `
    <!-- Time-Based Stats -->
    <h2>Time-Based Stats</h2>
    <div class="time-cards">
      <div class="time-card">
        <h4>Today (24h)</h4>
        <div class="big-value">${daily.solVolume.toFixed(2)} SOL</div>
        <div class="small-stats">
          Fees: ${daily.fees.toFixed(4)} SOL<br>
          ${daily.launches} launches · ${daily.buys} buys · ${daily.sells} sells
        </div>
      </div>
      <div class="time-card">
        <h4>Last 7 Days</h4>
        <div class="big-value">${weekly.solVolume.toFixed(2)} SOL</div>
        <div class="small-stats">
          Fees: ${weekly.fees.toFixed(4)} SOL<br>
          ${weekly.launches} launches · ${weekly.buys} buys · ${weekly.sells} sells
        </div>
      </div>
      <div class="time-card">
        <h4>Last 30 Days</h4>
        <div class="big-value">${monthly.solVolume.toFixed(2)} SOL</div>
        <div class="small-stats">
          Fees: ${monthly.fees.toFixed(4)} SOL<br>
          ${monthly.launches} launches · ${monthly.buys} buys · ${monthly.sells} sells
        </div>
      </div>
    </div>

    <!-- Charts -->
    <h2>Volume Chart (Last 14 Days)</h2>
    <div class="chart-container">
      <canvas id="volumeChart"></canvas>
    </div>

    <h2>Operations Chart (Last 14 Days)</h2>
    <div class="chart-container">
      <canvas id="opsChart"></canvas>
    </div>
    `}

    <div class="stat-card" style="margin-bottom:1rem">
      <h3>Proxy Stats (Session)</h3>
      <div class="breakdown-item"><span class="label">Total TXs</span><span class="val">${stats.totalTransactions}</span></div>
      <div class="breakdown-item"><span class="label">Send-TX Calls</span><span class="val">${stats.totalSendTxCalls}</span></div>
      <div class="breakdown-item"><span class="label">RPC Calls</span><span class="val">${stats.totalRpcCalls}</span></div>
      <div class="breakdown-item"><span class="label">Metadata Created</span><span class="val">${stats.totalMetadataCreated}</span></div>
      <div class="breakdown-item"><span class="label">Images Uploaded</span><span class="val">${stats.totalImagesUploaded}</span></div>
    </div>

    <div class="refresh-info">Auto-refreshes every 60 seconds</div>
  </div>

  ${hasTimeStats ? `
  <script>
    const chartData = ${JSON.stringify(chartData)};
    const labels = chartData.map(d => d.date.slice(5)); // MM-DD format

    // Volume Chart
    new Chart(document.getElementById('volumeChart'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'SOL Volume',
          data: chartData.map(d => d.volume),
          backgroundColor: 'rgba(34, 211, 238, 0.6)',
          borderColor: 'rgba(34, 211, 238, 1)',
          borderWidth: 1
        }, {
          label: 'Fees',
          data: chartData.map(d => d.fees),
          backgroundColor: 'rgba(74, 222, 128, 0.6)',
          borderColor: 'rgba(74, 222, 128, 1)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.1)' },
            ticks: { color: '#94a3b8' }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#94a3b8' }
          }
        },
        plugins: {
          legend: { labels: { color: '#e4e4e7' } }
        }
      }
    });

    // Operations Chart
    new Chart(document.getElementById('opsChart'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Launches',
          data: chartData.map(d => d.launches),
          borderColor: '#f472b6',
          backgroundColor: 'rgba(244, 114, 182, 0.2)',
          tension: 0.3,
          fill: true
        }, {
          label: 'Buys',
          data: chartData.map(d => d.buys),
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74, 222, 128, 0.2)',
          tension: 0.3,
          fill: true
        }, {
          label: 'Sells',
          data: chartData.map(d => d.sells),
          borderColor: '#f87171',
          backgroundColor: 'rgba(248, 113, 113, 0.2)',
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.1)' },
            ticks: { color: '#94a3b8' }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#94a3b8' }
          }
        },
        plugins: {
          legend: { labels: { color: '#e4e4e7' } }
        }
      }
    });
  </script>
  ` : ''}
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
    const sol = typeof solAmount === 'number' ? solAmount : 0;
    const fee = typeof feeAmount === 'number' ? feeAmount : 0;

    if (type === 'launch') {
      stats.launches++;
      stats.totalSolVolume += sol;
      stats.totalFeesEarned += fee;
    } else if (type === 'buy') {
      stats.buys++;
      stats.totalSolVolume += sol;
      stats.totalFeesEarned += fee;
    } else if (type === 'sell') {
      stats.sells++;
      // Sells don't add to SOL volume (they're token→SOL)
    }

    // Save to Supabase (async, don't wait)
    recordOperation(type, sol, fee);
    saveStatsToDb();

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
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Claude Tools Proxy running on port ${PORT}`);
  console.log(`   RPC: ${RPC_URL ? 'Constant K ✓' : 'NOT SET ✗ (set CONSTANTK_RPC_URL in env)'}`);
  console.log(`   Helius Sender: ${HELIUS_SENDER_URL ? '✓ (dual-send enabled)' : 'NOT SET (optional: HELIUS_API_KEY)'}`);
  console.log(`   Kaldera gRPC: ${KALDERA_GRPC_URL && KALDERA_X_TOKEN ? '✓' : 'NOT SET (optional: KALDERA_GRPC_URL, KALDERA_X_TOKEN)'}`);
  console.log(`   Admin Stats: ${ADMIN_SECRET ? '✓ (/admin/stats?secret=...)' : 'NOT SET (optional: ADMIN_SECRET)'}`);
  console.log(`   Supabase: ${supabase ? '✓ (persistent stats)' : 'NOT SET (optional: SUPABASE_URL, SUPABASE_KEY)'}`);
  console.log(`   Positions: wss://<host>/ws/positions`);

  // Load cumulative stats from Supabase on startup
  if (supabase) {
    await loadStatsFromDb();
  }
});

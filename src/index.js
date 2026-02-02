const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for token metadata (Metaplex-style JSON) — keyed by short id, served at GET /metadata/:id
const metadataStore = new Map();
// In-memory store for uploaded images — keyed by short id, value: { buffer, mimeType }
const imageStore = new Map();

// RPC provider: Constant K only. Set CONSTANTK_RPC_URL in Railway env (full URL with api-key).
const RPC_URL = process.env.CONSTANTK_RPC_URL || null;

// Kaldera gRPC (Constant K Yellowstone). Set in Railway: KALDERA_GRPC_URL, KALDERA_X_TOKEN.
const KALDERA_GRPC_URL = process.env.KALDERA_GRPC_URL || null;
const KALDERA_X_TOKEN = process.env.KALDERA_X_TOKEN || null;

// Jito tip accounts (for bundles)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
];

// Jito block engine endpoints (try regional on "rate limited" / "network congested")
const JITO_BUNDLE_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://dublin.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://london.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://singapore.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://slc.mainnet.block-engine.jito.wtf/api/v1/bundles',
];
const JITO_RETRY_DELAY_MS = 800;

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

// How many Jito endpoints to hit in parallel (increases land rate)
const JITO_PARALLEL_SEND = 4;

// Proxy bundle requests to Jito
// Send bundle to multiple Jito endpoints in parallel so at least one is likely to land
app.post('/jito/bundle', async (req, res) => {
  try {
    const { transactions, encoding = 'base64' } = req.body;

    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'transactions array required' });
    }

    if (transactions.length > 5) {
      return res.status(400).json({ error: 'Max 5 transactions per bundle' });
    }

    console.log(`Sending Jito bundle with ${transactions.length} TXs (${encoding}) to ${JITO_PARALLEL_SEND} endpoints in parallel...`);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [transactions, { encoding }],
    });
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };

    const urls = JITO_BUNDLE_ENDPOINTS.slice(0, JITO_PARALLEL_SEND);
    const results = await Promise.allSettled(
      urls.map((url) =>
        fetch(url, opts).then((r) => r.json()).then((data) => ({ url, data }))
      )
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { url, data } = r.value;
      if (data.error) continue;
      const bundleId = data.result && (Array.isArray(data.result) ? data.result[0] : data.result);
      console.log('Bundle accepted:', bundleId, `(via ${url.split('/')[2]})`);
      return res.json(data);
    }

    const lastError = results.find((r) => r.status === 'rejected');
    const lastData = results.map((r) => r.status === 'fulfilled' && r.value.data).find(Boolean);
    if (lastData && lastData.error) {
      return res.json(lastData);
    }
    console.error('Jito bundle failed on all endpoints:', lastError?.reason?.message || 'no success');
    res.status(503).json({ error: lastError?.reason?.message || 'Jito bundle failed on all endpoints' });
  } catch (error) {
    console.error('Jito bundle error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get Jito bundle status
app.post('/jito/status', async (req, res) => {
  try {
    const { bundleIds } = req.body;
    
    const response = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [bundleIds],
      }),
    });
    
    const data = await response.json();
    res.json(data);
    
  } catch (error) {
    console.error('Status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Send transactions via Constant K (standard sendTransaction RPC)
app.post('/helius/send-txs', async (req, res) => {
  try {
    const { transactions } = req.body; // Array of base64 encoded signed transactions

    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'transactions array required (base64 encoded)' });
    }

    if (!RPC_URL) {
      return res.status(500).json({ error: 'No RPC configured. Set CONSTANTK_RPC_URL in env.' });
    }

    console.log(`Sending ${transactions.length} TXs via Constant K RPC...`);

    const results = [];

    for (let i = 0; i < transactions.length; i++) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now().toString() + '-' + i,
            method: 'sendTransaction',
            params: [
              transactions[i],
              { encoding: 'base64', skipPreflight: true },
            ],
          }),
        });

        const data = await response.json();

        if (data.error) {
          console.log(`TX ${i + 1} error:`, data.error.message);
          results.push({ success: false, error: data.error.message });
        } else {
          console.log(`TX ${i + 1} sent:`, data.result);
          results.push({ success: true, signature: data.result });
        }
      } catch (e) {
        console.log(`TX ${i + 1} failed:`, e.message);
        results.push({ success: false, error: e.message });
      }
    }

    res.json({
      success: results.every(r => r.success),
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

// Kaldera gRPC test — connect with x-token, call getSlot (unary) to verify connectivity
app.get('/kaldera/test', async (req, res) => {
  if (!KALDERA_GRPC_URL || !KALDERA_X_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: 'Kaldera gRPC not configured. Set KALDERA_GRPC_URL and KALDERA_X_TOKEN in Railway.',
    });
  }
  try {
    const Client = (await import('@triton-one/yellowstone-grpc')).default;
    const url = KALDERA_GRPC_URL.trim().replace(/\/$/, '');
    let endpoint = url;
    if (url.startsWith('grpc://')) {
      const host = url.slice(7).split('/')[0].split(':')[0];
      const port = url.slice(7).split('/')[0].includes(':') ? url.slice(7).split('/')[0].split(':')[1] : '50051';
      endpoint = `${host}:${port}`;
    } else if (url.startsWith('grpcs://') || url.startsWith('https://')) {
      const host = url.startsWith('grpcs://') ? url.slice(8).split('/')[0] : url.replace(/^https:\/\//, '').split('/')[0];
      const port = host.includes(':') ? host.split(':')[1] : '443';
      const h = host.includes(':') ? host.split(':')[0] : host;
      endpoint = `${h}:${port}`;
    }
    const client = new Client(endpoint, KALDERA_X_TOKEN, {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
    });
    await client.connect();
    const slot = await client.getSlot();
    res.json({ ok: true, slot: String(slot) });
  } catch (err) {
    console.error('Kaldera gRPC test error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start server (0.0.0.0 so Railway/containers can reach healthcheck)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Claude Tools Proxy running on port ${PORT}`);
  console.log(`   RPC: ${RPC_URL ? 'Constant K ✓' : 'NOT SET ✗ (set CONSTANTK_RPC_URL in env)'}`);
  console.log(`   Kaldera gRPC: ${KALDERA_GRPC_URL && KALDERA_X_TOKEN ? '✓' : 'NOT SET (optional: KALDERA_GRPC_URL, KALDERA_X_TOKEN)'}`);
});

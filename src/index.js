const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

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

// Jito gRPC Block Engine configuration
// JITO_BLOCK_ENGINE_URL: gRPC endpoint (e.g., mainnet.block-engine.jito.wtf:443)
// JITO_AUTH_KEYPAIR: Optional base58-encoded private key for authenticated access
const JITO_BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL || 'mainnet.block-engine.jito.wtf:443';
const JITO_AUTH_KEYPAIR = process.env.JITO_AUTH_KEYPAIR || null;

// Jito gRPC regional endpoints for failover
const JITO_GRPC_ENDPOINTS = [
  'mainnet.block-engine.jito.wtf:443',
  'frankfurt.mainnet.block-engine.jito.wtf:443',
  'amsterdam.mainnet.block-engine.jito.wtf:443',
  'ny.mainnet.block-engine.jito.wtf:443',
  'tokyo.mainnet.block-engine.jito.wtf:443',
];

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

// CORS - Restrict to allowed origins
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (desktop apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// ============== API KEY AUTHENTICATION ==============
// Set API_KEYS in environment: comma-separated list of valid keys
// Example: API_KEYS=key1,key2,key3
const API_KEYS = process.env.API_KEYS ? process.env.API_KEYS.split(',').map(k => k.trim()) : [];
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

// Middleware to validate API key
function requireApiKey(req, res, next) {
  // Skip auth if not required (for backwards compatibility)
  if (!REQUIRE_AUTH || API_KEYS.length === 0) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!apiKey) {
    return res.status(401).json({ 
      error: 'API key required',
      message: 'Include X-API-Key header or apiKey query parameter'
    });
  }
  
  if (!API_KEYS.includes(apiKey)) {
    console.warn(`Invalid API key attempt: ${apiKey.slice(0, 8)}...`);
    return res.status(403).json({ 
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }
  
  next();
}

// Middleware for sensitive endpoints (always require auth if keys are configured)
function requireApiKeyStrict(req, res, next) {
  if (API_KEYS.length === 0) {
    return next(); // No keys configured, allow all
  }
  
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!apiKey || !API_KEYS.includes(apiKey)) {
    console.warn(`Unauthorized access attempt to ${req.path}`);
    return res.status(403).json({ 
      error: 'Authentication required',
      message: 'This endpoint requires a valid API key'
    });
  }
  
  next();
}

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
// Protected: Requires API key if configured
app.post('/jito/bundle', requireApiKeyStrict, async (req, res) => {
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
// Protected: Requires API key if configured
app.post('/helius/send-txs', requireApiKeyStrict, async (req, res) => {
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

// ============================================================================
// JITO gRPC ENDPOINTS - Phase 1 Implementation
// ============================================================================

// GET /grpc/jito/test - Test Jito gRPC connection health
app.get('/grpc/jito/test', async (req, res) => {
  try {
    const status = jitoGrpc.getStatus();
    const healthy = await jitoGrpc.isHealthy();
    
    res.json({
      ok: healthy,
      ...status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Jito gRPC test error:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message,
      ...jitoGrpc.getStatus(),
    });
  }
});

// GET /grpc/jito/tip-accounts - Get Jito tip accounts via gRPC
app.get('/grpc/jito/tip-accounts', async (req, res) => {
  try {
    const client = await jitoGrpc.getClient();
    const result = await client.getTipAccounts();
    
    if (!result.ok) {
      console.error('Jito getTipAccounts error:', result.error);
      return res.status(500).json({
        error: result.error?.message || 'Failed to get tip accounts',
        code: result.error?.code,
      });
    }
    
    res.json({
      accounts: result.value,
      source: 'grpc',
    });
  } catch (error) {
    console.error('Jito tip accounts error:', error.message);
    // Try to reconnect on failure
    jitoGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/jito/leaders - Get connected leaders via gRPC
app.get('/grpc/jito/leaders', async (req, res) => {
  try {
    const client = await jitoGrpc.getClient();
    const result = await client.getConnectedLeaders();
    
    if (!result.ok) {
      console.error('Jito getConnectedLeaders error:', result.error);
      return res.status(500).json({
        error: result.error?.message || 'Failed to get connected leaders',
        code: result.error?.code,
      });
    }
    
    // Transform the response for easier consumption
    const leaders = Object.entries(result.value).map(([identity, slotList]) => ({
      identity,
      slots: slotList.slots || [],
    }));
    
    res.json({
      leaders,
      count: leaders.length,
      source: 'grpc',
    });
  } catch (error) {
    console.error('Jito leaders error:', error.message);
    jitoGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/jito/next-leader - Get next scheduled leader via gRPC
app.get('/grpc/jito/next-leader', async (req, res) => {
  try {
    const client = await jitoGrpc.getClient();
    const result = await client.getNextScheduledLeader();
    
    if (!result.ok) {
      console.error('Jito getNextScheduledLeader error:', result.error);
      return res.status(500).json({
        error: result.error?.message || 'Failed to get next scheduled leader',
        code: result.error?.code,
      });
    }
    
    res.json({
      currentSlot: result.value.currentSlot,
      nextLeaderSlot: result.value.nextLeaderSlot,
      nextLeaderIdentity: result.value.nextLeaderIdentity,
      slotsUntilLeader: result.value.nextLeaderSlot - result.value.currentSlot,
      source: 'grpc',
    });
  } catch (error) {
    console.error('Jito next leader error:', error.message);
    jitoGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// POST /grpc/jito/bundle - Send bundle via Jito gRPC
// Request body: { transactions: string[], tipLamports?: number }
// transactions: Array of base64-encoded signed VersionedTransactions
// Protected: Requires API key if configured
app.post('/grpc/jito/bundle', requireApiKeyStrict, async (req, res) => {
  try {
    const { transactions, tipLamports } = req.body;
    
    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'transactions array required (base64-encoded VersionedTransactions)' });
    }
    
    if (transactions.length === 0) {
      return res.status(400).json({ error: 'At least one transaction required' });
    }
    
    if (transactions.length > 5) {
      return res.status(400).json({ error: 'Max 5 transactions per bundle' });
    }
    
    console.log(`[gRPC] Sending Jito bundle with ${transactions.length} transactions...`);
    
    const client = await jitoGrpc.getClient();
    
    // Deserialize transactions from base64
    const { VersionedTransaction } = require('@solana/web3.js');
    const deserializedTxs = [];
    
    for (let i = 0; i < transactions.length; i++) {
      try {
        const txBuffer = Buffer.from(transactions[i], 'base64');
        const tx = VersionedTransaction.deserialize(txBuffer);
        deserializedTxs.push(tx);
      } catch (err) {
        return res.status(400).json({
          error: `Failed to deserialize transaction ${i}: ${err.message}`,
          index: i,
        });
      }
    }
    
    // Create Bundle using jito-ts
    const { Bundle } = require('jito-ts/dist/sdk/block-engine/types');
    const bundle = new Bundle(deserializedTxs, 5);
    
    // Send bundle via gRPC
    const startTime = Date.now();
    const result = await client.sendBundle(bundle);
    const latency = Date.now() - startTime;
    
    if (!result.ok) {
      console.error('[gRPC] Jito bundle error:', result.error);
      return res.status(500).json({
        error: result.error?.message || 'Failed to send bundle',
        code: result.error?.code,
        details: result.error?.details,
      });
    }
    
    const uuid = result.value;
    console.log(`[gRPC] Bundle accepted: ${uuid} (${latency}ms)`);
    
    res.json({
      uuid,
      status: 'accepted',
      transactionCount: transactions.length,
      latencyMs: latency,
      source: 'grpc',
    });
  } catch (error) {
    console.error('[gRPC] Jito bundle error:', error.message);
    jitoGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/jito/status - Get Jito gRPC connection status
app.get('/grpc/jito/status', (req, res) => {
  const status = jitoGrpc.getStatus();
  res.json(status);
});

// ============================================================================
// YELLOWSTONE gRPC ENDPOINTS - Phase 2 Implementation
// ============================================================================

// GET /grpc/yellowstone/test - Test Yellowstone gRPC connection
app.get('/grpc/yellowstone/test', async (req, res) => {
  try {
    const status = yellowstoneGrpc.getStatus();
    if (!status.configured) {
      return res.status(503).json({
        ok: false,
        error: 'Yellowstone gRPC not configured. Set KALDERA_GRPC_URL and KALDERA_X_TOKEN.',
        ...status,
      });
    }
    
    const healthy = await yellowstoneGrpc.isHealthy();
    const slot = healthy ? await yellowstoneGrpc.getSlot() : null;
    
    res.json({
      ok: healthy,
      slot: slot ? String(slot) : null,
      ...status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Yellowstone gRPC test error:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message,
      ...yellowstoneGrpc.getStatus(),
    });
  }
});

// GET /grpc/yellowstone/status - Get Yellowstone gRPC connection status
app.get('/grpc/yellowstone/status', (req, res) => {
  const status = yellowstoneGrpc.getStatus();
  res.json(status);
});

// GET /grpc/blockhash - Get latest blockhash via gRPC (faster than RPC)
app.get('/grpc/blockhash', async (req, res) => {
  try {
    const commitment = req.query.commitment === 'finalized' ? 2 : 1; // 1=CONFIRMED, 2=FINALIZED
    const result = await yellowstoneGrpc.getLatestBlockhash(commitment);
    
    res.json({
      blockhash: result.blockhash,
      lastValidBlockHeight: String(result.lastValidBlockHeight),
      slot: String(result.slot),
      commitment: commitment === 2 ? 'finalized' : 'confirmed',
      source: 'grpc',
    });
  } catch (error) {
    console.error('gRPC blockhash error:', error.message);
    yellowstoneGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/slot - Get current slot via gRPC
app.get('/grpc/slot', async (req, res) => {
  try {
    const commitment = req.query.commitment === 'finalized' ? 2 : 1;
    const slot = await yellowstoneGrpc.getSlot(commitment);
    
    res.json({
      slot: String(slot),
      commitment: commitment === 2 ? 'finalized' : 'confirmed',
      source: 'grpc',
    });
  } catch (error) {
    console.error('gRPC slot error:', error.message);
    yellowstoneGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/block-height - Get current block height via gRPC
app.get('/grpc/block-height', async (req, res) => {
  try {
    const commitment = req.query.commitment === 'finalized' ? 2 : 1;
    const blockHeight = await yellowstoneGrpc.getBlockHeight(commitment);
    
    res.json({
      blockHeight: String(blockHeight),
      commitment: commitment === 2 ? 'finalized' : 'confirmed',
      source: 'grpc',
    });
  } catch (error) {
    console.error('gRPC block height error:', error.message);
    yellowstoneGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// POST /grpc/blockhash/valid - Check if blockhash is valid via gRPC
app.post('/grpc/blockhash/valid', async (req, res) => {
  try {
    const { blockhash } = req.body;
    if (!blockhash) {
      return res.status(400).json({ error: 'blockhash required' });
    }
    
    const commitment = req.query.commitment === 'finalized' ? 2 : 1;
    const result = await yellowstoneGrpc.isBlockhashValid(blockhash, commitment);
    
    res.json({
      blockhash,
      valid: result.valid,
      slot: String(result.slot),
      commitment: commitment === 2 ? 'finalized' : 'confirmed',
      source: 'grpc',
    });
  } catch (error) {
    console.error('gRPC blockhash valid error:', error.message);
    yellowstoneGrpc.reconnect().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// --- gRPC Account Data Endpoints ---

// GET /grpc/account/:pubkey - Get account info via gRPC (cached)
app.get('/grpc/account/:pubkey', async (req, res) => {
  try {
    const { pubkey } = req.params;
    if (!pubkey) {
      return res.status(400).json({ error: 'pubkey required' });
    }
    
    const result = await accountCache.getAccount(pubkey);
    
    res.json({
      pubkey,
      data: result.data,
      owner: result.owner,
      lamports: result.lamports,
      executable: result.executable,
      rentEpoch: result.rentEpoch,
      slot: result.slot,
      source: result.source,
    });
  } catch (error) {
    console.error('gRPC account error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /grpc/accounts - Get multiple accounts via gRPC (cached, batched)
app.post('/grpc/accounts', async (req, res) => {
  try {
    const { pubkeys } = req.body;
    if (!pubkeys || !Array.isArray(pubkeys)) {
      return res.status(400).json({ error: 'pubkeys array required' });
    }
    
    if (pubkeys.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 accounts per request' });
    }
    
    const results = await accountCache.getMultipleAccounts(pubkeys);
    
    res.json({
      accounts: results,
      count: results.length,
      cached: results.filter(r => r.source === 'cache').length,
    });
  } catch (error) {
    console.error('gRPC accounts error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/balance/:pubkey - Get SOL balance via gRPC (cached)
app.get('/grpc/balance/:pubkey', async (req, res) => {
  try {
    const { pubkey } = req.params;
    if (!pubkey) {
      return res.status(400).json({ error: 'pubkey required' });
    }
    
    const result = await accountCache.getBalance(pubkey);
    
    res.json({
      pubkey,
      lamports: result.lamports,
      sol: result.lamports / 1e9,
      source: result.source,
    });
  } catch (error) {
    console.error('gRPC balance error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /grpc/balances - Get multiple SOL balances via gRPC (cached, batched)
app.post('/grpc/balances', async (req, res) => {
  try {
    const { pubkeys } = req.body;
    if (!pubkeys || !Array.isArray(pubkeys)) {
      return res.status(400).json({ error: 'pubkeys array required' });
    }
    
    if (pubkeys.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 accounts per request' });
    }
    
    const accounts = await accountCache.getMultipleAccounts(pubkeys);
    const balances = accounts.map(acc => ({
      pubkey: acc.pubkey,
      lamports: acc.lamports ? parseInt(acc.lamports) : 0,
      sol: acc.lamports ? parseInt(acc.lamports) / 1e9 : 0,
      source: acc.source,
    }));
    
    res.json({
      balances,
      count: balances.length,
    });
  } catch (error) {
    console.error('gRPC balances error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/cache/stats - Get account cache statistics
app.get('/grpc/cache/stats', (req, res) => {
  res.json(accountCache.getStats());
  }
});

// ============================================================================
// PHASE 3: UNIFIED BUY/SELL gRPC ENDPOINTS
// ============================================================================

// POST /grpc/buy - Execute a buy trade (SOL -> Token)
// Uses gRPC for fast blockhash + Jito bundle submission
// Protected: Requires API key if configured
app.post('/grpc/buy', requireApiKeyStrict, async (req, res) => {
  try {
    const {
      outputMint,
      amountLamports,
      slippageBps,
      walletPubkey,
      signedTransaction,
      tipLamports,
    } = req.body;

    if (!outputMint) {
      return res.status(400).json({ error: 'outputMint required (token to buy)' });
    }
    if (!amountLamports) {
      return res.status(400).json({ error: 'amountLamports required (SOL amount in lamports)' });
    }
    if (!walletPubkey) {
      return res.status(400).json({ error: 'walletPubkey required' });
    }

    console.log(`[Trade] Buy request: ${amountLamports} lamports -> ${outputMint}`);

    const result = await tradeService.executeBuy({
      outputMint,
      amountLamports: parseInt(amountLamports),
      slippageBps: slippageBps ? parseInt(slippageBps) : 100,
      walletPubkey,
      signedTransaction,
      tipLamports: tipLamports ? parseInt(tipLamports) : 10000,
    });

    res.json(result);
  } catch (error) {
    console.error('[Trade] Buy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /grpc/sell - Execute a sell trade (Token -> SOL)
// Uses gRPC for fast blockhash + Jito bundle submission
// Protected: Requires API key if configured
app.post('/grpc/sell', requireApiKeyStrict, async (req, res) => {
  try {
    const {
      inputMint,
      amountTokens,
      slippageBps,
      walletPubkey,
      signedTransaction,
      tipLamports,
    } = req.body;

    if (!inputMint) {
      return res.status(400).json({ error: 'inputMint required (token to sell)' });
    }
    if (!amountTokens) {
      return res.status(400).json({ error: 'amountTokens required (token amount in smallest units)' });
    }
    if (!walletPubkey) {
      return res.status(400).json({ error: 'walletPubkey required' });
    }

    console.log(`[Trade] Sell request: ${amountTokens} ${inputMint} -> SOL`);

    const result = await tradeService.executeSell({
      inputMint,
      amountTokens: amountTokens.toString(),
      slippageBps: slippageBps ? parseInt(slippageBps) : 100,
      walletPubkey,
      signedTransaction,
      tipLamports: tipLamports ? parseInt(tipLamports) : 10000,
    });

    res.json(result);
  } catch (error) {
    console.error('[Trade] Sell error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /grpc/trade/submit - Submit a signed transaction for a pending trade
// Protected: Requires API key if configured
app.post('/grpc/trade/submit', requireApiKeyStrict, async (req, res) => {
  try {
    const { tradeId, signedTransaction } = req.body;

    if (!tradeId) {
      return res.status(400).json({ error: 'tradeId required' });
    }
    if (!signedTransaction) {
      return res.status(400).json({ error: 'signedTransaction required (base64 encoded)' });
    }

    console.log(`[Trade] Submitting signed transaction for trade: ${tradeId}`);

    const result = await tradeService.submitSignedTransaction(tradeId, signedTransaction);
    res.json(result);
  } catch (error) {
    console.error('[Trade] Submit error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /grpc/trade/:tradeId - Get trade status and history
app.get('/grpc/trade/:tradeId', (req, res) => {
  const trade = tradeService.getTrade(req.params.tradeId);
  
  if (!trade) {
    return res.status(404).json({ error: 'Trade not found' });
  }

  res.json({
    id: trade.id,
    type: trade.type,
    status: trade.status,
    inputMint: trade.inputMint,
    outputMint: trade.outputMint,
    amount: trade.amount,
    walletPubkey: trade.walletPubkey,
    bundleId: trade.bundleId,
    error: trade.error,
    steps: trade.steps,
    createdAt: trade.createdAt,
    updatedAt: trade.updatedAt,
  });
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

// --- Jito gRPC Client Manager ---
// Manages Jito Block Engine gRPC connections with automatic reconnection
class JitoGrpcManager {
  constructor() {
    this.client = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.lastError = null;
    this.bundleResultSubscribers = new Map(); // ws -> cancelFn
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
  }

  // Parse auth keypair from base58 if provided
  getAuthKeypair() {
    if (!JITO_AUTH_KEYPAIR) return null;
    try {
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58');
      const secretKey = bs58.decode(JITO_AUTH_KEYPAIR);
      return Keypair.fromSecretKey(secretKey);
    } catch (err) {
      console.error('Failed to parse JITO_AUTH_KEYPAIR:', err.message);
      return null;
    }
  }

  // Get or create gRPC client connection
  async getClient() {
    if (this.client) return this.client;
    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionPromise = this._connect();
    
    try {
      const client = await this.connectionPromise;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      return client;
    } catch (err) {
      this.isConnecting = false;
      this.lastError = err;
      throw err;
    }
  }

  async _connect() {
    const { searcherClient } = require('jito-ts/dist/sdk/block-engine/searcher');
    const authKeypair = this.getAuthKeypair();
    
    const endpoint = JITO_BLOCK_ENGINE_URL;
    console.log(`Connecting to Jito gRPC: ${endpoint}${authKeypair ? ' (authenticated)' : ' (public)'}`);
    
    try {
      this.client = searcherClient(endpoint, authKeypair);
      
      // Test connection by getting tip accounts
      const result = await this.client.getTipAccounts();
      if (result.ok) {
        console.log('Jito gRPC connected successfully');
        return this.client;
      } else {
        throw new Error(result.error?.message || 'Failed to connect to Jito gRPC');
      }
    } catch (err) {
      this.client = null;
      console.error('Jito gRPC connection error:', err.message);
      throw err;
    }
  }

  // Attempt reconnection with exponential backoff
  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached for Jito gRPC');
      return null;
    }
    
    this.client = null;
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting to Jito gRPC in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      return await this.getClient();
    } catch (err) {
      return this.reconnect();
    }
  }

  // Check connection health
  async isHealthy() {
    try {
      const client = await this.getClient();
      const result = await client.getTipAccounts();
      return result.ok;
    } catch {
      return false;
    }
  }

  // Get status info
  getStatus() {
    return {
      connected: !!this.client,
      endpoint: JITO_BLOCK_ENGINE_URL,
      authenticated: !!JITO_AUTH_KEYPAIR,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError?.message || null,
      activeSubscribers: this.bundleResultSubscribers.size,
    };
  }

  // Clean up resources
  cleanup() {
    for (const [ws, cancelFn] of this.bundleResultSubscribers) {
      try {
        cancelFn();
      } catch {}
    }
    this.bundleResultSubscribers.clear();
    this.client = null;
  }
}

// Singleton instance
const jitoGrpc = new JitoGrpcManager();

// --- Yellowstone gRPC Client Manager ---
// Manages Yellowstone (Geyser) gRPC connections for streaming data
class YellowstoneGrpcManager {
  constructor() {
    this.client = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.subscribers = new Map(); // ws -> { stream, type }
  }

  // Get endpoint configuration
  getConfig() {
    return getKalderaEndpoint();
  }

  // Get or create gRPC client connection
  async getClient() {
    if (this.client) return this.client;
    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionPromise = this._connect();
    
    try {
      const client = await this.connectionPromise;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      return client;
    } catch (err) {
      this.isConnecting = false;
      this.lastError = err;
      throw err;
    }
  }

  async _connect() {
    const cfg = this.getConfig();
    if (!cfg) {
      throw new Error('Yellowstone gRPC not configured. Set KALDERA_GRPC_URL and KALDERA_X_TOKEN.');
    }

    console.log(`Connecting to Yellowstone gRPC: ${cfg.endpoint}`);
    
    try {
      const Client = (await import('@triton-one/yellowstone-grpc')).default;
      this.client = new Client(cfg.endpoint, cfg.token, {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
      });
      await this.client.connect();
      
      // Test connection
      const slot = await this.client.getSlot();
      console.log(`Yellowstone gRPC connected successfully (slot: ${slot})`);
      return this.client;
    } catch (err) {
      this.client = null;
      console.error('Yellowstone gRPC connection error:', err.message);
      throw err;
    }
  }

  // Get latest blockhash via gRPC (faster than RPC)
  async getLatestBlockhash(commitment = 1) { // 1 = CONFIRMED
    const client = await this.getClient();
    const result = await client.getLatestBlockhash(commitment);
    return {
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
      slot: result.slot,
    };
  }

  // Get current slot via gRPC
  async getSlot(commitment = 1) {
    const client = await this.getClient();
    return await client.getSlot(commitment);
  }

  // Get block height via gRPC
  async getBlockHeight(commitment = 1) {
    const client = await this.getClient();
    return await client.getBlockHeight(commitment);
  }

  // Check if blockhash is valid
  async isBlockhashValid(blockhash, commitment = 1) {
    const client = await this.getClient();
    const result = await client.isBlockhashValid(blockhash, commitment);
    return {
      valid: result.valid,
      slot: result.slot,
    };
  }

  // Create a subscription stream
  async subscribe() {
    const client = await this.getClient();
    return await client.subscribe();
  }

  // Attempt reconnection with exponential backoff
  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached for Yellowstone gRPC');
      return null;
    }
    
    this.client = null;
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting to Yellowstone gRPC in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      return await this.getClient();
    } catch (err) {
      return this.reconnect();
    }
  }

  // Check connection health
  async isHealthy() {
    try {
      const client = await this.getClient();
      await client.getSlot();
      return true;
    } catch {
      return false;
    }
  }

  // Get status info
  getStatus() {
    const cfg = this.getConfig();
    return {
      configured: !!cfg,
      connected: !!this.client,
      endpoint: cfg?.endpoint || null,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError?.message || null,
      activeSubscribers: this.subscribers.size,
    };
  }

  // Clean up a subscriber
  removeSubscriber(ws) {
    const sub = this.subscribers.get(ws);
    if (sub && sub.stream) {
      try {
        if (typeof sub.stream.destroy === 'function') {
          sub.stream.destroy();
        }
      } catch {}
    }
    this.subscribers.delete(ws);
  }

  // Clean up all resources
  cleanup() {
    for (const [ws, sub] of this.subscribers) {
      try {
        if (sub.stream && typeof sub.stream.destroy === 'function') {
          sub.stream.destroy();
        }
      } catch {}
    }
    this.subscribers.clear();
    this.client = null;
  }
}

// Singleton instance
const yellowstoneGrpc = new YellowstoneGrpcManager();

// --- Account Cache Manager ---
// Caches account data via gRPC subscriptions to avoid RPC rate limits
class AccountCacheManager {
  constructor() {
    this.accountCache = new Map(); // pubkey -> { data, slot, updatedAt }
    this.subscriptions = new Map(); // pubkey -> subscription info
    this.pendingRequests = new Map(); // pubkey -> Promise
    this.cacheTTL = 5000; // 5 second cache TTL
    this.maxCacheSize = 1000;
    this.activeStream = null;
    this.subscribedAccounts = new Set();
  }

  // Get account from cache or fetch via gRPC subscription
  async getAccount(pubkey) {
    const cached = this.accountCache.get(pubkey);
    if (cached && Date.now() - cached.updatedAt < this.cacheTTL) {
      return { ...cached, source: 'cache' };
    }

    // Check if there's a pending request
    if (this.pendingRequests.has(pubkey)) {
      return this.pendingRequests.get(pubkey);
    }

    // Fetch via subscription snapshot
    const promise = this._fetchAccountViaSubscription(pubkey);
    this.pendingRequests.set(pubkey, promise);
    
    try {
      const result = await promise;
      return result;
    } finally {
      this.pendingRequests.delete(pubkey);
    }
  }

  // Get multiple accounts (batched)
  async getMultipleAccounts(pubkeys) {
    const results = [];
    const toFetch = [];
    
    // Check cache first
    for (const pubkey of pubkeys) {
      const cached = this.accountCache.get(pubkey);
      if (cached && Date.now() - cached.updatedAt < this.cacheTTL) {
        results.push({ pubkey, ...cached, source: 'cache' });
      } else {
        toFetch.push(pubkey);
      }
    }
    
    // Fetch uncached in parallel
    if (toFetch.length > 0) {
      const fetched = await Promise.allSettled(
        toFetch.map(pubkey => this.getAccount(pubkey))
      );
      
      for (let i = 0; i < toFetch.length; i++) {
        const result = fetched[i];
        if (result.status === 'fulfilled') {
          results.push({ pubkey: toFetch[i], ...result.value });
        } else {
          results.push({ pubkey: toFetch[i], data: null, error: result.reason?.message });
        }
      }
    }
    
    return results;
  }

  // Fetch account via gRPC subscription snapshot
  async _fetchAccountViaSubscription(pubkey) {
    try {
      const client = await yellowstoneGrpc.getClient();
      const stream = await client.subscribe();
      
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          try { stream.destroy(); } catch {}
          reject(new Error('Account fetch timeout'));
        }, 10000);
        
        stream.on('data', (data) => {
          if (data.account && data.account.account) {
            const acc = data.account.account;
            const accountData = {
              data: Buffer.from(acc.data).toString('base64'),
              owner: acc.owner.toString(),
              lamports: acc.lamports.toString(),
              executable: acc.executable,
              rentEpoch: acc.rentEpoch?.toString() || '0',
              slot: data.account.slot?.toString(),
              updatedAt: Date.now(),
            };
            
            this._cacheAccount(pubkey, accountData);
            clearTimeout(timeout);
            try { stream.destroy(); } catch {}
            resolve({ ...accountData, source: 'grpc' });
          }
        });
        
        stream.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        
        // Send subscription request for this account
        stream.write({
          accounts: {
            account: {
              account: [pubkey],
              owner: [],
              filters: [],
            },
          },
          commitment: 1, // CONFIRMED
          accountsDataSlice: [],
        });
      });
    } catch (err) {
      // Fallback to RPC if gRPC fails
      console.log(`gRPC account fetch failed for ${pubkey}, falling back to RPC: ${err.message}`);
      return this._fetchAccountViaRpc(pubkey);
    }
  }

  // Fallback to RPC
  async _fetchAccountViaRpc(pubkey) {
    if (!RPC_URL) {
      throw new Error('RPC not configured');
    }
    
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [pubkey, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    });
    
    const result = await response.json();
    if (result.error) {
      throw new Error(result.error.message);
    }
    
    const value = result.result?.value;
    if (!value) {
      return { data: null, source: 'rpc' };
    }
    
    const accountData = {
      data: value.data[0],
      owner: value.owner,
      lamports: value.lamports.toString(),
      executable: value.executable,
      rentEpoch: value.rentEpoch?.toString() || '0',
      updatedAt: Date.now(),
    };
    
    this._cacheAccount(pubkey, accountData);
    return { ...accountData, source: 'rpc_fallback' };
  }

  // Cache account data
  _cacheAccount(pubkey, data) {
    // Evict old entries if cache is full
    if (this.accountCache.size >= this.maxCacheSize) {
      const oldest = [...this.accountCache.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) {
        this.accountCache.delete(oldest[0]);
      }
    }
    
    this.accountCache.set(pubkey, data);
  }

  // Get balance via gRPC
  async getBalance(pubkey) {
    const account = await this.getAccount(pubkey);
    return {
      lamports: account.lamports ? parseInt(account.lamports) : 0,
      source: account.source,
    };
  }

  // Clear cache
  clearCache() {
    this.accountCache.clear();
  }

  // Get cache stats
  getStats() {
    return {
      cacheSize: this.accountCache.size,
      maxCacheSize: this.maxCacheSize,
      cacheTTL: this.cacheTTL,
    };
  }
}

// Singleton instance
const accountCache = new AccountCacheManager();

// --- Trade Service ---
// Unified service for buy/sell operations using gRPC
class TradeService {
  constructor() {
    this.activeTrades = new Map(); // tradeId -> trade info
    this.tradeSubscribers = new Map(); // ws -> Set of tradeIds
  }

  // Generate unique trade ID
  generateTradeId() {
    return crypto.randomBytes(16).toString('hex');
  }

  // Get random tip account
  getRandomTipAccount() {
    return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  }

  // Get Jupiter quote
  async getJupiterQuote(inputMint, outputMint, amount, slippageBps = 100) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
    });
    
    const response = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jupiter quote failed: ${text}`);
    }
    
    return await response.json();
  }

  // Get Jupiter swap transaction
  async getJupiterSwapTx(quoteResponse, userPublicKey, options = {}) {
    const response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: options.wrapAndUnwrapSol ?? true,
        dynamicComputeUnitLimit: options.dynamicComputeUnitLimit ?? true,
        prioritizationFeeLamports: options.prioritizationFeeLamports || 'auto',
      }),
    });
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jupiter swap failed: ${text}`);
    }
    
    return await response.json();
  }

  // Execute a buy trade (SOL -> Token)
  async executeBuy(params) {
    const {
      outputMint,
      amountLamports,
      slippageBps = 100,
      walletPubkey,
      signedTransaction, // Base64 encoded signed transaction (if pre-signed)
      tipLamports = 10000,
    } = params;

    const tradeId = this.generateTradeId();
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    const trade = {
      id: tradeId,
      type: 'buy',
      status: 'pending',
      inputMint: SOL_MINT,
      outputMint,
      amount: amountLamports,
      walletPubkey,
      createdAt: new Date().toISOString(),
      steps: [],
    };
    
    this.activeTrades.set(tradeId, trade);
    this._updateTrade(tradeId, { status: 'started' });

    try {
      // Step 1: Get blockhash via gRPC (fast)
      this._updateTrade(tradeId, { step: 'getting_blockhash' });
      let blockhash, lastValidBlockHeight;
      
      try {
        const bhResult = await yellowstoneGrpc.getLatestBlockhash(1);
        blockhash = bhResult.blockhash;
        lastValidBlockHeight = bhResult.lastValidBlockHeight;
        this._addStep(tradeId, 'blockhash', 'success', { blockhash, source: 'grpc' });
      } catch (err) {
        // Fallback to RPC
        console.log('gRPC blockhash failed, falling back to RPC');
        const rpcResult = await this._getRpcBlockhash();
        blockhash = rpcResult.blockhash;
        lastValidBlockHeight = rpcResult.lastValidBlockHeight;
        this._addStep(tradeId, 'blockhash', 'success', { blockhash, source: 'rpc_fallback' });
      }

      // Step 2: Get Jupiter quote
      this._updateTrade(tradeId, { step: 'getting_quote' });
      const quote = await this.getJupiterQuote(SOL_MINT, outputMint, amountLamports, slippageBps);
      this._addStep(tradeId, 'quote', 'success', {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct,
      });

      // Step 3: Get swap transaction from Jupiter
      this._updateTrade(tradeId, { step: 'building_transaction' });
      const swapResult = await this.getJupiterSwapTx(quote, walletPubkey);
      this._addStep(tradeId, 'swap_tx', 'success', { hasTransaction: !!swapResult.swapTransaction });

      // If signedTransaction provided, use it; otherwise return unsigned for client to sign
      if (signedTransaction) {
        // Step 4: Send via Jito gRPC
        this._updateTrade(tradeId, { step: 'sending_bundle' });
        
        const bundleResult = await this._sendViaJitoGrpc([signedTransaction]);
        
        if (bundleResult.ok) {
          this._addStep(tradeId, 'bundle_sent', 'success', { uuid: bundleResult.uuid });
          this._updateTrade(tradeId, {
            status: 'submitted',
            bundleId: bundleResult.uuid,
          });
          
          return {
            success: true,
            tradeId,
            bundleId: bundleResult.uuid,
            quote: {
              inAmount: quote.inAmount,
              outAmount: quote.outAmount,
              priceImpactPct: quote.priceImpactPct,
            },
          };
        } else {
          throw new Error(bundleResult.error || 'Bundle submission failed');
        }
      } else {
        // Return unsigned transaction for client to sign
        this._updateTrade(tradeId, { status: 'awaiting_signature' });
        
        return {
          success: true,
          tradeId,
          status: 'awaiting_signature',
          swapTransaction: swapResult.swapTransaction,
          blockhash,
          lastValidBlockHeight: String(lastValidBlockHeight),
          quote: {
            inAmount: quote.inAmount,
            outAmount: quote.outAmount,
            priceImpactPct: quote.priceImpactPct,
          },
          tipAccount: this.getRandomTipAccount(),
          tipLamports,
        };
      }
    } catch (error) {
      this._updateTrade(tradeId, { status: 'failed', error: error.message });
      this._addStep(tradeId, 'error', 'failed', { message: error.message });
      throw error;
    }
  }

  // Execute a sell trade (Token -> SOL)
  async executeSell(params) {
    const {
      inputMint,
      amountTokens,
      slippageBps = 100,
      walletPubkey,
      signedTransaction,
      tipLamports = 10000,
    } = params;

    const tradeId = this.generateTradeId();
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    const trade = {
      id: tradeId,
      type: 'sell',
      status: 'pending',
      inputMint,
      outputMint: SOL_MINT,
      amount: amountTokens,
      walletPubkey,
      createdAt: new Date().toISOString(),
      steps: [],
    };
    
    this.activeTrades.set(tradeId, trade);
    this._updateTrade(tradeId, { status: 'started' });

    try {
      // Step 1: Get blockhash via gRPC (fast)
      this._updateTrade(tradeId, { step: 'getting_blockhash' });
      let blockhash, lastValidBlockHeight;
      
      try {
        const bhResult = await yellowstoneGrpc.getLatestBlockhash(1);
        blockhash = bhResult.blockhash;
        lastValidBlockHeight = bhResult.lastValidBlockHeight;
        this._addStep(tradeId, 'blockhash', 'success', { blockhash, source: 'grpc' });
      } catch (err) {
        const rpcResult = await this._getRpcBlockhash();
        blockhash = rpcResult.blockhash;
        lastValidBlockHeight = rpcResult.lastValidBlockHeight;
        this._addStep(tradeId, 'blockhash', 'success', { blockhash, source: 'rpc_fallback' });
      }

      // Step 2: Get Jupiter quote
      this._updateTrade(tradeId, { step: 'getting_quote' });
      const quote = await this.getJupiterQuote(inputMint, SOL_MINT, amountTokens, slippageBps);
      this._addStep(tradeId, 'quote', 'success', {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct,
      });

      // Step 3: Get swap transaction from Jupiter
      this._updateTrade(tradeId, { step: 'building_transaction' });
      const swapResult = await this.getJupiterSwapTx(quote, walletPubkey);
      this._addStep(tradeId, 'swap_tx', 'success', { hasTransaction: !!swapResult.swapTransaction });

      if (signedTransaction) {
        // Step 4: Send via Jito gRPC
        this._updateTrade(tradeId, { step: 'sending_bundle' });
        
        const bundleResult = await this._sendViaJitoGrpc([signedTransaction]);
        
        if (bundleResult.ok) {
          this._addStep(tradeId, 'bundle_sent', 'success', { uuid: bundleResult.uuid });
          this._updateTrade(tradeId, {
            status: 'submitted',
            bundleId: bundleResult.uuid,
          });
          
          return {
            success: true,
            tradeId,
            bundleId: bundleResult.uuid,
            quote: {
              inAmount: quote.inAmount,
              outAmount: quote.outAmount,
              priceImpactPct: quote.priceImpactPct,
            },
          };
        } else {
          throw new Error(bundleResult.error || 'Bundle submission failed');
        }
      } else {
        this._updateTrade(tradeId, { status: 'awaiting_signature' });
        
        return {
          success: true,
          tradeId,
          status: 'awaiting_signature',
          swapTransaction: swapResult.swapTransaction,
          blockhash,
          lastValidBlockHeight: String(lastValidBlockHeight),
          quote: {
            inAmount: quote.inAmount,
            outAmount: quote.outAmount,
            priceImpactPct: quote.priceImpactPct,
          },
          tipAccount: this.getRandomTipAccount(),
          tipLamports,
        };
      }
    } catch (error) {
      this._updateTrade(tradeId, { status: 'failed', error: error.message });
      this._addStep(tradeId, 'error', 'failed', { message: error.message });
      throw error;
    }
  }

  // Submit a signed transaction for a pending trade
  async submitSignedTransaction(tradeId, signedTransaction) {
    const trade = this.activeTrades.get(tradeId);
    if (!trade) {
      throw new Error('Trade not found');
    }
    
    if (trade.status !== 'awaiting_signature') {
      throw new Error(`Trade is not awaiting signature (status: ${trade.status})`);
    }

    this._updateTrade(tradeId, { step: 'sending_bundle' });
    
    try {
      const bundleResult = await this._sendViaJitoGrpc([signedTransaction]);
      
      if (bundleResult.ok) {
        this._addStep(tradeId, 'bundle_sent', 'success', { uuid: bundleResult.uuid });
        this._updateTrade(tradeId, {
          status: 'submitted',
          bundleId: bundleResult.uuid,
        });
        
        return {
          success: true,
          tradeId,
          bundleId: bundleResult.uuid,
        };
      } else {
        throw new Error(bundleResult.error || 'Bundle submission failed');
      }
    } catch (error) {
      this._updateTrade(tradeId, { status: 'failed', error: error.message });
      this._addStep(tradeId, 'error', 'failed', { message: error.message });
      throw error;
    }
  }

  // Send transactions via Jito gRPC
  async _sendViaJitoGrpc(transactions) {
    try {
      const client = await jitoGrpc.getClient();
      const { VersionedTransaction } = require('@solana/web3.js');
      const { Bundle } = require('jito-ts/dist/sdk/block-engine/types');
      
      const deserializedTxs = transactions.map(tx => {
        const buffer = Buffer.from(tx, 'base64');
        return VersionedTransaction.deserialize(buffer);
      });
      
      const bundle = new Bundle(deserializedTxs, 5);
      const result = await client.sendBundle(bundle);
      
      if (result.ok) {
        return { ok: true, uuid: result.value };
      } else {
        return { ok: false, error: result.error?.message || 'Unknown error' };
      }
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // Fallback RPC blockhash
  async _getRpcBlockhash() {
    if (!RPC_URL) {
      throw new Error('RPC not configured');
    }
    
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
    });
    
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message);
    }
    
    return {
      blockhash: data.result.value.blockhash,
      lastValidBlockHeight: data.result.value.lastValidBlockHeight,
    };
  }

  // Update trade state
  _updateTrade(tradeId, updates) {
    const trade = this.activeTrades.get(tradeId);
    if (trade) {
      Object.assign(trade, updates, { updatedAt: new Date().toISOString() });
      this._notifySubscribers(tradeId, trade);
    }
  }

  // Add step to trade history
  _addStep(tradeId, name, status, data = {}) {
    const trade = this.activeTrades.get(tradeId);
    if (trade) {
      trade.steps.push({
        name,
        status,
        data,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Notify WebSocket subscribers
  _notifySubscribers(tradeId, trade) {
    for (const [ws, tradeIds] of this.tradeSubscribers) {
      if (tradeIds.has(tradeId) && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'trade_update',
          tradeId,
          trade: {
            id: trade.id,
            type: trade.type,
            status: trade.status,
            step: trade.step,
            bundleId: trade.bundleId,
            error: trade.error,
            updatedAt: trade.updatedAt,
          },
        }));
      }
    }
  }

  // Get trade by ID
  getTrade(tradeId) {
    return this.activeTrades.get(tradeId);
  }

  // Subscribe to trade updates
  subscribe(ws, tradeId) {
    if (!this.tradeSubscribers.has(ws)) {
      this.tradeSubscribers.set(ws, new Set());
    }
    this.tradeSubscribers.get(ws).add(tradeId);
  }

  // Unsubscribe from trade updates
  unsubscribe(ws, tradeId) {
    const tradeIds = this.tradeSubscribers.get(ws);
    if (tradeIds) {
      if (tradeId) {
        tradeIds.delete(tradeId);
      } else {
        this.tradeSubscribers.delete(ws);
      }
    }
  }

  // Clean up old trades (call periodically)
  cleanup(maxAgeMs = 3600000) { // Default: 1 hour
    const now = Date.now();
    for (const [tradeId, trade] of this.activeTrades) {
      const createdAt = new Date(trade.createdAt).getTime();
      if (now - createdAt > maxAgeMs) {
        this.activeTrades.delete(tradeId);
      }
    }
  }
}

// Singleton instance
const tradeService = new TradeService();

// Cleanup old trades every 10 minutes
setInterval(() => tradeService.cleanup(), 600000);

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

// --- HTTP server + WebSocket for streams ---
// WebSocket paths we handle:
// - /kaldera/slots: Yellowstone slot stream
// - /grpc/jito/bundle-results: Jito bundle result stream
const WS_PATHS = [
  '/kaldera/slots',
  '/grpc/jito/bundle-results',
  '/grpc/subscribe/transactions',
  '/grpc/subscribe/accounts',
  '/grpc/trade/status',
];

const server = http.createServer((req, res) => {
  const path = req.url ? req.url.split('?')[0] : '';
  const isUpgrade = (req.headers.upgrade || '').toLowerCase() === 'websocket';
  
  if (isUpgrade && WS_PATHS.includes(path)) {
    return; // leave connection open so server emits 'upgrade' and wss handles it
  }
  app(req, res);
});

// Kaldera slot stream: WebSocket at path /kaldera/slots — streams { slot, status, parent } for each new slot
const wssSlots = new WebSocketServer({ server, path: '/kaldera/slots' });

// Jito bundle results stream: WebSocket at path /grpc/jito/bundle-results
const wssBundleResults = new WebSocketServer({ server, path: '/grpc/jito/bundle-results' });

// Yellowstone transaction stream: WebSocket at path /grpc/subscribe/transactions
const wssTransactions = new WebSocketServer({ server, path: '/grpc/subscribe/transactions' });

// Yellowstone account stream: WebSocket at path /grpc/subscribe/accounts
const wssAccounts = new WebSocketServer({ server, path: '/grpc/subscribe/accounts' });

// Trade status stream: WebSocket at path /grpc/trade/status
const wssTradeStatus = new WebSocketServer({ server, path: '/grpc/trade/status' });

// --- Jito Bundle Results WebSocket Handler ---
wssBundleResults.on('connection', async (ws) => {
  console.log('[WS] New bundle results subscriber connected');
  
  let cancelSubscription = null;
  
  try {
    const client = await jitoGrpc.getClient();
    
    // Subscribe to bundle results
    cancelSubscription = client.onBundleResult(
      (bundleResult) => {
        if (ws.readyState === 1) { // WebSocket.OPEN
          // Determine the status from the result
          let status = 'unknown';
          let details = null;
          
          if (bundleResult.rejected) {
            status = 'rejected';
            details = bundleResult.rejected;
          } else if (bundleResult.finalized) {
            status = 'finalized';
            details = bundleResult.finalized;
          } else if (bundleResult.processed) {
            status = 'processed';
            details = bundleResult.processed;
          } else if (bundleResult.dropped) {
            status = 'dropped';
            details = bundleResult.dropped;
          }
          
          ws.send(JSON.stringify({
            bundleId: bundleResult.bundleId,
            status,
            slot: details?.slot ? String(details.slot) : undefined,
            timestamp: new Date().toISOString(),
            details,
          }));
        }
      },
      (error) => {
        console.error('[WS] Bundle result stream error:', error.message);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            error: error.message,
            type: 'stream_error',
          }));
        }
      }
    );
    
    // Store the cancel function for cleanup
    jitoGrpc.bundleResultSubscribers.set(ws, cancelSubscription);
    
    // Send confirmation message
    ws.send(JSON.stringify({
      type: 'subscribed',
      message: 'Connected to Jito bundle results stream',
      timestamp: new Date().toISOString(),
    }));
    
  } catch (err) {
    console.error('[WS] Failed to setup bundle results stream:', err.message);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        error: err.message,
        type: 'connection_error',
      }));
      ws.close();
    }
    return;
  }
  
  // Handle client disconnect
  ws.on('close', () => {
    console.log('[WS] Bundle results subscriber disconnected');
    if (cancelSubscription) {
      try {
        cancelSubscription();
      } catch {}
    }
    jitoGrpc.bundleResultSubscribers.delete(ws);
  });
  
  // Handle ping/pong for keepalive
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch {}
  });
});

// --- Trade Status WebSocket Handler ---
// Subscribe to trade status updates
wssTradeStatus.on('connection', (ws) => {
  console.log('[WS] New trade status subscriber connected');

  // Send welcome message with instructions
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to trade status stream. Subscribe to trades to receive updates.',
    example: {
      action: 'subscribe',
      tradeId: 'your-trade-id',
    },
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        return;
      }
      
      if (msg.action === 'subscribe' && msg.tradeId) {
        const trade = tradeService.getTrade(msg.tradeId);
        
        if (!trade) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Trade not found',
            tradeId: msg.tradeId,
          }));
          return;
        }
        
        tradeService.subscribe(ws, msg.tradeId);
        
        // Send current state immediately
        ws.send(JSON.stringify({
          type: 'subscribed',
          tradeId: msg.tradeId,
          trade: {
            id: trade.id,
            type: trade.type,
            status: trade.status,
            step: trade.step,
            bundleId: trade.bundleId,
            error: trade.error,
            steps: trade.steps,
            createdAt: trade.createdAt,
            updatedAt: trade.updatedAt,
          },
        }));
      }
      
      if (msg.action === 'unsubscribe' && msg.tradeId) {
        tradeService.unsubscribe(ws, msg.tradeId);
        ws.send(JSON.stringify({
          type: 'unsubscribed',
          tradeId: msg.tradeId,
        }));
      }
      
    } catch (err) {
      ws.send(JSON.stringify({ error: 'Invalid message format', type: 'parse_error' }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Trade status subscriber disconnected');
    tradeService.unsubscribe(ws);
  });
});

// --- Yellowstone Transaction Subscription WebSocket Handler ---
// Subscribe to transactions by account addresses
wssTransactions.on('connection', async (ws) => {
  console.log('[WS] New transaction subscriber connected');
  
  const status = yellowstoneGrpc.getStatus();
  if (!status.configured) {
    ws.send(JSON.stringify({
      error: 'Yellowstone gRPC not configured. Set KALDERA_GRPC_URL and KALDERA_X_TOKEN.',
      type: 'config_error',
    }));
    ws.close();
    return;
  }

  let stream = null;
  let subscribed = false;

  // Send instructions to client
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected. Send a subscribe message to start receiving transactions.',
    example: {
      action: 'subscribe',
      filter: {
        accountInclude: ['wallet-pubkey-1', 'token-mint'],
        accountExclude: [],
        vote: false,
        failed: false,
      },
      commitment: 'confirmed',
    },
  }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        return;
      }
      
      if (msg.action === 'subscribe' && !subscribed) {
        const filter = msg.filter || {};
        const commitment = msg.commitment === 'finalized' ? 2 : 1;
        
        try {
          const { CommitmentLevel } = await import('@triton-one/yellowstone-grpc');
          stream = await yellowstoneGrpc.subscribe();
          
          // Build subscription request
          const subscribeRequest = {
            accounts: {},
            slots: {},
            transactions: {
              txSubscription: {
                vote: filter.vote ?? false,
                failed: filter.failed ?? false,
                signature: filter.signature || undefined,
                accountInclude: filter.accountInclude || [],
                accountExclude: filter.accountExclude || [],
                accountRequired: filter.accountRequired || [],
              },
            },
            transactionsStatus: {},
            blocks: {},
            blocksMeta: {},
            entry: {},
            commitment: commitment === 2 ? CommitmentLevel.FINALIZED : CommitmentLevel.CONFIRMED,
            accountsDataSlice: [],
            ping: { id: 1 },
          };
          
          stream.write(subscribeRequest);
          subscribed = true;
          
          // Store for cleanup
          yellowstoneGrpc.subscribers.set(ws, { stream, type: 'transactions' });
          
          ws.send(JSON.stringify({
            type: 'subscribed',
            message: 'Subscribed to transactions',
            filter: subscribeRequest.transactions.txSubscription,
            timestamp: new Date().toISOString(),
          }));
          
          stream.on('data', (update) => {
            if (update.transaction && ws.readyState === 1) {
              const tx = update.transaction;
              const txInfo = tx.transaction;
              
              // Convert signature bytes to base58
              const bs58 = require('bs58');
              const signature = txInfo?.signature ? bs58.encode(Buffer.from(txInfo.signature)) : null;
              
              ws.send(JSON.stringify({
                type: 'transaction',
                signature,
                slot: String(tx.slot),
                isVote: txInfo?.isVote || false,
                index: txInfo?.index,
                timestamp: new Date().toISOString(),
              }));
            }
          });
          
          stream.on('error', (err) => {
            console.error('[WS] Transaction stream error:', err.message);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ error: err.message, type: 'stream_error' }));
            }
          });
          
          stream.on('end', () => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'stream_ended' }));
              ws.close();
            }
          });
          
        } catch (err) {
          console.error('[WS] Transaction subscribe error:', err.message);
          ws.send(JSON.stringify({ error: err.message, type: 'subscribe_error' }));
        }
      }
      
      if (msg.action === 'unsubscribe' && subscribed) {
        yellowstoneGrpc.removeSubscriber(ws);
        stream = null;
        subscribed = false;
        ws.send(JSON.stringify({ type: 'unsubscribed', timestamp: new Date().toISOString() }));
      }
      
    } catch (err) {
      ws.send(JSON.stringify({ error: 'Invalid message format', type: 'parse_error' }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Transaction subscriber disconnected');
    yellowstoneGrpc.removeSubscriber(ws);
  });
});

// --- Yellowstone Account Subscription WebSocket Handler ---
// Subscribe to account changes by address or owner
wssAccounts.on('connection', async (ws) => {
  console.log('[WS] New account subscriber connected');
  
  const status = yellowstoneGrpc.getStatus();
  if (!status.configured) {
    ws.send(JSON.stringify({
      error: 'Yellowstone gRPC not configured. Set KALDERA_GRPC_URL and KALDERA_X_TOKEN.',
      type: 'config_error',
    }));
    ws.close();
    return;
  }

  let stream = null;
  let subscribed = false;

  // Send instructions to client
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected. Send a subscribe message to start receiving account updates.',
    example: {
      action: 'subscribe',
      filter: {
        account: ['account-pubkey-1', 'account-pubkey-2'],
        owner: ['owner-program-id'],
      },
      commitment: 'confirmed',
    },
  }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        return;
      }
      
      if (msg.action === 'subscribe' && !subscribed) {
        const filter = msg.filter || {};
        const commitment = msg.commitment === 'finalized' ? 2 : 1;
        
        if (!filter.account?.length && !filter.owner?.length) {
          ws.send(JSON.stringify({
            error: 'At least one account or owner filter required',
            type: 'validation_error',
          }));
          return;
        }
        
        try {
          const { CommitmentLevel } = await import('@triton-one/yellowstone-grpc');
          stream = await yellowstoneGrpc.subscribe();
          
          // Build subscription request
          const subscribeRequest = {
            accounts: {
              accountSubscription: {
                account: filter.account || [],
                owner: filter.owner || [],
                filters: filter.filters || [],
                nonemptyTxnSignature: filter.nonemptyTxnSignature ?? undefined,
              },
            },
            slots: {},
            transactions: {},
            transactionsStatus: {},
            blocks: {},
            blocksMeta: {},
            entry: {},
            commitment: commitment === 2 ? CommitmentLevel.FINALIZED : CommitmentLevel.CONFIRMED,
            accountsDataSlice: filter.dataSlice || [],
            ping: { id: 1 },
          };
          
          stream.write(subscribeRequest);
          subscribed = true;
          
          // Store for cleanup
          yellowstoneGrpc.subscribers.set(ws, { stream, type: 'accounts' });
          
          ws.send(JSON.stringify({
            type: 'subscribed',
            message: 'Subscribed to account updates',
            filter: subscribeRequest.accounts.accountSubscription,
            timestamp: new Date().toISOString(),
          }));
          
          stream.on('data', (update) => {
            if (update.account && ws.readyState === 1) {
              const acc = update.account;
              const info = acc.account;
              
              // Convert pubkey bytes to base58
              const bs58 = require('bs58');
              const pubkey = info?.pubkey ? bs58.encode(Buffer.from(info.pubkey)) : null;
              const owner = info?.owner ? bs58.encode(Buffer.from(info.owner)) : null;
              
              ws.send(JSON.stringify({
                type: 'account',
                pubkey,
                owner,
                lamports: info?.lamports,
                slot: String(acc.slot),
                executable: info?.executable || false,
                rentEpoch: info?.rentEpoch,
                dataLength: info?.data?.length || 0,
                isStartup: acc.isStartup || false,
                timestamp: new Date().toISOString(),
              }));
            }
          });
          
          stream.on('error', (err) => {
            console.error('[WS] Account stream error:', err.message);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ error: err.message, type: 'stream_error' }));
            }
          });
          
          stream.on('end', () => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'stream_ended' }));
              ws.close();
            }
          });
          
        } catch (err) {
          console.error('[WS] Account subscribe error:', err.message);
          ws.send(JSON.stringify({ error: err.message, type: 'subscribe_error' }));
        }
      }
      
      if (msg.action === 'unsubscribe' && subscribed) {
        yellowstoneGrpc.removeSubscriber(ws);
        stream = null;
        subscribed = false;
        ws.send(JSON.stringify({ type: 'unsubscribed', timestamp: new Date().toISOString() }));
      }
      
    } catch (err) {
      ws.send(JSON.stringify({ error: 'Invalid message format', type: 'parse_error' }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Account subscriber disconnected');
    yellowstoneGrpc.removeSubscriber(ws);
  });
});

// --- Kaldera Slot Stream WebSocket Handler ---
wssSlots.on('connection', async (ws) => {
  const cfg = getKalderaEndpoint();
  if (!cfg) {
    ws.send(JSON.stringify({ error: 'Kaldera gRPC not configured' }));
    ws.close();
    return;
  }
  let stream = null;
  let client = null;
  try {
    const { default: Client, CommitmentLevel } = await import('@triton-one/yellowstone-grpc');
    client = new Client(cfg.endpoint, cfg.token, {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
    });
    await client.connect();
    stream = await client.subscribe();
    // Subscribe to slots only (confirmed commitment)
    const subscribeRequest = {
      accounts: {},
      slots: { slots: { filterByCommitment: true } },
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.CONFIRMED,
      accountsDataSlice: [],
      ping: { id: 1 },
    };
    stream.write(subscribeRequest);
    stream.on('data', (update) => {
      if (update.slot && ws.readyState === 1) {
        ws.send(JSON.stringify({
          slot: String(update.slot.slot),
          status: update.slot.status,
          parent: update.slot.parent ? String(update.slot.parent) : undefined,
        }));
      }
    });
    stream.on('error', (err) => {
      console.error('Kaldera slot stream error:', err.message);
      if (ws.readyState === 1) ws.send(JSON.stringify({ error: err.message }));
    });
    stream.on('end', () => {
      if (ws.readyState === 1) ws.close();
    });
  } catch (err) {
    console.error('Kaldera slot stream setup error:', err.message);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ error: err.message }));
      ws.close();
    }
    return;
  }
  ws.on('close', () => {
    if (stream && typeof stream.destroy === 'function') stream.destroy();
  });
});

// Start server (0.0.0.0 so Railway/containers can reach healthcheck)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Claude Tools Proxy running on port ${PORT}`);
  console.log(`   RPC: ${RPC_URL ? 'Constant K ✓' : 'NOT SET ✗ (set CONSTANTK_RPC_URL in env)'}`);
  console.log(`   Yellowstone gRPC: ${KALDERA_GRPC_URL && KALDERA_X_TOKEN ? '✓' : 'NOT SET (optional: KALDERA_GRPC_URL, KALDERA_X_TOKEN)'}`);
  console.log(`   Jito gRPC: ${JITO_BLOCK_ENGINE_URL}${JITO_AUTH_KEYPAIR ? ' (authenticated)' : ' (public)'}`);
  console.log(`   Trade endpoints: POST /grpc/buy, POST /grpc/sell`);
  console.log(`   WebSocket streams:`);
  console.log(`     - wss://<host>/kaldera/slots (slot updates)`);
  console.log(`     - wss://<host>/grpc/jito/bundle-results (Jito bundle results)`);
  console.log(`     - wss://<host>/grpc/subscribe/transactions (transaction stream)`);
  console.log(`     - wss://<host>/grpc/subscribe/accounts (account updates)`);
  console.log(`     - wss://<host>/grpc/trade/status (trade status updates)`);
});

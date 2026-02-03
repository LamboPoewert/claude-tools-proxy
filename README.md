# Claude Tools Proxy

Solana RPC proxy with gRPC support for Jito bundles, Yellowstone streaming, and Jupiter swaps.

## Features

- RPC proxy to Constant K
- Jito bundle sending (HTTP + gRPC)
- Yellowstone gRPC streaming:
  - Slot updates
  - Transaction subscriptions
  - Account change subscriptions
  - Fast blockhash retrieval
- Jito gRPC bundle results streaming
- **Unified Buy/Sell Endpoints**:
  - gRPC-optimized trade execution
  - Jupiter integration for best prices
  - Jito MEV protection
  - Real-time trade status streaming
- Jupiter quote and swap proxy
- Token metadata hosting
- Image hosting for NFTs

## Installation

### Prerequisites
- Node.js 18+ installed
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Run server
npm start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `CONSTANTK_RPC_URL` | Yes | Constant K RPC endpoint URL |
| `KALDERA_GRPC_URL` | No | Yellowstone gRPC endpoint (e.g., `grpcs://...`) |
| `KALDERA_X_TOKEN` | No | Yellowstone gRPC auth token |
| `JITO_BLOCK_ENGINE_URL` | No | Jito gRPC endpoint (default: `mainnet.block-engine.jito.wtf:443`) |
| `JITO_AUTH_KEYPAIR` | No | Base58-encoded private key for authenticated Jito access |

## API Endpoints

### Health Check

```
GET /
```
Returns service status.

### RPC Proxy

```
POST /rpc
```
Proxies JSON-RPC requests to Constant K.

### Jito HTTP Endpoints

```
POST /jito/bundle
```
Send bundle via HTTP (legacy).

```
POST /jito/status
```
Check bundle status.

### Jito gRPC Endpoints (New)

```
GET /grpc/jito/test
```
Test Jito gRPC connection health.

```
GET /grpc/jito/status
```
Get Jito gRPC connection status.

```
GET /grpc/jito/tip-accounts
```
Get Jito tip accounts via gRPC.

**Response:**
```json
{
  "accounts": ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", ...],
  "source": "grpc"
}
```

```
GET /grpc/jito/leaders
```
Get connected leaders via gRPC.

**Response:**
```json
{
  "leaders": [{"identity": "...", "slots": [123, 124]}],
  "count": 10,
  "source": "grpc"
}
```

```
GET /grpc/jito/next-leader
```
Get next scheduled leader.

**Response:**
```json
{
  "currentSlot": 123456,
  "nextLeaderSlot": 123460,
  "nextLeaderIdentity": "...",
  "slotsUntilLeader": 4,
  "source": "grpc"
}
```

```
POST /grpc/jito/bundle
```
Send bundle via Jito gRPC (faster than HTTP).

**Request:**
```json
{
  "transactions": ["base64-encoded-versioned-tx-1", "base64-encoded-versioned-tx-2"]
}
```

**Response:**
```json
{
  "uuid": "bundle-uuid",
  "status": "accepted",
  "transactionCount": 2,
  "latencyMs": 85,
  "source": "grpc"
}
```

### Jupiter Endpoints

```
GET /jupiter/quote?inputMint=...&outputMint=...&amount=...
```
Get Jupiter swap quote.

```
POST /jupiter/swap
```
Get Jupiter swap transaction.

### Metadata Endpoints

```
POST /metadata
```
Create token metadata (returns URI).

```
GET /metadata/:id
```
Get token metadata JSON.

```
POST /metadata/image
```
Upload image (returns URL).

```
GET /metadata/image/:id
```
Get uploaded image.

### Yellowstone gRPC Endpoints

```
GET /kaldera/test
```
Test Kaldera/Yellowstone gRPC connection (legacy).

```
GET /grpc/yellowstone/test
```
Test Yellowstone gRPC connection health.

```
GET /grpc/yellowstone/status
```
Get Yellowstone gRPC connection status.

```
GET /grpc/blockhash?commitment=confirmed
```
Get latest blockhash via gRPC (faster than RPC).

**Response:**
```json
{
  "blockhash": "...",
  "lastValidBlockHeight": "123456789",
  "slot": "123456789",
  "commitment": "confirmed",
  "source": "grpc"
}
```

```
GET /grpc/slot?commitment=confirmed
```
Get current slot via gRPC.

```
GET /grpc/block-height?commitment=confirmed
```
Get current block height via gRPC.

```
POST /grpc/blockhash/valid
```
Check if blockhash is valid via gRPC.

**Request:**
```json
{
  "blockhash": "..."
}
```

### Unified Trade Endpoints (Phase 3)

```
POST /grpc/buy
```
Execute a buy trade (SOL -> Token) using gRPC for fast blockhash + Jito bundle.

**Request:**
```json
{
  "outputMint": "token-mint-address",
  "amountLamports": 1000000000,
  "slippageBps": 100,
  "walletPubkey": "your-wallet-pubkey",
  "signedTransaction": "base64-signed-tx (optional)",
  "tipLamports": 10000
}
```

**Response (if signedTransaction provided):**
```json
{
  "success": true,
  "tradeId": "unique-trade-id",
  "bundleId": "jito-bundle-uuid",
  "quote": {
    "inAmount": "1000000000",
    "outAmount": "123456789",
    "priceImpactPct": "0.5"
  }
}
```

**Response (if no signedTransaction - returns unsigned tx for client to sign):**
```json
{
  "success": true,
  "tradeId": "unique-trade-id",
  "status": "awaiting_signature",
  "swapTransaction": "base64-unsigned-tx",
  "blockhash": "...",
  "lastValidBlockHeight": "123456789",
  "quote": {...},
  "tipAccount": "jito-tip-account",
  "tipLamports": 10000
}
```

```
POST /grpc/sell
```
Execute a sell trade (Token -> SOL) using gRPC for fast blockhash + Jito bundle.

**Request:**
```json
{
  "inputMint": "token-mint-address",
  "amountTokens": "1000000",
  "slippageBps": 100,
  "walletPubkey": "your-wallet-pubkey",
  "signedTransaction": "base64-signed-tx (optional)",
  "tipLamports": 10000
}
```

```
POST /grpc/trade/submit
```
Submit a signed transaction for a pending trade.

**Request:**
```json
{
  "tradeId": "unique-trade-id",
  "signedTransaction": "base64-signed-tx"
}
```

```
GET /grpc/trade/:tradeId
```
Get trade status and history.

**Response:**
```json
{
  "id": "trade-id",
  "type": "buy",
  "status": "submitted",
  "inputMint": "...",
  "outputMint": "...",
  "bundleId": "jito-uuid",
  "steps": [
    {"name": "blockhash", "status": "success", "data": {...}},
    {"name": "quote", "status": "success", "data": {...}},
    {"name": "bundle_sent", "status": "success", "data": {...}}
  ],
  "createdAt": "...",
  "updatedAt": "..."
}
```

## WebSocket Streams

### Slot Stream
```
wss://<host>/kaldera/slots
```
Streams slot updates from Yellowstone gRPC.

**Messages:**
```json
{"slot": "123456789", "status": 1, "parent": "123456788"}
```

### Bundle Results Stream (New)
```
wss://<host>/grpc/jito/bundle-results
```
Streams Jito bundle results in real-time.

**Messages:**
```json
{
  "bundleId": "uuid",
  "status": "finalized",
  "slot": "123456789",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "details": {...}
}
```

Status values: `finalized`, `processed`, `rejected`, `dropped`

### Transaction Stream
```
wss://<host>/grpc/subscribe/transactions
```
Subscribe to transactions by account addresses.

**Subscribe Message:**
```json
{
  "action": "subscribe",
  "filter": {
    "accountInclude": ["wallet-pubkey", "token-mint"],
    "accountExclude": [],
    "vote": false,
    "failed": false
  },
  "commitment": "confirmed"
}
```

**Transaction Messages:**
```json
{
  "type": "transaction",
  "signature": "base58-signature",
  "slot": "123456789",
  "isVote": false,
  "index": "0",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Account Stream
```
wss://<host>/grpc/subscribe/accounts
```
Subscribe to account changes by address or owner.

**Subscribe Message:**
```json
{
  "action": "subscribe",
  "filter": {
    "account": ["account-pubkey-1", "account-pubkey-2"],
    "owner": ["token-program-id"]
  },
  "commitment": "confirmed"
}
```

**Account Update Messages:**
```json
{
  "type": "account",
  "pubkey": "base58-pubkey",
  "owner": "base58-owner",
  "lamports": "1000000000",
  "slot": "123456789",
  "executable": false,
  "dataLength": 165,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Trade Status Stream
```
wss://<host>/grpc/trade/status
```
Subscribe to real-time trade status updates.

**Subscribe Message:**
```json
{
  "action": "subscribe",
  "tradeId": "your-trade-id"
}
```

**Trade Update Messages:**
```json
{
  "type": "trade_update",
  "tradeId": "...",
  "trade": {
    "id": "...",
    "type": "buy",
    "status": "submitted",
    "step": "sending_bundle",
    "bundleId": "jito-uuid",
    "updatedAt": "..."
  }
}
```

Trade status values: `pending`, `started`, `awaiting_signature`, `submitted`, `failed`

## Performance: gRPC vs HTTP

| Metric | HTTP | gRPC |
|--------|------|------|
| Bundle send latency | 200-500ms | 50-150ms |
| Blockhash retrieval | ~100ms | ~10ms |
| Connection overhead | Per-request | Persistent |
| Confirmation notification | Polling (1-2s) | Stream (<100ms) |

## Documentation

- **[API Reference](docs/API.md)** - Complete API documentation
- **[Examples](examples/client-examples.js)** - Client code examples
- **[Implementation Plan](GRPC_IMPLEMENTATION_PLAN.md)** - Technical architecture

## Quick Start Examples

### Buy Token via gRPC

```javascript
const result = await fetch('http://localhost:3000/grpc/buy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountLamports: 1000000000, // 1 SOL
    slippageBps: 100,
    walletPubkey: 'your-wallet-pubkey',
  }),
});
```

### Subscribe to Trade Status

```javascript
const ws = new WebSocket('ws://localhost:3000/grpc/trade/status');
ws.send(JSON.stringify({ action: 'subscribe', tradeId: 'your-trade-id' }));
ws.onmessage = (e) => console.log('Trade update:', JSON.parse(e.data));
```

### Get Fast Blockhash

```javascript
const result = await fetch('http://localhost:3000/grpc/blockhash');
const { blockhash, lastValidBlockHeight } = await result.json();
```

## License

MIT

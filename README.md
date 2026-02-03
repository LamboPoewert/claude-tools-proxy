# Claude Tools Proxy

Solana RPC proxy with gRPC support for Jito bundles, Yellowstone streaming, and Jupiter swaps.

## Features

- RPC proxy to Constant K
- Jito bundle sending (HTTP + gRPC)
- Yellowstone gRPC slot streaming
- Jito gRPC bundle results streaming
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
Test Kaldera/Yellowstone gRPC connection.

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

## Performance: gRPC vs HTTP

| Metric | HTTP | gRPC |
|--------|------|------|
| Bundle send latency | 200-500ms | 50-150ms |
| Connection overhead | Per-request | Persistent |
| Confirmation notification | Polling | Stream (<100ms) |

## License

MIT

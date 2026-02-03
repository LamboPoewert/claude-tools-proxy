# Claude Tools Proxy - API Documentation

Complete API reference for all gRPC and HTTP endpoints.

## Table of Contents

- [Authentication](#authentication)
- [Health & Status](#health--status)
- [RPC Proxy](#rpc-proxy)
- [Jito HTTP Endpoints](#jito-http-endpoints)
- [Jito gRPC Endpoints](#jito-grpc-endpoints)
- [Yellowstone gRPC Endpoints](#yellowstone-grpc-endpoints)
- [Trade Endpoints](#trade-endpoints)
- [Jupiter Endpoints](#jupiter-endpoints)
- [Metadata Endpoints](#metadata-endpoints)
- [WebSocket Streams](#websocket-streams)
- [Error Handling](#error-handling)

---

## Authentication

Currently, the API does not require authentication. Rate limiting is applied:
- **2000 requests per 15 minutes** per IP address

---

## Health & Status

### GET /

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "Claude Tools Proxy",
  "version": "1.0.0"
}
```

---

## RPC Proxy

### POST /rpc

Proxy JSON-RPC requests to Constant K RPC.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getBalance",
  "params": ["wallet-pubkey"]
}
```

**Response:** Standard Solana JSON-RPC response.

---

## Jito HTTP Endpoints

### POST /jito/bundle

Send a bundle via Jito HTTP API (legacy, use gRPC for better performance).

**Request:**
```json
{
  "transactions": ["base64-tx-1", "base64-tx-2"],
  "encoding": "base64"
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "bundle-uuid"
}
```

### POST /jito/status

Check bundle status.

**Request:**
```json
{
  "bundleIds": ["bundle-uuid-1", "bundle-uuid-2"]
}
```

---

## Jito gRPC Endpoints

### GET /grpc/jito/test

Test Jito gRPC connection health.

**Response:**
```json
{
  "ok": true,
  "connected": true,
  "endpoint": "mainnet.block-engine.jito.wtf:443",
  "authenticated": false,
  "reconnectAttempts": 0,
  "lastError": null,
  "activeSubscribers": 0,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### GET /grpc/jito/status

Get Jito gRPC connection status.

**Response:**
```json
{
  "connected": true,
  "endpoint": "mainnet.block-engine.jito.wtf:443",
  "authenticated": false,
  "reconnectAttempts": 0,
  "lastError": null,
  "activeSubscribers": 2
}
```

### GET /grpc/jito/tip-accounts

Get Jito tip accounts via gRPC.

**Response:**
```json
{
  "accounts": [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"
  ],
  "source": "grpc"
}
```

### GET /grpc/jito/leaders

Get connected validators (leaders).

**Response:**
```json
{
  "leaders": [
    {
      "identity": "validator-pubkey",
      "slots": [123456, 123457, 123458]
    }
  ],
  "count": 10,
  "source": "grpc"
}
```

### GET /grpc/jito/next-leader

Get next scheduled leader.

**Response:**
```json
{
  "currentSlot": 123456,
  "nextLeaderSlot": 123460,
  "nextLeaderIdentity": "validator-pubkey",
  "slotsUntilLeader": 4,
  "source": "grpc"
}
```

### POST /grpc/jito/bundle

Send bundle via Jito gRPC (recommended).

**Request:**
```json
{
  "transactions": [
    "base64-encoded-versioned-transaction-1",
    "base64-encoded-versioned-transaction-2"
  ]
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

**Error Response:**
```json
{
  "error": "Failed to send bundle",
  "code": 14,
  "details": "..."
}
```

---

## Yellowstone gRPC Endpoints

### GET /grpc/yellowstone/test

Test Yellowstone gRPC connection.

**Response:**
```json
{
  "ok": true,
  "slot": "123456789",
  "configured": true,
  "connected": true,
  "endpoint": "grpcs://...",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### GET /grpc/yellowstone/status

Get Yellowstone gRPC connection status.

**Response:**
```json
{
  "configured": true,
  "connected": true,
  "endpoint": "grpcs://...",
  "reconnectAttempts": 0,
  "lastError": null,
  "activeSubscribers": 3
}
```

### GET /grpc/blockhash

Get latest blockhash via gRPC (faster than RPC).

**Query Parameters:**
- `commitment` - `confirmed` (default) or `finalized`

**Response:**
```json
{
  "blockhash": "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
  "lastValidBlockHeight": "123456789",
  "slot": "123456780",
  "commitment": "confirmed",
  "source": "grpc"
}
```

### GET /grpc/slot

Get current slot via gRPC.

**Query Parameters:**
- `commitment` - `confirmed` (default) or `finalized`

**Response:**
```json
{
  "slot": "123456789",
  "commitment": "confirmed",
  "source": "grpc"
}
```

### GET /grpc/block-height

Get current block height via gRPC.

**Response:**
```json
{
  "blockHeight": "123456789",
  "commitment": "confirmed",
  "source": "grpc"
}
```

### POST /grpc/blockhash/valid

Check if blockhash is valid.

**Request:**
```json
{
  "blockhash": "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"
}
```

**Response:**
```json
{
  "blockhash": "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
  "valid": true,
  "slot": "123456789",
  "commitment": "confirmed",
  "source": "grpc"
}
```

---

## Trade Endpoints

### POST /grpc/buy

Execute a buy trade (SOL → Token).

**Request:**
```json
{
  "outputMint": "token-mint-address",
  "amountLamports": 1000000000,
  "slippageBps": 100,
  "walletPubkey": "your-wallet-pubkey",
  "signedTransaction": "base64-signed-tx",
  "tipLamports": 10000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| outputMint | string | Yes | Token mint to buy |
| amountLamports | number | Yes | SOL amount in lamports |
| slippageBps | number | No | Slippage in basis points (default: 100 = 1%) |
| walletPubkey | string | Yes | Wallet public key |
| signedTransaction | string | No | Pre-signed transaction (base64) |
| tipLamports | number | No | Jito tip amount (default: 10000) |

**Response (with signedTransaction):**
```json
{
  "success": true,
  "tradeId": "abc123def456",
  "bundleId": "jito-bundle-uuid",
  "quote": {
    "inAmount": "1000000000",
    "outAmount": "123456789",
    "priceImpactPct": "0.5"
  }
}
```

**Response (without signedTransaction):**
```json
{
  "success": true,
  "tradeId": "abc123def456",
  "status": "awaiting_signature",
  "swapTransaction": "base64-unsigned-transaction",
  "blockhash": "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
  "lastValidBlockHeight": "123456789",
  "quote": {
    "inAmount": "1000000000",
    "outAmount": "123456789",
    "priceImpactPct": "0.5"
  },
  "tipAccount": "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "tipLamports": 10000
}
```

### POST /grpc/sell

Execute a sell trade (Token → SOL).

**Request:**
```json
{
  "inputMint": "token-mint-address",
  "amountTokens": "1000000",
  "slippageBps": 100,
  "walletPubkey": "your-wallet-pubkey",
  "signedTransaction": "base64-signed-tx",
  "tipLamports": 10000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| inputMint | string | Yes | Token mint to sell |
| amountTokens | string | Yes | Token amount (smallest units) |
| slippageBps | number | No | Slippage in basis points (default: 100) |
| walletPubkey | string | Yes | Wallet public key |
| signedTransaction | string | No | Pre-signed transaction (base64) |
| tipLamports | number | No | Jito tip amount (default: 10000) |

### POST /grpc/trade/submit

Submit a signed transaction for a pending trade.

**Request:**
```json
{
  "tradeId": "abc123def456",
  "signedTransaction": "base64-signed-transaction"
}
```

**Response:**
```json
{
  "success": true,
  "tradeId": "abc123def456",
  "bundleId": "jito-bundle-uuid"
}
```

### GET /grpc/trade/:tradeId

Get trade status and history.

**Response:**
```json
{
  "id": "abc123def456",
  "type": "buy",
  "status": "submitted",
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "token-mint-address",
  "amount": 1000000000,
  "walletPubkey": "wallet-pubkey",
  "bundleId": "jito-bundle-uuid",
  "error": null,
  "steps": [
    {
      "name": "blockhash",
      "status": "success",
      "data": { "blockhash": "...", "source": "grpc" },
      "timestamp": "2024-01-01T00:00:00.000Z"
    },
    {
      "name": "quote",
      "status": "success",
      "data": { "inAmount": "...", "outAmount": "..." },
      "timestamp": "2024-01-01T00:00:01.000Z"
    },
    {
      "name": "bundle_sent",
      "status": "success",
      "data": { "uuid": "jito-bundle-uuid" },
      "timestamp": "2024-01-01T00:00:02.000Z"
    }
  ],
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:02.000Z"
}
```

---

## Jupiter Endpoints

### GET /jupiter/quote

Get Jupiter swap quote.

**Query Parameters:**
- `inputMint` - Input token mint
- `outputMint` - Output token mint
- `amount` - Amount in smallest units
- `slippageBps` - Slippage in basis points

**Example:**
```
GET /jupiter/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=100
```

### POST /jupiter/swap

Get Jupiter swap transaction.

**Request:**
```json
{
  "quoteResponse": { /* quote from /jupiter/quote */ },
  "userPublicKey": "wallet-pubkey"
}
```

---

## Metadata Endpoints

### POST /metadata

Create token metadata.

**Request:**
```json
{
  "name": "My Token",
  "symbol": "MTK",
  "description": "A cool token",
  "image": "https://...",
  "twitter": "https://twitter.com/...",
  "telegram": "https://t.me/...",
  "website": "https://..."
}
```

**Response:**
```json
{
  "uri": "https://your-host/metadata/abc123"
}
```

### GET /metadata/:id

Get token metadata JSON.

### POST /metadata/image

Upload an image.

**Request:**
```json
{
  "image": "base64-encoded-image",
  "mimeType": "image/png"
}
```

**Response:**
```json
{
  "url": "https://your-host/metadata/image/abc123"
}
```

### GET /metadata/image/:id

Get uploaded image.

---

## WebSocket Streams

### Slot Stream

**URL:** `wss://<host>/kaldera/slots`

Streams slot updates from Yellowstone gRPC.

**Messages:**
```json
{
  "slot": "123456789",
  "status": 1,
  "parent": "123456788"
}
```

### Jito Bundle Results Stream

**URL:** `wss://<host>/grpc/jito/bundle-results`

Streams Jito bundle results in real-time.

**Messages:**
```json
{
  "bundleId": "uuid",
  "status": "finalized",
  "slot": "123456789",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "details": { ... }
}
```

Status values: `finalized`, `processed`, `rejected`, `dropped`

### Transaction Stream

**URL:** `wss://<host>/grpc/subscribe/transactions`

Subscribe to transactions by account.

**Subscribe:**
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

**Messages:**
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

**URL:** `wss://<host>/grpc/subscribe/accounts`

Subscribe to account changes.

**Subscribe:**
```json
{
  "action": "subscribe",
  "filter": {
    "account": ["account-pubkey"],
    "owner": ["program-id"]
  },
  "commitment": "confirmed"
}
```

**Messages:**
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

**URL:** `wss://<host>/grpc/trade/status`

Subscribe to trade status updates.

**Subscribe:**
```json
{
  "action": "subscribe",
  "tradeId": "your-trade-id"
}
```

**Messages:**
```json
{
  "type": "trade_update",
  "tradeId": "abc123",
  "trade": {
    "id": "abc123",
    "type": "buy",
    "status": "submitted",
    "step": "sending_bundle",
    "bundleId": "jito-uuid",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

## Error Handling

All endpoints return errors in a consistent format:

```json
{
  "error": "Error message",
  "code": "optional-error-code",
  "details": "optional-details"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid parameters |
| 404 | Not Found - Resource not found |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |
| 503 | Service Unavailable - gRPC not configured |

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "No RPC configured" | CONSTANTK_RPC_URL not set | Set environment variable |
| "Yellowstone gRPC not configured" | KALDERA_GRPC_URL not set | Set environment variables |
| "Trade not found" | Invalid tradeId | Check tradeId is correct |
| "Max 5 transactions per bundle" | Too many txs | Split into multiple bundles |

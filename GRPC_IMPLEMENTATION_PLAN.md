# gRPC Implementation Plan for Buy/Sell Transactions

## Overview

This document outlines the plan to implement gRPC for buy and sell transactions in the Claude Tools Proxy. The implementation will leverage two gRPC systems:

1. **Yellowstone gRPC (Geyser)** - For real-time data streaming (already partially implemented)
2. **Jito gRPC (Block Engine)** - For sending transactions with MEV protection

---

## Current State Analysis

### Existing Infrastructure
- Express.js HTTP server with WebSocket support
- Yellowstone gRPC client (`@triton-one/yellowstone-grpc`) - used for slot streaming
- HTTP-based Jito bundle sending via REST API
- Jupiter swap integration via HTTP
- Constant K RPC for standard transaction sending

### Current Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/rpc` | POST | Proxy RPC requests to Constant K |
| `/jito/bundle` | POST | Send Jito bundles via HTTP |
| `/jito/status` | POST | Check bundle status |
| `/helius/send-txs` | POST | Send transactions via RPC |
| `/jupiter/quote` | GET | Get Jupiter swap quotes |
| `/jupiter/swap` | POST | Get Jupiter swap transaction |
| `/kaldera/test` | GET | Test Kaldera gRPC connection |
| `/kaldera/slots` | WS | Stream slot updates |

---

## Proposed gRPC Implementation

### Phase 1: Jito gRPC for Bundle Sending

**Objective**: Replace HTTP-based Jito bundle sending with gRPC for faster, more reliable MEV-protected transactions.

#### Benefits
- **Lower latency**: gRPC uses HTTP/2 with persistent connections and binary serialization
- **Streaming results**: Real-time bundle status updates via subscription
- **Better error handling**: Structured error codes and retry logic built-in
- **Connection management**: Automatic reconnection and health checks

#### New Endpoints
| Endpoint | Type | Purpose |
|----------|------|---------|
| `/grpc/jito/bundle` | POST | Send bundle via gRPC |
| `/grpc/jito/tip-accounts` | GET | Get tip accounts via gRPC |
| `/grpc/jito/leaders` | GET | Get connected leaders |
| `/grpc/jito/next-leader` | GET | Get next scheduled leader |
| `/grpc/jito/bundle-results` | WS | Stream bundle results |

#### Environment Variables (New)
```env
JITO_BLOCK_ENGINE_URL=mainnet.block-engine.jito.wtf:443
JITO_AUTH_KEYPAIR=<optional-base58-private-key>
```

#### Implementation Details
```javascript
// Example: Jito gRPC bundle sending
const { searcherClient, Bundle } = require('jito-ts');

const jitoClient = searcherClient(
  JITO_BLOCK_ENGINE_URL,
  authKeypair // optional for authenticated access
);

// Send bundle
const result = await jitoClient.sendBundle(bundle);

// Subscribe to results
jitoClient.onBundleResult(
  (result) => { /* handle success */ },
  (error) => { /* handle error */ }
);
```

---

### Phase 2: Yellowstone gRPC Transaction Streaming

**Objective**: Enable real-time transaction monitoring for buy/sell positions.

#### Benefits
- **Instant confirmation**: Know immediately when transactions land
- **Position tracking**: Monitor token account changes in real-time
- **Trade execution**: React to market conditions faster than polling

#### New Endpoints
| Endpoint | Type | Purpose |
|----------|------|---------|
| `/grpc/subscribe/transactions` | WS | Stream transactions by account |
| `/grpc/subscribe/accounts` | WS | Stream account changes |
| `/grpc/blockhash` | GET | Get latest blockhash via gRPC |

#### Transaction Subscription Filters
```javascript
// Subscribe to transactions involving specific accounts
const subscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    buy_sell_monitor: {
      accountInclude: [walletPubkey, tokenMintPubkey],
      accountExclude: [],
      accountRequired: [],
      vote: false,
      failed: false,
    }
  },
  transactionsStatus: {},
  blocks: {},
  blocksMeta: {},
  entry: {},
  commitment: CommitmentLevel.CONFIRMED,
  accountsDataSlice: [],
};
```

#### Account Change Monitoring
```javascript
// Monitor token account balances
const subscribeRequest = {
  accounts: {
    token_balance: {
      account: [tokenAccountPubkey],
      owner: [TOKEN_PROGRAM_ID],
      filters: [],
    }
  },
  // ... other fields
};
```

---

### Phase 3: Unified Buy/Sell gRPC Flow

**Objective**: Create optimized buy/sell endpoints that leverage both gRPC systems.

#### New Endpoints
| Endpoint | Type | Purpose |
|----------|------|---------|
| `/grpc/buy` | POST | Execute buy with gRPC optimizations |
| `/grpc/sell` | POST | Execute sell with gRPC optimizations |
| `/grpc/trade/status` | WS | Stream trade execution status |

#### Buy Flow
```
1. Client -> POST /grpc/buy { mint, amount, slippage, wallet }
2. Server: Get latest blockhash via Yellowstone gRPC (faster than RPC)
3. Server: Build Jupiter swap transaction
4. Client signs transaction (or server signs if key provided)
5. Server: Create Jito bundle with tip
6. Server: Send via Jito gRPC
7. Server: Subscribe to bundle result
8. Server: Subscribe to transaction confirmation via Yellowstone
9. Server -> WebSocket: Real-time status updates
10. Server -> Response: { signature, confirmed, tokenBalance }
```

#### Sell Flow
```
1. Client -> POST /grpc/sell { mint, amount, slippage, wallet }
2. Server: Get latest blockhash via Yellowstone gRPC
3. Server: Build Jupiter swap transaction (token -> SOL)
4. Client signs transaction
5. Server: Create Jito bundle with tip
6. Server: Send via Jito gRPC
7. Server: Subscribe to bundle result
8. Server: Subscribe to account changes to verify SOL received
9. Server -> WebSocket: Real-time status updates
10. Server -> Response: { signature, confirmed, solReceived }
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Tools Proxy                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   HTTP API   │    │  WebSocket   │    │   gRPC       │       │
│  │   (Express)  │    │   Server     │    │  Clients     │       │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘       │
│         │                   │                   │                │
│  ┌──────┴───────────────────┴───────────────────┴───────┐       │
│  │                  Service Layer                        │       │
│  ├───────────────────────────────────────────────────────┤       │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │       │
│  │  │ Buy Service │  │Sell Service │  │Monitor Svc  │   │       │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │       │
│  └─────────┼────────────────┼────────────────┼──────────┘       │
│            │                │                │                   │
│  ┌─────────┴────────────────┴────────────────┴──────────┐       │
│  │              gRPC Connection Manager                  │       │
│  │  ┌──────────────────┐  ┌──────────────────┐          │       │
│  │  │  Yellowstone     │  │   Jito Block     │          │       │
│  │  │  gRPC Client     │  │   Engine Client  │          │       │
│  │  └────────┬─────────┘  └────────┬─────────┘          │       │
│  └───────────┼─────────────────────┼────────────────────┘       │
│              │                     │                             │
└──────────────┼─────────────────────┼─────────────────────────────┘
               │                     │
               ▼                     ▼
    ┌──────────────────┐  ┌──────────────────┐
    │  Constant K      │  │  Jito Block      │
    │  Yellowstone     │  │  Engine          │
    │  (Geyser gRPC)   │  │  (gRPC)          │
    └──────────────────┘  └──────────────────┘
```

---

## Implementation Tasks

### Phase 1: Jito gRPC Integration (Priority: High)

- [ ] **1.1** Add `jito-ts` dependency ✅ (completed)
- [ ] **1.2** Create Jito gRPC client wrapper service
- [ ] **1.3** Implement `/grpc/jito/bundle` endpoint
- [ ] **1.4** Implement `/grpc/jito/tip-accounts` endpoint
- [ ] **1.5** Implement `/grpc/jito/leaders` endpoint
- [ ] **1.6** Implement `/grpc/jito/bundle-results` WebSocket
- [ ] **1.7** Add retry logic and error handling
- [ ] **1.8** Add connection health monitoring

### Phase 2: Yellowstone gRPC Enhancements (Priority: Medium)

- [ ] **2.1** Implement transaction subscription endpoint
- [ ] **2.2** Implement account change subscription endpoint
- [ ] **2.3** Add `/grpc/blockhash` endpoint
- [ ] **2.4** Implement connection pooling for multiple subscribers
- [ ] **2.5** Add subscription management (add/remove filters)

### Phase 3: Unified Trade Endpoints (Priority: Medium)

- [ ] **3.1** Implement `/grpc/buy` endpoint
- [ ] **3.2** Implement `/grpc/sell` endpoint
- [ ] **3.3** Implement trade status WebSocket
- [ ] **3.4** Add transaction builder with Jito tip
- [ ] **3.5** Integration testing

### Phase 4: Documentation & Testing (Priority: Low)

- [ ] **4.1** Update README with new endpoints
- [ ] **4.2** Add API documentation
- [ ] **4.3** Create example client code
- [ ] **4.4** Performance benchmarks vs HTTP

---

## Environment Variables Summary

```env
# Existing
CONSTANTK_RPC_URL=https://...
KALDERA_GRPC_URL=grpcs://...
KALDERA_X_TOKEN=...

# New for Jito gRPC
JITO_BLOCK_ENGINE_URL=mainnet.block-engine.jito.wtf:443
JITO_AUTH_KEYPAIR=<base58-private-key>  # Optional for public access
```

---

## API Reference (Proposed)

### POST /grpc/jito/bundle

Send a bundle via Jito gRPC.

**Request:**
```json
{
  "transactions": ["base64-tx-1", "base64-tx-2"],
  "tipLamports": 10000
}
```

**Response:**
```json
{
  "uuid": "bundle-uuid",
  "status": "accepted"
}
```

### GET /grpc/jito/tip-accounts

Get Jito tip accounts.

**Response:**
```json
{
  "accounts": [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"
  ]
}
```

### WS /grpc/jito/bundle-results

Stream bundle results.

**Messages:**
```json
{
  "bundleId": "uuid",
  "status": "finalized|rejected|dropped|processed",
  "slot": 123456789,
  "error": null
}
```

### POST /grpc/buy

Execute a buy transaction.

**Request:**
```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "token-mint-address",
  "amount": 1000000000,
  "slippageBps": 100,
  "walletPubkey": "wallet-address",
  "signedTransaction": "base64-signed-tx"
}
```

**Response:**
```json
{
  "signature": "tx-signature",
  "bundleId": "jito-bundle-uuid",
  "status": "pending"
}
```

### WS /grpc/subscribe/transactions

Subscribe to transactions.

**Subscribe Message:**
```json
{
  "action": "subscribe",
  "filter": {
    "accountInclude": ["wallet-address", "token-mint"],
    "commitment": "confirmed"
  }
}
```

**Update Messages:**
```json
{
  "signature": "tx-signature",
  "slot": 123456789,
  "success": true,
  "accounts": ["account1", "account2"]
}
```

---

## Performance Expectations

| Metric | HTTP (Current) | gRPC (Expected) |
|--------|---------------|-----------------|
| Bundle send latency | 200-500ms | 50-150ms |
| Connection overhead | Per-request | Persistent |
| Confirmation notification | Polling (1-2s) | Stream (<100ms) |
| Data serialization | JSON | Protocol Buffers |
| Multiplexing | No | Yes (HTTP/2) |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| gRPC connection drops | Medium | High | Auto-reconnect with backoff |
| Jito rate limits | Low | Medium | Connection pooling, request queuing |
| Yellowstone unavailable | Low | Medium | Fallback to RPC subscription |
| Auth key compromise | Low | Critical | Env var isolation, key rotation |

---

## Next Steps

1. **Immediate**: Implement Phase 1 (Jito gRPC bundle sending)
2. **Short-term**: Add Phase 2 (Transaction streaming)
3. **Medium-term**: Build Phase 3 (Unified buy/sell)
4. **Ongoing**: Monitor, optimize, and document

---

## References

- [Yellowstone gRPC Documentation](https://docs.triton.one/project-yellowstone/introduction)
- [Jito Block Engine Documentation](https://jito-labs.gitbook.io/mev/)
- [jito-ts SDK](https://www.npmjs.com/package/jito-ts)
- [@triton-one/yellowstone-grpc](https://www.npmjs.com/package/@triton-one/yellowstone-grpc)

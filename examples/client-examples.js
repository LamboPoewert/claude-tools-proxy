/**
 * Claude Tools Proxy - Client Examples
 * 
 * Examples showing how to use the gRPC endpoints for buy/sell transactions.
 * 
 * Prerequisites:
 * - npm install @solana/web3.js bs58 ws
 */

const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const WebSocket = require('ws');

// Configuration
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3000';
const PROXY_WS_URL = process.env.PROXY_WS_URL || 'ws://localhost:3000';

// Helper: Make HTTP request
async function request(endpoint, options = {}) {
  const url = `${PROXY_URL}${endpoint}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return response.json();
}

// ============================================================================
// EXAMPLE 1: Get gRPC Status
// ============================================================================
async function checkGrpcStatus() {
  console.log('\n=== Example 1: Check gRPC Status ===\n');
  
  // Check Jito gRPC
  const jitoStatus = await request('/grpc/jito/test');
  console.log('Jito gRPC:', jitoStatus.ok ? '✓ Connected' : '✗ Not connected');
  console.log('  Endpoint:', jitoStatus.endpoint);
  
  // Check Yellowstone gRPC
  const yellowstoneStatus = await request('/grpc/yellowstone/test');
  console.log('Yellowstone gRPC:', yellowstoneStatus.ok ? '✓ Connected' : '✗ Not connected');
  if (yellowstoneStatus.slot) {
    console.log('  Current slot:', yellowstoneStatus.slot);
  }
}

// ============================================================================
// EXAMPLE 2: Get Fast Blockhash via gRPC
// ============================================================================
async function getBlockhash() {
  console.log('\n=== Example 2: Get Blockhash via gRPC ===\n');
  
  const start = Date.now();
  const result = await request('/grpc/blockhash');
  const latency = Date.now() - start;
  
  console.log('Blockhash:', result.blockhash);
  console.log('Last valid block height:', result.lastValidBlockHeight);
  console.log('Slot:', result.slot);
  console.log('Latency:', latency, 'ms');
  console.log('Source:', result.source);
  
  return result;
}

// ============================================================================
// EXAMPLE 3: Get Jito Tip Accounts
// ============================================================================
async function getTipAccounts() {
  console.log('\n=== Example 3: Get Jito Tip Accounts ===\n');
  
  const result = await request('/grpc/jito/tip-accounts');
  
  console.log('Tip accounts:');
  result.accounts.forEach((account, i) => {
    console.log(`  ${i + 1}. ${account}`);
  });
  
  return result.accounts;
}

// ============================================================================
// EXAMPLE 4: Get Next Leader
// ============================================================================
async function getNextLeader() {
  console.log('\n=== Example 4: Get Next Scheduled Leader ===\n');
  
  const result = await request('/grpc/jito/next-leader');
  
  console.log('Current slot:', result.currentSlot);
  console.log('Next leader slot:', result.nextLeaderSlot);
  console.log('Slots until leader:', result.slotsUntilLeader);
  console.log('Leader identity:', result.nextLeaderIdentity);
  
  return result;
}

// ============================================================================
// EXAMPLE 5: Execute Buy Trade (Get Quote Only)
// ============================================================================
async function executeBuyQuoteOnly(walletPubkey, tokenMint, solAmount) {
  console.log('\n=== Example 5: Execute Buy (Quote Only) ===\n');
  
  const amountLamports = solAmount * 1e9; // Convert SOL to lamports
  
  const result = await request('/grpc/buy', {
    method: 'POST',
    body: JSON.stringify({
      outputMint: tokenMint,
      amountLamports,
      slippageBps: 100, // 1% slippage
      walletPubkey,
      // No signedTransaction - returns unsigned tx
    }),
  });
  
  if (result.success) {
    console.log('Trade ID:', result.tradeId);
    console.log('Status:', result.status);
    console.log('Quote:');
    console.log('  In:', result.quote.inAmount, 'lamports');
    console.log('  Out:', result.quote.outAmount, 'tokens');
    console.log('  Price impact:', result.quote.priceImpactPct, '%');
    console.log('Blockhash:', result.blockhash);
    console.log('Tip account:', result.tipAccount);
    console.log('\nTo complete: Sign the swapTransaction and call /grpc/trade/submit');
  } else {
    console.log('Error:', result.error);
  }
  
  return result;
}

// ============================================================================
// EXAMPLE 6: Execute Buy Trade (Full Flow with Signing)
// ============================================================================
async function executeBuyWithSigning(secretKey, tokenMint, solAmount) {
  console.log('\n=== Example 6: Execute Buy (Full Flow) ===\n');
  
  // Create keypair from secret key
  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  const walletPubkey = keypair.publicKey.toBase58();
  const amountLamports = solAmount * 1e9;
  
  console.log('Wallet:', walletPubkey);
  console.log('Buying token:', tokenMint);
  console.log('Amount:', solAmount, 'SOL');
  
  // Step 1: Get unsigned transaction
  console.log('\n1. Getting quote and unsigned transaction...');
  const buyResult = await request('/grpc/buy', {
    method: 'POST',
    body: JSON.stringify({
      outputMint: tokenMint,
      amountLamports,
      slippageBps: 100,
      walletPubkey,
    }),
  });
  
  if (!buyResult.success) {
    console.log('Error:', buyResult.error);
    return;
  }
  
  console.log('Trade ID:', buyResult.tradeId);
  console.log('Quote:', buyResult.quote.inAmount, '->', buyResult.quote.outAmount);
  
  // Step 2: Deserialize and sign transaction
  console.log('\n2. Signing transaction...');
  const swapTxBuffer = Buffer.from(buyResult.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTxBuffer);
  transaction.sign([keypair]);
  
  const signedTx = Buffer.from(transaction.serialize()).toString('base64');
  console.log('Transaction signed');
  
  // Step 3: Submit signed transaction
  console.log('\n3. Submitting to Jito via gRPC...');
  const submitResult = await request('/grpc/trade/submit', {
    method: 'POST',
    body: JSON.stringify({
      tradeId: buyResult.tradeId,
      signedTransaction: signedTx,
    }),
  });
  
  if (submitResult.success) {
    console.log('Bundle ID:', submitResult.bundleId);
    console.log('Trade submitted successfully!');
  } else {
    console.log('Error:', submitResult.error);
  }
  
  return submitResult;
}

// ============================================================================
// EXAMPLE 7: Execute Sell Trade
// ============================================================================
async function executeSell(walletPubkey, tokenMint, tokenAmount) {
  console.log('\n=== Example 7: Execute Sell ===\n');
  
  const result = await request('/grpc/sell', {
    method: 'POST',
    body: JSON.stringify({
      inputMint: tokenMint,
      amountTokens: tokenAmount.toString(),
      slippageBps: 100,
      walletPubkey,
    }),
  });
  
  if (result.success) {
    console.log('Trade ID:', result.tradeId);
    console.log('Status:', result.status);
    console.log('Quote:');
    console.log('  In:', result.quote.inAmount, 'tokens');
    console.log('  Out:', result.quote.outAmount, 'lamports');
    console.log('  SOL received:', parseInt(result.quote.outAmount) / 1e9, 'SOL');
  } else {
    console.log('Error:', result.error);
  }
  
  return result;
}

// ============================================================================
// EXAMPLE 8: Get Trade Status
// ============================================================================
async function getTradeStatus(tradeId) {
  console.log('\n=== Example 8: Get Trade Status ===\n');
  
  const result = await request(`/grpc/trade/${tradeId}`);
  
  if (result.error) {
    console.log('Error:', result.error);
    return;
  }
  
  console.log('Trade ID:', result.id);
  console.log('Type:', result.type);
  console.log('Status:', result.status);
  console.log('Bundle ID:', result.bundleId || 'N/A');
  console.log('\nSteps:');
  result.steps.forEach(step => {
    console.log(`  ${step.name}: ${step.status}`);
  });
  
  return result;
}

// ============================================================================
// EXAMPLE 9: WebSocket - Subscribe to Trade Status
// ============================================================================
function subscribeToTradeStatus(tradeId) {
  console.log('\n=== Example 9: Subscribe to Trade Status ===\n');
  
  const ws = new WebSocket(`${PROXY_WS_URL}/grpc/trade/status`);
  
  ws.on('open', () => {
    console.log('Connected to trade status stream');
    
    // Subscribe to trade
    ws.send(JSON.stringify({
      action: 'subscribe',
      tradeId,
    }));
  });
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Update:', msg);
    
    if (msg.trade?.status === 'submitted' || msg.trade?.status === 'failed') {
      console.log('Trade completed, closing connection');
      ws.close();
    }
  });
  
  ws.on('error', (err) => {
    console.log('WebSocket error:', err.message);
  });
  
  ws.on('close', () => {
    console.log('WebSocket closed');
  });
  
  return ws;
}

// ============================================================================
// EXAMPLE 10: WebSocket - Subscribe to Transactions
// ============================================================================
function subscribeToTransactions(accounts) {
  console.log('\n=== Example 10: Subscribe to Transactions ===\n');
  
  const ws = new WebSocket(`${PROXY_WS_URL}/grpc/subscribe/transactions`);
  
  ws.on('open', () => {
    console.log('Connected to transaction stream');
    
    // Subscribe to transactions
    ws.send(JSON.stringify({
      action: 'subscribe',
      filter: {
        accountInclude: accounts,
        vote: false,
        failed: false,
      },
      commitment: 'confirmed',
    }));
  });
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'subscribed') {
      console.log('Subscribed successfully');
    } else if (msg.type === 'transaction') {
      console.log('Transaction:', msg.signature);
      console.log('  Slot:', msg.slot);
    }
  });
  
  ws.on('error', (err) => {
    console.log('WebSocket error:', err.message);
  });
  
  // Return ws so caller can close it
  return ws;
}

// ============================================================================
// EXAMPLE 11: WebSocket - Subscribe to Account Changes
// ============================================================================
function subscribeToAccounts(accounts) {
  console.log('\n=== Example 11: Subscribe to Account Changes ===\n');
  
  const ws = new WebSocket(`${PROXY_WS_URL}/grpc/subscribe/accounts`);
  
  ws.on('open', () => {
    console.log('Connected to account stream');
    
    // Subscribe to accounts
    ws.send(JSON.stringify({
      action: 'subscribe',
      filter: {
        account: accounts,
      },
      commitment: 'confirmed',
    }));
  });
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'subscribed') {
      console.log('Subscribed successfully');
    } else if (msg.type === 'account') {
      console.log('Account update:', msg.pubkey);
      console.log('  Lamports:', msg.lamports);
      console.log('  Slot:', msg.slot);
    }
  });
  
  ws.on('error', (err) => {
    console.log('WebSocket error:', err.message);
  });
  
  return ws;
}

// ============================================================================
// EXAMPLE 12: Send Bundle via Jito gRPC
// ============================================================================
async function sendBundle(signedTransactions) {
  console.log('\n=== Example 12: Send Bundle via Jito gRPC ===\n');
  
  const start = Date.now();
  const result = await request('/grpc/jito/bundle', {
    method: 'POST',
    body: JSON.stringify({
      transactions: signedTransactions, // Array of base64 encoded transactions
    }),
  });
  const latency = Date.now() - start;
  
  if (result.uuid) {
    console.log('Bundle UUID:', result.uuid);
    console.log('Status:', result.status);
    console.log('Transaction count:', result.transactionCount);
    console.log('Latency:', result.latencyMs || latency, 'ms');
    console.log('Source:', result.source);
  } else {
    console.log('Error:', result.error);
  }
  
  return result;
}

// ============================================================================
// MAIN: Run Examples
// ============================================================================
async function main() {
  console.log('Claude Tools Proxy - Client Examples');
  console.log('====================================');
  console.log('Proxy URL:', PROXY_URL);
  
  try {
    // Basic status checks
    await checkGrpcStatus();
    await getBlockhash();
    await getTipAccounts();
    await getNextLeader();
    
    // Example buy (quote only - no actual trade)
    // Replace with a real wallet and token mint to test
    const EXAMPLE_WALLET = 'YourWalletPubkeyHere';
    const EXAMPLE_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
    
    console.log('\n--- Trade Examples (disabled by default) ---');
    console.log('Uncomment the lines below to test trades');
    
    // Uncomment to test:
    // await executeBuyQuoteOnly(EXAMPLE_WALLET, EXAMPLE_TOKEN, 0.1);
    // await executeSell(EXAMPLE_WALLET, EXAMPLE_TOKEN, '1000000');
    
    // Full buy with signing (requires real secret key):
    // const SECRET_KEY = 'your-base58-secret-key';
    // await executeBuyWithSigning(SECRET_KEY, EXAMPLE_TOKEN, 0.1);
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

// Export functions for use as module
module.exports = {
  checkGrpcStatus,
  getBlockhash,
  getTipAccounts,
  getNextLeader,
  executeBuyQuoteOnly,
  executeBuyWithSigning,
  executeSell,
  getTradeStatus,
  subscribeToTradeStatus,
  subscribeToTransactions,
  subscribeToAccounts,
  sendBundle,
};

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

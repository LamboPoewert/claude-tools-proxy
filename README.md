# Claude Tools Bundler - Desktop App

Windows/Mac/Linux desktop application for launching pump.fun tokens with bundled buys.

## Features

- 🖥️ Full GUI interface (no terminal needed)
- 🔑 Wallet generation and management
- 💸 Fund wallets from master
- 🚀 Bundle launch with Jito
- 💰 Auto-sell options
- 📊 Real-time status updates

## Installation

### Prerequisites
- Node.js 18+ installed
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm start
```

### Build Windows .exe

```bash
npm run build:win
```

This creates `Claude Tools Bundler.exe` in the `dist` folder.

### Build for Mac

```bash
npm run build:mac
```

### Build for Linux

```bash
npm run build:linux
```

## Usage

1. **Configure** - Enter your Helius API key and master wallet private key
2. **Generate Wallets** - Create 10-20 bundle wallets
3. **Fund Wallets** - Send SOL to each wallet
4. **Bundle Launch** - Deploy token + bundled buys
5. **Sell** - Exit positions
6. **Collect** - Return SOL to master

## Fee Structure

- **1% fee** on every bundle transaction
- Fee sent to: `2sLRH2hXzg4XKp7SdX3aLMfWh1ZdiBqiAdh2PePX5L9T`

## Requirements

- **Helius API Key** - Get from [helius.dev](https://helius.dev)
- **Master Wallet** - Solana wallet with SOL for operations
- **Token Metadata** - Upload to IPFS before launching

## Security

- Private keys are stored locally only
- Never shared over network
- Wallets saved in app data folder

## Troubleshooting

**App won't start:**
- Make sure Node.js 18+ is installed
- Run `npm install` again

**Build fails:**
- Windows: May need Visual Studio Build Tools
- Mac: May need Xcode Command Line Tools

**Transactions fail:**
- Check Helius API key is valid
- Ensure master wallet has enough SOL
- Try increasing Jito tip

## License

MIT

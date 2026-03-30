# Solana Token Finder

Monitors Solana in real-time for new token deployments and sends 3-stage Telegram alerts.

---

## Setup

### 1. Get a free Helius RPC key
1. Go to **https://helius.dev**
2. Click **Get Started Free** — no credit card needed
3. Create a project → copy your **API Key**

### 2. Create a Telegram Bot
1. Open Telegram → search **@BotFather** → send `/newbot`
2. Follow the steps → copy your **Bot Token**
3. Start your bot (click the link BotFather gives you)
4. Get your **Chat ID**: message **@userinfobot** on Telegram → it replies with your ID

### 3. Configure
```bash
cp .env.example .env
```
Open `.env` and fill in:
```
RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
RPC_WS_ENDPOINT=wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY

TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 4. Install & Run
```bash
npm install
npm run dev
```

---

## How it works

### 3-Stage Notifications

| Stage | When | What you get |
|-------|------|-------------|
| 🟢 Stage 1 | Token is created on-chain | Mint address, name, symbol, socials, links |
| 🟡 Stage 2 | Supply starts spreading to wallets | Holder count + % breakdown of top 10 wallets |
| 🔴 Stage 3 | Distribution matches your pattern | Side-by-side comparison of actual vs your target |

### What it monitors
- **Pump.fun** — catches `create` instruction at the exact moment of deployment (before any buys)
- **Traditional SPL / Token-2022** — catches `InitializeMint` before LP is even added
- **Raydium** — catches new pool creation (first moment a traditional token gets liquidity)
- **Other launchpads** — Moonshot, Boop.fun, Meteora Launchpad, Believe.app

---

## Filters (in .env)

### Find specific tokens by name / ticker
```
FILTER_NAME_KEYWORDS=pepe,trump,ai,dog
```
Only alert when the token name or symbol contains any of these words.

### Require social links
```
REQUIRE_SOCIALS=true
```
Only alert if the token has at least one social (Twitter / Telegram / Website).
**Note:** This only applies to launchpad tokens (Pump.fun, Moonshot, Boop, etc.) since
traditional SPL tokens don't attach socials at creation time.

### Filter by Twitter / Telegram handle content
```
FILTER_TWITTER_KEYWORDS=pepe
FILTER_TELEGRAM_KEYWORDS=official
```

---

## Distribution Pattern (Stage 3)

After detecting a token, the system watches it every 15 seconds and checks
how supply is being distributed across wallets.

**Example:** You expect a token to be distributed like this:
- Wallet 1 holds ~20%
- Wallet 2 holds ~12%
- Wallet 3 holds ~10%
- Wallet 4 holds ~8%
- Wallet 5 holds ~5%

Set in `.env`:
```
DISTRIBUTION_PATTERN=20,12,10,8,5
DISTRIBUTION_TOLERANCE=5
```

`DISTRIBUTION_TOLERANCE=5` means each slot is allowed ±5% deviation.
So wallet 1 needs to be between 15%–25% to match the 20% target.

### Stage 2 threshold
```
DISTRIBUTION_STAGE2_MIN_HOLDERS=3
```
Stage 2 fires when at least 3 different wallets hold the token.

---

## Example .env (fully configured)

```env
RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=abc123
RPC_WS_ENDPOINT=wss://mainnet.helius-rpc.com/?api-key=abc123

TELEGRAM_BOT_TOKEN=7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=123456789

MONITOR_PUMPFUN=true
MONITOR_TRADITIONAL=true
MONITOR_RAYDIUM=true
MONITOR_LAUNCHPADS=true

FILTER_NAME_KEYWORDS=pepe,dog,cat
REQUIRE_SOCIALS=false

DISTRIBUTION_PATTERN=20,12,10,8,5,5,3,3,2,1
DISTRIBUTION_TOLERANCE=5
DISTRIBUTION_STAGE2_MIN_HOLDERS=3
DISTRIBUTION_POLL_INTERVAL_MS=15000
```

---

## Adding a custom launchpad

If a new launchpad launches and you want to watch it:
```
CUSTOM_LAUNCHPAD_PROGRAMS=ProgramId1111111111111111111111111,ProgramId222222
```

The system will watch those program IDs and extract any new token mints from their transactions.

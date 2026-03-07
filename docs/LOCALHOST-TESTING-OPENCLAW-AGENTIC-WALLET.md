# Localhost Testing: OpenClaw + Agentic Wallet + CRE

This guide walks you through testing the price-alerts flow on localhost with OpenClaw and Agentic Wallet (agent pays via x402), then running the CRE workflow.

---

## 1. Start the x402-cre server

**Terminal 1** – from repo root:

```bash
cd ~/x402-cre-price-alerts
npm run dev:server
```

- Server runs at **http://localhost:3000**
- Endpoints: `POST /chat` (no payment), `POST /alerts` (x402 $0.01 USDC)
- For localhost testing you don’t need `SERVER_BASE_URL` in `.env`; it defaults to `http://localhost:3000`.

Leave this running.

---

## 2. Start OpenClaw gateway (so the agent can run)

**Terminal 2**:

```bash
openclaw gateway
```

- Gateway runs (default port 18789).
- Optional: `openclaw dashboard` to open the Control UI in the browser.

---

## 3. Add Agentic Wallet so the agent can pay (x402)

The agent must be able to pay for `POST /alerts` using Agentic Wallet’s pay-for-service (x402).

1. **Install Agentic Wallet skills** (if your OpenClaw setup uses the CDP skills repo):
   ```bash
   npx skills add coinbase/agentic-wallet-skills
   ```
   Or follow the [Agentic Wallet quickstart](https://docs.cdp.coinbase.com/agentic-wallet/quickstart) and link the wallet to your agent.

2. **Authenticate the wallet** (one-time):
   ```bash
   npx awal status
   ```
   If not authenticated, complete the flow (e.g. email OTP) so the agent has a funded wallet on Base (or Base Sepolia for testnet).

3. **Ensure the agent has the “pay-for-service” skill** so it can call a URL with x402 payment. In OpenClaw this may be configured via skills, tools, or the Control UI.

---

## 4. Connect OpenClaw to the price-alerts API (localhost)

The agent needs to:

1. **Call `/chat`** for natural language → e.g. “Create an alert when BTC is greater than 60000”.
2. **Read the JSON response** – it now contains `paymentByAgent: true`, `alertsUrl`, and `alertPayload`.
3. **Call pay-for-service** toward `alertsUrl` (`http://localhost:3000/alerts`) with body `alertPayload` so the **agent wallet** pays the $0.01 USDC via x402.

**Option A – OpenClaw tool/skill that calls the server**

- Add a **tool** (or skill) that:
  - **Step 1:** `POST http://localhost:3000/chat` with `{"message": "<user message>"}`.
  - **Step 2:** If the response has `paymentByAgent === true`, call the Agentic Wallet **pay-for-service** skill with:
    - URL: `response.alertsUrl` (e.g. `http://localhost:3000/alerts`)
    - Method: POST  
    - Body: `response.alertPayload`
- When the user says “Create an alert when BTC is greater than 60000”, the agent uses this tool; step 1 gets the payload, step 2 pays with the agent wallet and creates the alert.

**Option B – Manual test without OpenClaw**

1. Get payload from `/chat`:
   ```bash
   curl -s -X POST http://localhost:3000/chat \
     -H "Content-Type: application/json" \
     -d '{"message":"Create an alert when BTC is greater than 60000"}' | jq .
   ```
   You should see `paymentByAgent: true`, `alertsUrl`, `alertPayload`.

2. Pay with Agentic Wallet (awal) toward that URL/body. If `awal` supports pay-for-service for a custom URL:
   ```bash
   # Example (syntax depends on Agentic Wallet CLI)
   npx awal pay-for-service http://localhost:3000/alerts --method POST --body '{"asset":"BTC","condition":"gt","targetPriceUsd":60000}'
   ```
   Or use the Agentic Wallet docs for the exact “pay for API call” command.

---

## 5. Start CRE (write alerts on-chain + cron)

CRE has two triggers: **HTTP** (write alert to RuleRegistry) and **Cron** (check prices, send notifications).

### Fix CRE CLI if broken

If `cre workflow simulate ...` fails (e.g. “Not: command not found”):

1. Remove the broken binary (requires sudo):
   ```bash
   sudo rm /usr/local/bin/cre
   ```
2. Reinstall from the official docs: [CRE CLI installation](https://docs.chain.link/cre/getting-started/cli-installation).

### Run CRE workflow simulate (HTTP trigger – write alert on-chain)

After an alert is created (via agent paying `/alerts`), the server logs the **CRE payload** in the response. Use it in the HTTP trigger:

**Terminal 3**:

```bash
cd ~/x402-cre-price-alerts/cre
cre workflow simulate alerts --env ../.env --broadcast
```

When prompted:

1. Select **HTTP trigger** (option 2).
2. Paste the CRE payload JSON, e.g.:
   ```json
   {"id":"<alert-id>","asset":"BTC","condition":"gt","targetPriceUsd":60000,"createdAt":<timestamp>}
   ```
   Get this from the **server response** after the agent successfully calls `POST /alerts` (the response includes the created `alert` with `id`; the CRE payload is that alert plus `createdAt`).

3. The workflow writes the alert to the RuleRegistry contract on Base Sepolia.

### Run CRE Cron trigger (price checks + Pushover)

Same command, choose **Cron trigger** (option 1) when prompted. The workflow will use your config (e.g. `cre/alerts/config.staging.json`) to read rules from the contract, fetch prices, and send Pushover notifications when conditions are met.

---

## 6. End-to-end flow (localhost)

| Step | Who / What |
|------|------------|
| 1 | Start server: `npm run dev:server` (Terminal 1). |
| 2 | Start OpenClaw: `openclaw gateway` (Terminal 2). |
| 3 | In OpenClaw (dashboard or chat), send: “Create an alert when BTC is greater than 60000”. |
| 4 | Agent calls `POST /chat` → server returns `alertsUrl` + `alertPayload` + `paymentByAgent: true`. |
| 5 | Agent uses Agentic Wallet pay-for-service → `POST http://localhost:3000/alerts` with `alertPayload` + x402 payment. |
| 6 | Server creates alert and returns `alert` (with `id`) and CRE payload in logs. |
| 7 | (Optional) Run CRE simulate → HTTP trigger → paste CRE payload → alert written on-chain. |
| 8 | (Optional) Run CRE simulate → Cron trigger → prices checked, notifications sent when condition met. |

---

## 7. Troubleshooting

- **Agent can’t reach localhost**  
  OpenClaw and the server must be on the same machine, or you must expose the server (e.g. ngrok) and set `SERVER_BASE_URL` in `.env`.

- **Payment fails (402 / x402)**  
  Ensure Agentic Wallet is authenticated (`npx awal status`) and has USDC on the correct network (Base Sepolia for testnet). Server must use the same network (e.g. x402 facilitator for Base Sepolia).

- **CRE CLI missing or broken**  
  Remove `/usr/local/bin/cre` and reinstall from [CRE CLI installation](https://docs.chain.link/cre/getting-started/cli-installation).

- **OpenClaw doesn’t have pay-for-service**  
  Install and enable Agentic Wallet skills for OpenClaw (see [Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/welcome)) and ensure the agent’s tool/skill set includes calling the price-alerts `/alerts` URL with x402.

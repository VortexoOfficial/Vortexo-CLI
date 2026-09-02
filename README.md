# VortexoFun CLI — User Guide

An offline, terminal-only way to use VortexoFun — deposit, withdraw, and become a relayer — without needing the website. Useful as a backup if vortexo.fun is ever unreachable, or if you just prefer the terminal.

Everything is interactive by default: run a command with no flags and the script asks you questions one at a time. Every question can also be answered in advance with a flag, for scripting.

---

## 1. Requirements

- **Node.js** installed (v18 or newer recommended)
- The script's dependencies installed once:
  ```
  npm install ethers circomlibjs snarkjs
  ```
- An **RPC URL** for whichever chain you're using (e.g. from Infura, Alchemy, a public RPC, or your own node)
- A **private key** — only needed for depositing, for withdrawing yourself, and for registering as a relayer. Withdrawing *through* a relayer needs no private key at all.

Supported chains out of the box:

| Chain | Chain ID |
|---|---|
| Ethereum Mainnet | 1 |
| BNB Smart Chain | 56 |
| Arbitrum One | 42161 |
| Base | 8453 |

---

## 2. Security — read this first

- Your private key is **only held in memory** for the current run. It is never written to disk and never sent anywhere except as part of a transaction you sign locally and broadcast to the RPC you provide.
- Your **note** (the secret proving your deposit) is also never sent over the network — it only leaves your machine as a zero-knowledge proof, never in raw form.
- The script pastes your key visibly in the terminal as you type it (so you can double-check it) — make sure nobody is looking over your shoulder or recording your screen.
- **Save your deposit note somewhere safe.** If you lose it, the deposited funds are unrecoverable — there is no "forgot password" option. Anyone who gets your note can withdraw your funds, so treat it like a private key.

---

## 3. Quick start

```
node vortexo-cli.js deposit
node vortexo-cli.js withdraw
node vortexo-cli.js register
```

Run the script with no command at all to see a built-in summary:

```
node vortexo-cli.js
```

---

## 4. For normal users

### 4.1 Depositing

```
node vortexo-cli.js deposit
```

Walkthrough:

1. **Pick an amount** from the menu — 0.1 / 1 / 10 / 100 ETH.
2. **Pick a chain** — the correct contract address is filled in automatically.
3. **Enter an RPC URL** for that chain.
4. **Paste your private key** (starts with `0x`; if you paste it without the `0x`, the script adds it for you).
5. The script generates a **note**, prints it to the screen, **saves it to a file**, and submits the deposit transaction.

> ⚠️ Back up the printed/saved note immediately — it's the only way to withdraw later.

**Skip prompts with flags:**

```
node vortexo-cli.js deposit --denom 2 --chain 8453 --rpc https://mainnet.base.org --key 0xabc123...
```

### 4.2 Withdrawing

```
node vortexo-cli.js withdraw
```

Walkthrough:

1. **Paste your note.**
2. **Pick a chain** (contract auto-filled).
3. **Enter the recipient address** — where the funds should be sent.
4. **Choose how to withdraw:**
   - **Withdraw myself** — you pay gas directly, so you need a private key + some native token (ETH/BNB) for gas in that wallet.
   - **Withdraw via relayer** — no gas, no private key needed at all. The script:
     - reads the on-chain relayer registry,
     - health-checks every relayer's server,
     - shows you a list sorted by lowest fee first,
     - you pick one, it handles the rest.
5. **Enter an RPC URL** (needed either way — see note below).
6. If self-withdrawing: paste your private key.

The script builds the zero-knowledge proof and submits the withdrawal — via your own wallet, or via the relayer's server if you chose that route.

> **Note:** an RPC URL is required in *both* modes, because the script needs to read the current Merkle root and relayer list from the chain regardless of who ends up paying gas. In relayer mode, you still don't need a private key or any ETH balance — the RPC is only used for reads.

**Skip prompts with flags:**

```
node vortexo-cli.js withdraw --note "vortexofun-zk-v1:..." --chain 8453 --recipient 0xAbC... --rpc https://mainnet.base.org --relayer-url https://relay.example.com
```

Example relayer-mode session:

```
$ node vortexo-cli.js withdraw

Note: vortexofun-zk-v1:8f2a91c3...

Which chain?
  1) Ethereum Mainnet (chain 1)
  2) BNB Smart Chain (chain 56)
  3) Arbitrum One (chain 42161)
  4) Base (chain 8453)
Choice [1-4]: 4

Address to receive the funds: 0xAbC123...789

  1) Withdraw myself
  2) Withdraw via relayer — relayer pays gas, I pay a small fee automatically (no gas needed)
Choice [1-2]: 2

Which relayer?
  1) 0x9F3a...11cD — fee 0.1% — https://relay-a.example.com
  2) 0x22Bb...44Ef — fee 0.2% — https://relay-b.example.com
Choice [1-2]: 1

RPC URL: https://mainnet.base.org

Building proof...
Relayer fee: 0.001 ETH (0.1%) — no gas needed from you
Submitting to relayer...
✅ Withdrawal confirmed.
```

---

## 5. For relayers

Relayers earn a fee (0.1% / 0.2% / 0.3%, their choice) every time someone routes a withdrawal through them. Becoming one has two parts: **registering on-chain** (this CLI) and **running the relayer server** that actually receives and submits withdrawal requests (separate `relayer/index.js` process, run continuously).

### 5.1 Registering as a relayer

```
node vortexo-cli.js register
```

Walkthrough:

1. **Pick a chain.**
2. The script reads the **one-time registration fee** from the contract and shows it to you.
3. **Pick your fee tier** — 0.1%, 0.2%, or 0.3% (this is what you'll earn per withdrawal).
4. **Enter your relayer server's HTTPS URL** — e.g. `https://relayer.yourdomain.com`. This must be a live, reachable HTTPS endpoint (see 5.2).
5. **Paste your private key** — pays the one-time registration fee and becomes your relayer identity.
6. The script submits the registration transaction. Your address, fee tier, and endpoint are now stored on-chain, and you'll automatically start showing up in other users' relayer lists.

> The registration fee is paid into the contract itself (not directly to a person) and can be withdrawn by the contract owner at any time — this doesn't affect you as a relayer.

**Skip prompts with flags:**

```
node vortexo-cli.js register --chain 8453 --tier 2 --endpoint https://relayer.yourdomain.com --key 0xabc123...
```

After registering, the CLI reminds you:

```
Run relayer/index.js with RELAYER_FEE_TIER=2 and this same private key to start earning.
```

### 5.2 Exposing your relayer server (no port-forwarding needed)

You do **not** need to open ports 80/443 on your router or manage TLS certificates. The simplest approach:

1. Run your relayer server locally, e.g. on `localhost:3001`.
2. Run a tunnel in front of it (Cloudflare Tunnel is a common choice):
   ```
   cloudflared tunnel --url http://localhost:3001
   ```
3. This gives you a public **HTTPS** URL with no open inbound port on your machine — the tunnel is an outbound connection only.
4. Use that HTTPS URL as your `--endpoint` when registering.

Any hosting method works as long as it's HTTPS and reachable — a tunnel, your own domain with a directly opened port, or any other proxy. The contract only stores the URL string; it doesn't care how it's served.

A few practical notes:
- A free/quick Cloudflare tunnel gets a **new random hostname** every restart — fine for testing, but you'd need to call `updateRelayerEndpoint()` (or re-register) each time. For a relayer people will actually route through, use a **named tunnel** on your own domain so the URL stays stable.
- Your relayer's uptime is checked live: the withdraw-side CLI calls `GET {endpoint}/health` and verifies it matches your registered address before showing you in anyone's list. If your server or tunnel is down, you're silently skipped — no error shown to the user, you just won't appear.
- The relayer server's private key (used to pay gas on withdrawals) is separate from any user's wallet — withdrawing users never send their private key to your relayer, only the note/proof.

### 5.3 Managing your relayer

These aren't in this CLI's three commands, but are available as direct contract calls (e.g. via a block explorer's "Write Contract" tab) once registered:

| Action | Contract function |
|---|---|
| Change your fee tier | `updateRelayerFee(uint8 feeTier)` |
| Change your endpoint URL | `updateRelayerEndpoint(string endpoint)` |
| Temporarily stop receiving withdrawals | `deactivateRelayer()` |
| Resume | `reactivateRelayer()` |

---

## 6. Flags reference

| Flag | Used by | Meaning |
|---|---|---|
| `--denom` | deposit | Denomination: `1`=0.1 ETH, `2`=1 ETH, `3`=10 ETH, `4`=100 ETH |
| `--chain` | all | Chain ID (e.g. `1`, `56`, `42161`, `8453`) |
| `--contract` | all | Override contract address (needed if `--chain` isn't in the built-in list) |
| `--rpc` | all | RPC URL for the chosen chain |
| `--recipient` | withdraw | Address to receive withdrawn funds |
| `--note` | withdraw | Your deposit note |
| `--key` | deposit, withdraw (self), register | Private key (with or without `0x` prefix) |
| `--relayer-url` | withdraw | Skip relayer selection and use a specific relayer URL directly |
| `--tier` | register | Fee tier: `1` (0.1%), `2` (0.2%), or `3` (0.3%) |
| `--endpoint` | register | Your relayer server's HTTPS URL |

---

## 7. Troubleshooting

- **"Chain X isn't in the built-in list"** — pass `--contract <address>` explicitly, or use one of the four supported chains.
- **"This contract doesn't expose RELAYER_REGISTRATION_FEE()"** — you're pointed at an older/incompatible contract deployment; double-check `--contract` / `--chain`.
- **Your relayer never shows up in anyone's withdraw list** — check that your `/health` endpoint is live, returns your correct address, and is reachable over HTTPS from the public internet (test it from outside your own network).
- **"Fee exceeds the denomination value"** — the relayer's posted fee tier is invalid for the note's denomination; try a different relayer or self-withdraw.
- **Lost your note** — unfortunately unrecoverable; there is no way to regenerate it.

---

## 8. Command summary

```
node vortexo-cli.js deposit   [--denom N] [--chain ID] [--contract 0x..] [--rpc URL] [--key 0x..]
node vortexo-cli.js withdraw  [--note "..."] [--chain ID] [--contract 0x..] [--rpc URL]
                               [--recipient 0x..] [--relayer-url URL] [--key 0x..]
node vortexo-cli.js register  [--chain ID] [--contract 0x..] [--rpc URL]
                               [--tier 1|2|3] [--endpoint URL] [--key 0x..]
```

#!/usr/bin/env node
//
// vortexo-cli.js
// ───────────────────────────────────────────────────────────────────────────
// ONE-STOP EMERGENCY / OFFLINE TOOL — deposit, withdraw, and become a
// relayer, all from a terminal, in case vortexo.fun itself is ever
// unreachable. No browser needed.
//
//   node scripts/vortexo-cli.js deposit  [flags]
//   node scripts/vortexo-cli.js withdraw [flags]
//   node scripts/vortexo-cli.js register [flags]
//
// Fully automatic: whatever you don't pass as a flag, the script asks for,
// then it submits the transaction itself. There is no manual
// calldata/Remix step — gas and fees are handled the same way the
// contract always handles them, automatically.
//
//   deposit:  needs a denomination + a private key to pay with. The script
//             generates your note, prints it, saves it to a file, and
//             submits the deposit.
//   withdraw: needs your note + the recipient address. "Withdraw myself"
//             also needs a private key to pay gas with. "Withdraw via
//             relayer" scans the on-chain relayer registry instead — no
//             private key or gas needed, you just pick a relayer and pay
//             its posted fee (0.1%/0.2%/0.3%, baked into the proof).
//   register: needs a fee tier, an HTTPS server URL, and a private key to
//             pay the one-time on-chain registration fee. Lists that
//             wallet as an active relayer for anyone withdrawing.
//
// SECURITY: your private key is only ever held in memory for this one
// process, never written to disk, and never sent anywhere except as a
// signed transaction to the RPC you specify. Your note/secret is never
// sent anywhere over the network — only read-only contract calls and the
// final signed transaction leave your machine.
//
// Run `node scripts/vortexo-cli.js` with no arguments for a full overview.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { ethers } = require("ethers");
const circomlibjs = require("circomlibjs");
const snarkjs = require("snarkjs");

// ── SHARED CONSTANTS ─────────────────────────────────────────────────────

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Must match VortexoFunZK.sol's getDenominationValue() exactly.
const DENOMINATION_VALUES = {
  1: ethers.parseEther("0.1"),
  2: ethers.parseEther("1"),
  3: ethers.parseEther("10"),
  4: ethers.parseEther("100"),
};
const DENOMINATION_LABELS = { 1: "0.1", 2: "1", 3: "10", 4: "100" };

const DENOM_MENU = [
  { value: 1, label: "0.1 ETH" },
  { value: 2, label: "1 ETH" },
  { value: 3, label: "10 ETH" },
  { value: 4, label: "100 ETH" },
];

// ⚠️ FILL THESE IN with the real deployed VortexoFunZK address for each
// chain before handing this script to users — these must match
// CONTRACT_ADDRESSES in src/lib/ethereum.ts exactly. Placeholder/zero
// addresses are rejected at runtime (see requireRealContract below).
// relayerUrl is optional — fill it in once you have a relayer/index.js
// instance running for that chain; users can also type a different one
// at the prompt.
const CHAIN_CONFIG = [
  { id: 1, name: "Ethereum Mainnet", contract: "0x0000000000000000000000000000000000000001", relayerUrl: "" },
  { id: 56, name: "BNB Smart Chain", contract: "0x0000000000000000000000000000000000000002", relayerUrl: "" },
  { id: 42161, name: "Arbitrum One", contract: "0x0000000000000000000000000000000000000004", relayerUrl: "" },
  { id: 8453, name: "Base", contract: "0x0000000000000000000000000000000000000006", relayerUrl: "" },
];

function requireRealContract(chainName, address) {
  const isPlaceholder =
    !address ||
    /^0x0+$/i.test(address) ||
    /^0x0{38}[0-9a-f]{2}$/i.test(address); // matches the 0x000...0001-style stand-ins above
  if (isPlaceholder) {
    throw new Error(
      `No real contract address configured for ${chainName} yet — edit CHAIN_CONFIG at the ` +
      `top of this script and replace the placeholder with the actual deployed address.`
    );
  }
}

const CONTRACT_ABI = [
  "function deposit(uint256 commitment, uint8 denom) external payable",
  "function withdraw(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint256 root, bytes32 nullifierHash, address payable recipient, address payable relayer, uint256 fee, uint8 denom) external",
  "function getLeafIndex(uint256 commitment, uint8 denom) external view returns (bool exists, uint32 leafIndex)",
  "function getMerklePath(uint32 leafIndex, uint8 denom) external view returns (uint256[] memory pathElements, uint8[] memory pathIndices)",
  "function getLastRoot(uint8 denom) external view returns (uint256)",
  "function isSpent(bytes32 nullifierHash) external view returns (bool)",
  // ── Relayer marketplace registry ──
  "function registerRelayer(uint8 feeTier, string endpoint) external payable",
  "function getRelayers() external view returns (address[])",
  "function getRelayerInfo(address relayer) external view returns (uint8 feeTier, string endpoint, bool active)",
  "function RELAYER_REGISTRATION_FEE() external view returns (uint256)",
];

const RELAYER_FEE_TIERS = [
  { value: 1, label: "0.1%" },
  { value: 2, label: "0.2%" },
  { value: 3, label: "0.3% (maximum)" },
];

/** Fee (wei) a relayer with the given tier earns for one withdrawal of `denomValue`. */
function feeForTier(denomValue, feeTier) {
  return (denomValue * BigInt(feeTier)) / 1000n;
}

// ── SHARED HELPERS ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function toHex32(value) {
  const bn = BigInt(value);
  if (bn < 0n) throw new Error(`Negative value not allowed in field element: ${bn}`);
  return ethers.toBeHex(bn, 32);
}

function parseNote(serialized) {
  const parts = serialized.trim().split(":");
  if (parts.length !== 4 || parts[0] !== "vortexofun-zk-v1") {
    throw new Error(
      "Invalid note format. Expected: vortexofun-zk-v1:<secret>:<nullifier>:<denom>"
    );
  }
  return { secret: parts[1], nullifier: parts[2], denom: parseInt(parts[3], 10) };
}

function serializeNote(note) {
  return `vortexofun-zk-v1:${note.secret}:${note.nullifier}:${note.denom}`;
}

// Same generation strategy as zkClient.ts's randomFieldElement(), using
// Node's crypto instead of the browser's Web Crypto API.
function randomFieldElement() {
  const bytes = crypto.randomBytes(31);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val % FIELD_SIZE;
}

// A single persistent 'line' listener, queueing answers that arrive before
// they're asked for. Using rl.question() repeatedly (one call per prompt)
// has a real race: if multiple lines arrive in one input chunk (piped
// input, or a fast paste), readline can emit several 'line' events
// synchronously before our code has a chance to `await` its way to
// attaching the next one-shot listener, silently dropping a line. This
// queue makes prompt order irrelevant to when lines actually arrive.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const pendingLines = [];
const pendingResolvers = [];
rl.on("line", (line) => {
  if (pendingResolvers.length > 0) pendingResolvers.shift()(line);
  else pendingLines.push(line);
});

function ask(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    if (pendingLines.length > 0) resolve(pendingLines.shift().trim());
    else pendingResolvers.push((line) => resolve(line.trim()));
  });
}

/**
 * Normalizes and validates a private key:
 *   - trims surrounding whitespace,
 *   - adds the leading "0x" if the user pasted the key without it,
 *   - rejects anything that isn't exactly 64 hex characters.
 * This way a user copying a key straight out of a wallet export never gets
 * a confusing error just because the 0x prefix was missing.
 */
function normalizePrivateKey(raw) {
  let key = (raw || "").trim();
  if (!key) {
    throw new Error(
      "A private key is required - a wallet has to sign the transaction."
    );
  }
  // Accept 0x, 0X, or no prefix at all - always end up with a lowercase 0x.
  key = "0x" + key.replace(/^0x/i, "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "That doesn't look like a valid private key. It must be 64 hex " +
        "characters (0-9, a-f, A-F), starting with 0x - like " +
        "0xabc123...def (66 characters with the 0x). You entered " +
        key.length +
        " characters. Copy it again from your wallet's " +
        '"Export private key" option and paste the whole thing.'
    );
  }
  return key;
}

/** Returns args[key] if present, otherwise prompts the user for it. */
async function getOrAsk(args, key, question) {
  if (args[key] !== undefined && args[key] !== true) return args[key];
  return ask(question);
}

/** Same as ask(), but shows a default the user can accept by pressing enter. */
async function askDefault(question, defaultVal) {
  const answer = await ask(defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `);
  return answer === "" ? defaultVal : answer;
}

/**
 * Prints a numbered menu and returns the chosen item from `items`.
 * `labelFn` turns an item into its display text.
 */
async function selectFromList(title, items, labelFn) {
  console.log(title);
  items.forEach((item, i) => console.log(`  ${i + 1}) ${labelFn(item)}`));
  while (true) {
    const answer = await ask(`Choice [1-${items.length}]: `);
    const n = parseInt(answer, 10);
    if (n >= 1 && n <= items.length) return items[n - 1];
    console.log(`Please enter a number between 1 and ${items.length}.`);
  }
}

/** Chain menu if --chain wasn't passed; otherwise looks up --chain in CHAIN_CONFIG. */
async function chooseChain(args) {
  if (args.chain !== undefined && args.chain !== true) {
    const chainId = Number(args.chain);
    const cfg = CHAIN_CONFIG.find((c) => c.id === chainId);
    if (!cfg) {
      if (!args.contract) {
        throw new Error(
          `Chain ${chainId} isn't in the built-in list — pass --contract explicitly to use it.`
        );
      }
      return { id: chainId, name: `chain ${chainId}`, contract: ethers.getAddress(args.contract) };
    }
    return cfg;
  }
  return selectFromList("\nWhich chain?", CHAIN_CONFIG, (c) => `${c.name} (chain ${c.id})`);
}

async function getOrAskKey(args) {
  if (typeof args.key === "string") return normalizePrivateKey(args.key);
  console.log("");
  console.log("Next, the private key that pays for the transaction. Paste it exactly as");
  console.log("your wallet exported it: it starts with 0x followed by 64 characters");
  console.log("(0-9, a-f), e.g. 0xabc123...def. If you forget the 0x, the script adds");
  console.log("it for you automatically. What you paste is shown on screen so you can");
  console.log("double-check it before continuing.");
  console.log("");
  const raw = await ask("Private key to pay gas with (starts with 0x): ");
  return normalizePrivateKey(raw);
}

async function connectProvider(chainId, rpcUrl) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) {
    throw new Error(
      `Chain ${chainId} doesn't match the RPC's actual chain ID ${network.chainId}. Double-check the RPC URL.`
    );
  }
  return provider;
}

/**
 * Reads every address that ever registered on the on-chain relayer
 * marketplace, keeps only the ones currently active, and health-probes
 * each in parallel — exactly mirroring fetchAvailableRelayers() in
 * src/lib/ethereum.ts, so the CLI sees the same live relayer list the
 * dapp does. An entry only survives if it's active on-chain AND its
 * /health response reports the SAME address it registered under.
 */
async function discoverRelayers(readContract, chainId) {
  let addresses;
  try {
    addresses = await readContract.getRelayers();
  } catch (err) {
    // Older contract without the marketplace — treat as "no registry".
    return [];
  }

  const registered = (
    await Promise.all(
      addresses.map(async (addr) => {
        try {
          const [feeTier, endpoint, active] = await readContract.getRelayerInfo(addr);
          if (!active || !endpoint) return null;
          return { address: addr, feeTier: Number(feeTier), endpoint };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  const probed = await Promise.all(
    registered.map(async (r) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${r.endpoint.replace(/\/+$/, "")}/health`, { signal: controller.signal });
        if (!res.ok) return null;
        const health = await res.json();
        if (!health?.relayerAddress || health.relayerAddress.toLowerCase() !== r.address.toLowerCase()) {
          return null; // identity mismatch — misconfigured or spoofed entry, skip it
        }
        const supportedChains = Array.isArray(health.supportedChains) ? health.supportedChains.map(Number) : [];
        if (supportedChains.length > 0 && !supportedChains.includes(chainId)) return null;
        return r;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })
  );

  return probed.filter(Boolean).sort((a, b) => a.feeTier - b.feeTier);
}

// ── DEPOSIT ──────────────────────────────────────────────────────────────

async function depositCommand(args) {
  console.log("=== VortexoFun deposit ===\n");

  let denom;
  if (args.denom !== undefined && args.denom !== true) {
    denom = Number(args.denom);
    if (!DENOMINATION_VALUES[denom]) throw new Error(`Invalid denomination: ${args.denom}`);
  } else {
    denom = (await selectFromList("How much do you want to deposit?", DENOM_MENU, (d) => d.label)).value;
  }
  const denomValue = DENOMINATION_VALUES[denom];

  const chainCfg = await chooseChain(args);
  const chainId = chainCfg.id;
  requireRealContract(chainCfg.name, chainCfg.contract);
  const contractAddress = ethers.getAddress(chainCfg.contract);
  console.log(`Using contract: ${contractAddress}\n`);

  const rpcUrl = await getOrAsk(args, "rpc", "RPC URL: ");
  const privateKey = await getOrAskKey(args);

  // 1) Generate a fresh note locally. Nothing here touches the network.
  const note = {
    secret: randomFieldElement().toString(),
    nullifier: randomFieldElement().toString(),
    denom,
  };
  const serialized = serializeNote(note);
  console.log(`\n[1/5] Generated a fresh note for ${DENOMINATION_LABELS[denom]} ETH`);

  // 2) Save it to disk immediately, before anything else, so a crash can
  //    never lose it.
  const filename = `vortexo-note-${Date.now()}.txt`;
  const filepath = path.join(process.cwd(), filename);
  fs.writeFileSync(
    filepath,
    `VortexoFun deposit note — ${DENOMINATION_LABELS[denom]} ETH — chain ${chainId} — contract ${contractAddress}\n` +
      `Generated: ${new Date().toISOString()}\n\n${serialized}\n\n` +
      `⚠️  This note is the ONLY way to withdraw this deposit. Anyone who has\n` +
      `it can withdraw the funds. Back it up somewhere safe and delete this\n` +
      `plaintext file once you have.\n`
  );
  console.log(`[2/5] Note saved to: ${filepath}`);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`YOUR NOTE — SAVE THIS NOW, IT'S THE ONLY WAY TO WITHDRAW:\n`);
  console.log(`  ${serialized}`);
  console.log(`${"=".repeat(70)}\n`);

  // 3) Compute the commitment — the only thing that goes on-chain.
  const poseidon = await circomlibjs.buildPoseidon();
  const F = poseidon.F;
  const commitment = F.toObject(
    poseidon([BigInt(note.secret), BigInt(note.nullifier), BigInt(denom)])
  );
  console.log(`[3/5] Commitment computed`);

  // 4) Connect and check funds.
  const provider = await connectProvider(chainId, rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  if (balance < denomValue) {
    throw new Error(
      `Wallet ${wallet.address} has ${ethers.formatEther(balance)} ETH, ` +
      `needs at least ${ethers.formatEther(denomValue)} ETH plus gas.`
    );
  }
  console.log(`[4/5] Connected as ${wallet.address} (balance OK)`);

  // 5) Submit. Gas is estimated automatically by ethers; the contract
  //    handles the protocol fee automatically — nothing to configure.
  console.log(`[5/5] Submitting the deposit...\n`);
  const writeContract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
  const tx = await writeContract.deposit(commitment, denom, { value: denomValue });
  console.log(`Transaction submitted: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(`\n✅ Deposit confirmed in block ${receipt.blockNumber}.`);
  console.log(`   ${DENOMINATION_LABELS[denom]} ETH deposited from ${wallet.address}`);
  console.log(`\nYour note is saved at ${filepath} — keep it safe, it's needed to withdraw.`);
}

// ── WITHDRAW ─────────────────────────────────────────────────────────────

async function withdrawCommand(args) {
  console.log("=== VortexoFun withdrawal ===\n");

  const note = await getOrAsk(args, "note", "Your deposit note (vortexofun-zk-v1:...): ");

  const chainCfg = await chooseChain(args);
  const chainId = chainCfg.id;
  requireRealContract(chainCfg.name, chainCfg.contract);
  const contractAddress = ethers.getAddress(chainCfg.contract);
  console.log(`Using contract: ${contractAddress}\n`);

  const recipient = ethers.getAddress(
    await getOrAsk(args, "recipient", "Address to receive the funds: ")
  );

  // How to withdraw: pay your own gas, or let a relayer submit it for
  // that relayer's own registered fee (0.1%/0.2%/0.3%, chosen by them at
  // registration) — useful when the recipient address has no ETH balance
  // to pay gas with, the whole point of a relayer.
  let mode;
  if (args.mode === "self" || args.mode === "relayer") {
    mode = args.mode;
  } else if (args["relayer-url"]) {
    mode = "relayer";
  } else if (args.key) {
    mode = "self";
  } else {
    mode = (
      await selectFromList("\nHow do you want to withdraw?", [
        { key: "self", label: "Withdraw myself — I pay gas directly (need a private key with ETH for gas)" },
        { key: "relayer", label: "Withdraw via relayer — relayer pays gas, I pay a small fee automatically (no gas needed)" },
      ], (m) => m.label)
    ).key;
  }

  const rpcUrl = await getOrAsk(args, "rpc", "RPC URL: ");

  const zkNote = parseNote(note);
  const denom = zkNote.denom;
  if (!DENOMINATION_VALUES[denom]) throw new Error(`Invalid denomination in note: ${denom}`);
  console.log(`\nNote parsed — denomination: ${DENOMINATION_LABELS[denom]} ETH`);
  const denomValue = DENOMINATION_VALUES[denom];

  const provider = await connectProvider(chainId, rpcUrl);
  const readContractEarly = new ethers.Contract(contractAddress, CONTRACT_ABI, provider);

  // Resolve relayer/fee/privateKey based on the chosen mode.
  let relayer, fee, privateKey, relayerUrl, feeTier;
  if (mode === "relayer") {
    console.log(`\nScanning the on-chain relayer registry and probing servers...`);
    const live = await discoverRelayers(readContractEarly, chainId);

    const MANUAL_ENTRY = { manual: true, label: "Enter a relayer URL manually" };
    const choice =
      live.length > 0
        ? await selectFromList(
            "\nWhich relayer?",
            [...live, MANUAL_ENTRY],
            (r) => (r.manual ? r.label : `${r.address.slice(0, 6)}···${r.address.slice(-4)}  —  fee ${r.feeTier / 10}%  —  ${r.endpoint}`)
          )
        : MANUAL_ENTRY;

    if (choice.manual) {
      if (live.length === 0) {
        console.log("(No relayers found in the on-chain registry for this chain — falling back to a manual URL.)");
      }
      const suggestedUrl = chainCfg.relayerUrl || "http://localhost:3001";
      relayerUrl =
        args["relayer-url"] && args["relayer-url"] !== true
          ? args["relayer-url"]
          : await askDefault(`Relayer URL for ${chainCfg.name}`, suggestedUrl);
      console.log(`Checking relayer at ${relayerUrl}...`);
      let healthRes;
      try {
        healthRes = await fetch(`${relayerUrl}/health`);
      } catch (err) {
        throw new Error(`Relayer is unreachable at ${relayerUrl} — is it running? (${err.message})`);
      }
      if (!healthRes.ok) throw new Error(`Relayer /health returned ${healthRes.status} ${healthRes.statusText}`);
      const healthData = await healthRes.json();
      if (!healthData?.relayerAddress || !/^0x[0-9a-fA-F]{40}$/.test(healthData.relayerAddress)) {
        throw new Error(`Relayer /health didn't return a valid relayerAddress (got: ${JSON.stringify(healthData)})`);
      }
      relayer = ethers.getAddress(healthData.relayerAddress);
      // A manually-entered relayer might not be registered on-chain at
      // all (e.g. a local dev instance) — fall back to whatever tier it
      // reports itself, defaulting to the maximum (3) if it reports none.
      // If it IS registered, cross-check against the registry so a wrong
      // .env RELAYER_FEE_TIER on the operator's side gets caught here
      // instead of failing on-chain after proof generation.
      const reportedTier = Number(healthData.feeTier) || 3;
      try {
        const [onChainTier, , active] = await readContractEarly.getRelayerInfo(relayer);
        if (active && Number(onChainTier) > 0) {
          if (Number(onChainTier) !== reportedTier) {
            console.log(
              `⚠ This relayer's server reports tier ${reportedTier} but the registry has it at ` +
              `tier ${onChainTier} — using the on-chain value, since that's what withdraw() actually enforces.`
            );
          }
          feeTier = Number(onChainTier);
        } else {
          feeTier = reportedTier;
        }
      } catch {
        feeTier = reportedTier; // older contract without the registry — trust the server
      }
    } else {
      relayer = ethers.getAddress(choice.address);
      relayerUrl = choice.endpoint;
      feeTier = choice.feeTier;
      console.log(`\nUsing relayer ${relayer} (${choice.feeTier / 10}%) at ${relayerUrl}`);
    }

    // EXACT fee for THIS relayer's tier — 0.1% / 0.2% / 0.3%. Must match
    // what withdraw() enforces on-chain (denomValue * tier / 1000) and
    // what this relayer's own server computes, or the request is rejected
    // (by the relayer's fee check, or on-chain, or both).
    fee = feeForTier(denomValue, feeTier);
    console.log(`Relayer address: ${relayer}`);
    console.log(`Relayer fee: ${ethers.formatEther(fee)} ETH (${feeTier / 10}%) — no gas needed from you`);
  } else {
    relayer = recipient;
    fee = 0n;
    privateKey = await getOrAskKey(args);
  }
  if (fee > denomValue) throw new Error(`Fee ${fee} exceeds the denomination value ${denomValue}`);

  const poseidon = await circomlibjs.buildPoseidon();
  const F = poseidon.F;
  const secret = BigInt(zkNote.secret);
  const nullifier = BigInt(zkNote.nullifier);
  const commitment = F.toObject(poseidon([secret, nullifier, BigInt(denom)]));
  const nullifierHash = F.toObject(poseidon([nullifier]));
  const nullifierHex = toHex32(nullifierHash.toString());
  if (nullifierHash <= 0n || nullifierHash >= FIELD_SIZE) {
    throw new Error(`Computed nullifierHash out of expected range: ${nullifierHash}`);
  }
  console.log(`Commitment + nullifier hash recomputed from your note`);

  const readContract = readContractEarly;

  const alreadySpent = await readContract.isSpent(nullifierHex);
  if (alreadySpent) throw new Error("This note has already been withdrawn (nullifier already spent).");

  const [exists, leafIndex] = await readContract.getLeafIndex(commitment, denom);
  if (!exists) {
    throw new Error(
      "Deposit not found on-chain for this note in this denomination pool — " +
      "has it been confirmed yet, or is the contract/chain wrong?"
    );
  }
  console.log(`Found your deposit on-chain at leaf index ${leafIndex} (denom ${denom})`);

  const [pathElementsRaw, pathIndicesRaw] = await readContract.getMerklePath(leafIndex, denom);
  const pathElements = pathElementsRaw.map((e) => e.toString());
  const pathIndices = pathIndicesRaw.map((i) => Number(i));
  const root = (await readContract.getLastRoot(denom)).toString();
  console.log(`Merkle path fetched`);

  const circuitInputs = {
    root,
    nullifierHash: nullifierHash.toString(),
    recipient: BigInt(recipient).toString(),
    relayer: BigInt(relayer).toString(),
    fee: fee.toString(),
    denom: denom.toString(),
    secret: secret.toString(),
    nullifier: nullifier.toString(),
    depositDenom: denom.toString(),
    pathElements,
    pathIndices,
  };

  // Look for the build/ folder next to this script first, then fall back to
  // one level up (the original layout, where the script lives inside the
  // vortexo project's scripts/ folder).
  const buildRoot =
    [path.join(__dirname, "build"), path.join(__dirname, "..", "build")].find((p) =>
      fs.existsSync(p)
    ) || path.join(__dirname, "build");
  const wasmPath = path.join(buildRoot, "withdraw_js", "withdraw.wasm");
  const zkeyPath = path.join(buildRoot, "withdraw_final.zkey");
  if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
    throw new Error(
      `Missing proving artifacts. Expected:\n  ${wasmPath}\n  ${zkeyPath}\n` +
      "Make sure you're running this from inside the vortexo project folder."
    );
  }

  console.log("Generating zk-SNARK proof (this can take 10-30 seconds)...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInputs, wasmPath, zkeyPath);

  const pA = [proof.pi_a[0], proof.pi_a[1]];
  const pB = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const pC = [proof.pi_c[0], proof.pi_c[1]];
  const rootHex = toHex32(publicSignals[0]);
  const calldataPayload = [pA, pB, pC, rootHex, nullifierHex, recipient, relayer, fee.toString(), denom];

  fs.writeFileSync(
    path.join(process.cwd(), "last-withdrawal.json"),
    JSON.stringify({ proof, publicSignals, calldataPayload: calldataPayload.map(String) }, null, 2)
  );
  console.log("Proof generated and saved to last-withdrawal.json\n");

  if (mode === "relayer") {
    console.log(`Submitting to relayer...\n`);
        // The relayer protocol expects the Solidity-order proof shape
    // ({ _pA, _pB, _pC }), NOT the raw snarkjs pi_a/pi_b/pi_c output —
    // the same swap generateWithdrawalProof() in src/lib/zkClient.ts does.
    const body = {
      proof: { _pA: pA, _pB: pB, _pC: pC },
      publicSignals,
      recipient,
      relayer,
      fee: fee.toString(),
      denom,
      chainId,
    };
    let res;
    try {
      res = await fetch(`${relayerUrl}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Relayer is unreachable at ${relayerUrl} — is it running? (${err.message})`);
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON response, handled below */ }

    if (res.ok && data?.txHash) {
      console.log(`✅ Withdrawal submitted by relayer. Transaction: ${data.txHash}`);
      console.log(`   ${DENOMINATION_LABELS[denom]} ETH (minus the ${feeTier / 10}% relayer fee) sent to ${recipient}`);
      return;
    }
    const relayerMessage = data?.error || `Relayer returned ${res.status} ${res.statusText}`;
    if (res.status === 409) {
      throw new Error(`Relayer says this note can't be withdrawn as-is: ${relayerMessage}`);
    }
    if (res.status === 503) {
      throw new Error(
        `Relayer declined: ${relayerMessage} (this relayer's ${feeTier / 10}% fee doesn't currently cover gas for this ` +
        `denomination — try "Withdraw myself" instead, or pick a different relayer.)`
      );
    }
    throw new Error(`Relayer error: ${relayerMessage}`);
  } else {
    // Gas is estimated automatically; the contract handles the fee logic
    // (here: none, self-withdrawal) — nothing else to configure.
    console.log(`Submitting the withdrawal on-chain...\n`);
    const wallet = new ethers.Wallet(privateKey, provider);
    const writeContract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
    const tx = await writeContract.withdraw(...calldataPayload);
    console.log(`Transaction submitted: ${tx.hash}`);
    console.log("Waiting for confirmation...");
    const receipt = await tx.wait();
    console.log(`\n✅ Withdrawal confirmed in block ${receipt.blockNumber}.`);
    console.log(`   ${DENOMINATION_LABELS[denom]} ETH sent to ${recipient}`);
  }
}

// ── BECOME A RELAYER ─────────────────────────────────────────────────────
// Mirrors registerAsRelayer() in src/lib/ethereum.ts / the RELAYER tab in
// the dapp — pays the one-time on-chain registration fee and lists this
// wallet as an active relayer at the chosen tier + endpoint.

async function registerCommand(args) {
  console.log("=== VortexoFun — become a relayer ===\n");

  const chainCfg = await chooseChain(args);
  const chainId = chainCfg.id;
  requireRealContract(chainCfg.name, chainCfg.contract);
  const contractAddress = ethers.getAddress(chainCfg.contract);
  console.log(`Using contract: ${contractAddress}\n`);

  const rpcUrl = await getOrAsk(args, "rpc", "RPC URL: ");
  const provider = await connectProvider(chainId, rpcUrl);
  const readContract = new ethers.Contract(contractAddress, CONTRACT_ABI, provider);

  let registrationFee;
  try {
    registrationFee = await readContract.RELAYER_REGISTRATION_FEE();
  } catch {
    throw new Error(
      "This contract doesn't expose RELAYER_REGISTRATION_FEE() — it's either an older deployment " +
      "without the relayer marketplace, or the wrong address for this chain."
    );
  }
  console.log(`One-time registration fee: ${ethers.formatEther(registrationFee)} ETH\n`);

  let feeTier;
  if (args.tier !== undefined && args.tier !== true) {
    feeTier = Number(args.tier);
    if (![1, 2, 3].includes(feeTier)) throw new Error("--tier must be 1, 2, or 3");
  } else {
    feeTier = (
      await selectFromList("Your fee per withdrawal (0.3% is the maximum):", RELAYER_FEE_TIERS, (t) => t.label)
    ).value;
  }

  let endpoint = await getOrAsk(args, "endpoint", "Your relayer server's HTTPS URL (e.g. https://relayer.yourdomain.com): ");
  endpoint = endpoint.trim().replace(/\/+$/, "");
  if (!/^https:\/\/.+/.test(endpoint)) {
    throw new Error("Endpoint must be an HTTPS URL — the dapp won't trust a plain http:// server.");
  }

  const privateKey = await getOrAskKey(args);
  const wallet = new ethers.Wallet(privateKey, provider);
  const writeContract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

  console.log(`\nRegistering ${wallet.address} at tier ${feeTier} (${feeTier / 10}%)...`);
  const tx = await writeContract.registerRelayer(feeTier, endpoint, { value: registrationFee });
  console.log(`Transaction submitted: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(`\n✅ Registered in block ${receipt.blockNumber}.`);
  console.log(`   ${wallet.address} will now appear in every user's relayer list on this chain.`);
  console.log(`   Run relayer/index.js with RELAYER_FEE_TIER=${feeTier} and this same private key to start earning.`);
}

// ── ENTRYPOINT ───────────────────────────────────────────────────────────

function printTopLevelHelp() {
  console.log(`
VortexoFun offline CLI — deposit and withdraw without the website.
Just run one of these and follow the prompts — no flags required:

  node scripts/vortexo-cli.js deposit
    -> pick an amount from a list, pick a chain from a list (the contract
       address is filled in automatically), enter an RPC URL, and paste a
       private key starting with 0x (shown on screen while you paste it, so
       you can double-check it; a missing 0x is added automatically).
       The script prints + saves your
       note and submits the deposit.

  node scripts/vortexo-cli.js withdraw
    -> paste your note, pick a chain from a list (contract auto-filled),
       enter the recipient address, choose "withdraw myself" (pay gas
       directly) or "withdraw via relayer" (the script scans the on-chain
       relayer registry, shows you every live relayer and its fee, you
       pick one — no gas needed from you), then an RPC URL, and (self mode
       only) a private key. The script does the rest.

  node scripts/vortexo-cli.js register
    -> become a relayer yourself: pick a chain, a fee tier (0.1%/0.2%/0.3%),
       your server's HTTPS URL, and pay the one-time on-chain registration
       fee. Matches the RELAYER tab in the dapp exactly.

Everything is automatic after that: gas and fees are handled by the
contract itself, there's no manual paste-into-Remix step.

Flags (--denom, --chain, --contract, --rpc, --recipient, --note, --key,
--tier, --endpoint, --relayer-url) can still be passed to skip any
prompt, for scripting/automation.
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  try {
    if (command === "deposit") {
      await depositCommand(args);
    } else if (command === "withdraw") {
      await withdrawCommand(args);
    } else if (command === "register") {
      await registerCommand(args);
    } else {
      printTopLevelHelp();
      process.exitCode = command ? 1 : 0;
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message || err);
  rl.close();
  process.exitCode = 1;
});

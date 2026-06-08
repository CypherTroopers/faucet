const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ethers } = require("ethers");
require("dotenv").config();

const RPC_URL = process.env.RPC_URL;
const FAUCET_PRIVATE_KEY = process.env.FAUCET_PRIVATE_KEY;
const EXPECTED_FAUCET_ADDRESS = process.env.FAUCET_ADDRESS;
const FAUCET_AMOUNT = process.env.FAUCET_AMOUNT || "10";
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3600000);
const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!RPC_URL) {
  throw new Error("RPC_URL is missing");
}

if (!FAUCET_PRIVATE_KEY || !FAUCET_PRIVATE_KEY.startsWith("0x")) {
  throw new Error("FAUCET_PRIVATE_KEY is missing or invalid");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

const rawWallet = new ethers.Wallet(FAUCET_PRIVATE_KEY, provider);
const wallet = new ethers.NonceManager(rawWallet);

const amountWei = ethers.parseEther(FAUCET_AMOUNT);

const app = express();

app.set("trust proxy", 1);

/*
  IMPORTANT:
  Default helmet() enables Content-Security-Policy.
  That can block inline JavaScript in public/index.html.
  Because this faucet page currently uses inline <script>, CSP is disabled here.
*/
app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(cors({
  origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map(v => v.trim())
}));

app.use(express.json({ limit: "16kb" }));

app.use(express.static("public"));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
}));

const lastByIp = new Map();
const lastByAddress = new Map();
const pendingAddress = new Set();

function getClientIp(req) {
  return req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip ||
    "unknown";
}

function cooldownLeft(lastTime) {
  const left = COOLDOWN_MS - (Date.now() - lastTime);
  return Math.max(0, Math.ceil(left / 1000));
}

async function getLegacyGasPrice() {
  try {
    const gasPriceHex = await provider.send("eth_gasPrice", []);
    return BigInt(gasPriceHex);
  } catch (_) {
    const feeData = await provider.getFeeData();
    return feeData.gasPrice || feeData.maxFeePerGas || 1000000000n;
  }
}

app.get("/health", async (_req, res) => {
  try {
    const faucetAddress = await rawWallet.getAddress();
    const balance = await provider.getBalance(faucetAddress);
    const network = await provider.getNetwork();

    res.json({
      ok: true,
      rpc: RPC_URL,
      chainId: network.chainId.toString(),
      faucetAddress,
      balance: ethers.formatEther(balance),
      amountPerRequest: FAUCET_AMOUNT
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.shortMessage || err.message
    });
  }
});

app.post("/faucet", async (req, res) => {
  const ip = getClientIp(req);
  const inputAddress = String(req.body.address || "").trim();

  if (!ethers.isAddress(inputAddress)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid address"
    });
  }

  const to = ethers.getAddress(inputAddress);
  const toKey = to.toLowerCase();

  const lastIpTime = lastByIp.get(ip);
  if (lastIpTime && Date.now() - lastIpTime < COOLDOWN_MS) {
    return res.status(429).json({
      ok: false,
      error: "IP cooldown active",
      retryAfterSec: cooldownLeft(lastIpTime)
    });
  }

  const lastAddressTime = lastByAddress.get(toKey);
  if (lastAddressTime && Date.now() - lastAddressTime < COOLDOWN_MS) {
    return res.status(429).json({
      ok: false,
      error: "Address cooldown active",
      retryAfterSec: cooldownLeft(lastAddressTime)
    });
  }

  if (pendingAddress.has(toKey)) {
    return res.status(429).json({
      ok: false,
      error: "Request already pending for this address"
    });
  }

  pendingAddress.add(toKey);

  try {
    const faucetAddress = await rawWallet.getAddress();

    if (
      EXPECTED_FAUCET_ADDRESS &&
      faucetAddress.toLowerCase() !== EXPECTED_FAUCET_ADDRESS.toLowerCase()
    ) {
      return res.status(500).json({
        ok: false,
        error: "FAUCET_PRIVATE_KEY does not match FAUCET_ADDRESS"
      });
    }

    if (to.toLowerCase() === faucetAddress.toLowerCase()) {
      return res.status(400).json({
        ok: false,
        error: "Cannot request faucet to the faucet wallet itself"
      });
    }

    const gasLimit = 21000n;
    const gasPrice = await getLegacyGasPrice();

    const requiredBalance = amountWei + gasLimit * gasPrice;
    const balance = await provider.getBalance(faucetAddress);

    if (balance < requiredBalance) {
      return res.status(503).json({
        ok: false,
        error: "Faucet wallet balance is too low",
        faucetBalance: ethers.formatEther(balance),
        required: ethers.formatEther(requiredBalance)
      });
    }

    const tx = await wallet.sendTransaction({
      to,
      value: amountWei,
      gasLimit,
      gasPrice,
      type: 0
    });

    lastByIp.set(ip, Date.now());
    lastByAddress.set(toKey, Date.now());

    res.json({
      ok: true,
      to,
      amount: FAUCET_AMOUNT,
      txHash: tx.hash
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.shortMessage || err.message
    });
  } finally {
    pendingAddress.delete(toKey);
  }
});

app.listen(PORT, async () => {
  const faucetAddress = await rawWallet.getAddress();
  console.log(`Faucet server running on port ${PORT}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Faucet address: ${faucetAddress}`);
});

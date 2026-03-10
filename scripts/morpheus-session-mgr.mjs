#!/usr/bin/env node
/**
 * Morpheus Session Manager — EverClaw
 *
 * Operational tooling for Morpheus P2P session management.
 * Wraps lessons learned from session debugging into a single CLI.
 *
 * Commands:
 *   status    — Show session health, balance, provider info
 *   balance   — Check MOR balance (router + safe)
 *   fund      — Transfer MOR from Safe to Router wallet
 *   models    — List available P2P models
 *   sessions  — List active sessions with stake info
 *   estimate  — Estimate max session duration from balance
 *   logs      — Show recent session-related log entries
 *
 * Usage:
 *   node morpheus-session-mgr.mjs status
 *   node morpheus-session-mgr.mjs balance
 *   node morpheus-session-mgr.mjs fund 500 [--execute]
 *   node morpheus-session-mgr.mjs models
 *   node morpheus-session-mgr.mjs estimate
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { execSync } from "node:child_process";

// --- Configuration ---
const PROXY_URL = process.env.MORPHEUS_PROXY_URL || "http://127.0.0.1:8083";
const RPC_URL = process.env.EVERCLAW_RPC || "https://base-mainnet.public.blastapi.io";
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
const ROUTER_WALLET = process.env.MORPHEUS_WALLET_ADDRESS;
const SAFE_ADDRESS = process.env.MORPHEUS_SAFE_ADDRESS;
if (!ROUTER_WALLET) { console.error("❌ MORPHEUS_WALLET_ADDRESS env var required"); process.exit(1); }
if (!SAFE_ADDRESS) { console.error("❌ MORPHEUS_SAFE_ADDRESS env var required"); process.exit(1); }
const DAILY_STAKE_RATE = parseFloat(process.env.MORPHEUS_DAILY_STAKE || "633"); // MOR per day (approximate)

// --- Helpers ---

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve(Buffer.concat(chunks).toString());
        }
      });
    }).on("error", reject);
  });
}

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(RPC_URL);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const client = RPC_URL.startsWith("https") ? https : http;
    const req = client.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getMorBalance(address) {
  const sig = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const result = await rpcCall("eth_call", [{ to: MOR_TOKEN, data: sig }, "latest"]);
  return Number(BigInt(result)) / 1e18;
}

async function getEthBalance(address) {
  const result = await rpcCall("eth_getBalance", [address, "latest"]);
  return Number(BigInt(result)) / 1e18;
}

function formatMor(n) {
  return n.toFixed(2);
}

// --- Commands ---

async function cmdStatus() {
  console.log("\n🔍 Morpheus Session Manager — Status\n");

  // Proxy health
  let health;
  try {
    health = await httpGet(`${PROXY_URL}/health`);
  } catch (e) {
    console.error("❌ Proxy not responding at", PROXY_URL);
    console.error("   Is morpheus-proxy running?\n");
    process.exit(1);
  }

  // Balance check
  const [routerMor, safeMor, routerEth] = await Promise.all([
    getMorBalance(ROUTER_WALLET),
    getMorBalance(SAFE_ADDRESS),
    getEthBalance(ROUTER_WALLET),
  ]);

  const totalMor = routerMor + safeMor;
  const maxConcurrentSessions = Math.floor(routerMor / DAILY_STAKE_RATE);

  // Display
  console.log("📊 Balances:");
  console.log(`   Router EOA:    ${formatMor(routerMor)} MOR  |  ${routerEth.toFixed(5)} ETH`);
  console.log(`   Safe Reserve:  ${formatMor(safeMor)} MOR`);
  console.log(`   Total:         ${formatMor(totalMor)} MOR`);
  console.log(`   Concurrent 1-day sessions: ~${maxConcurrentSessions} (at ~${DAILY_STAKE_RATE} MOR stake each)`);
  console.log(`   Note: MOR is STAKED, not spent — returned after each session closes\n`);

  // Session info
  const sessions = health.activeSessions || [];
  if (sessions.length > 0) {
    console.log("📡 Active Sessions:");
    for (const s of sessions) {
      const expiresIn = Math.max(0, (new Date(s.expiresAt).getTime() - Date.now()) / 3600000);
      console.log(`   ${s.model}: ${s.sessionId?.slice(0, 16)}... (expires in ${expiresIn.toFixed(1)}h)`);
    }
  } else {
    console.log("📡 No active sessions");
  }
  console.log("");

  // Fallback status
  if (health.fallbackMode) {
    const remaining = health.fallbackRemaining || 0;
    console.log(`⚠️  FALLBACK MODE: Using Gateway API (${Math.floor(remaining / 60)}min remaining)`);
  } else {
    console.log("✅ P2P Mode: Active");
  }

  if (health.consecutiveFailures > 0) {
    console.log(`   Consecutive failures: ${health.consecutiveFailures} (threshold: ${health.fallbackThreshold || 3})`);
  }

  console.log(`   Gateway configured: ${health.gatewayConfigured ? "yes" : "no"}`);

  // Warnings
  console.log("");
  if (routerMor < 500) {
    console.log("⚠️  Router MOR below threshold (500). Run: node morpheus-session-mgr.mjs fund 2000 --execute");
  }
  if (routerEth < 0.005) {
    console.log("⚠️  Router ETH low for gas. Send ETH to", ROUTER_WALLET);
  }
  if (routerMor < DAILY_STAKE_RATE) {
    console.log("🚨 Router can't open a new session! Fund immediately.");
  }
  console.log("");
}

async function cmdBalance() {
  console.log("\n💰 MOR Balance Report\n");

  const [routerMor, safeMor, routerEth] = await Promise.all([
    getMorBalance(ROUTER_WALLET),
    getMorBalance(SAFE_ADDRESS),
    getEthBalance(ROUTER_WALLET),
  ]);

  console.log(`   Router EOA (${ROUTER_WALLET.slice(0, 10)}...):  ${formatMor(routerMor)} MOR  |  ${routerEth.toFixed(5)} ETH`);
  console.log(`   Safe (${SAFE_ADDRESS.slice(0, 10)}...):          ${formatMor(safeMor)} MOR`);
  console.log(`   Total:                              ${formatMor(routerMor + safeMor)} MOR`);
  console.log(`\n   Stake per 1-day session: ~${DAILY_STAKE_RATE} MOR (returned after close)`);
  console.log(`   Max concurrent sessions (router): ~${Math.floor(routerMor / DAILY_STAKE_RATE)}`);
  console.log(`   Max concurrent sessions (total):  ~${Math.floor((routerMor + safeMor) / DAILY_STAKE_RATE)}`);
  console.log(`\n   Note: MOR is STAKED, not consumed. All staked MOR returns after session close.\n`);
}

async function cmdModels() {
  console.log("\n📋 Available P2P Models\n");

  let health;
  try {
    health = await httpGet(`${PROXY_URL}/health`);
  } catch {
    console.error("❌ Proxy not responding\n");
    process.exit(1);
  }

  const models = health.availableModels || [];
  if (models.length === 0) {
    console.log("   No models available. Is the router running?\n");
    return;
  }

  const reasoning = ["kimi-k2-thinking"];
  const general = ["kimi-k2.5", "glm-4.7", "qwen3-235b", "gpt-oss-120b"];
  const fast = ["glm-4.7-flash"];
  const web = ["kimi-k2.5:web"];

  for (const m of models) {
    let tag = "general";
    if (reasoning.includes(m)) tag = "reasoning 🧠";
    else if (fast.includes(m)) tag = "fast ⚡";
    else if (web.includes(m)) tag = "web 🌐";
    console.log(`   ${m.padEnd(25)} ${tag}`);
  }
  console.log(`\n   Total: ${models.length} models available on P2P`);
  console.log(`   Note: glm-5 is NOT available on P2P (use Gateway)\n`);
}

async function cmdEstimate() {
  console.log("\n📐 Session Duration Estimate\n");

  const routerMor = await getMorBalance(ROUTER_WALLET);
  const safeMor = await getMorBalance(SAFE_ADDRESS);

  console.log(`   Router balance: ${formatMor(routerMor)} MOR`);
  console.log(`   Safe balance:   ${formatMor(safeMor)} MOR`);
  console.log(`   Daily rate:     ~${DAILY_STAKE_RATE} MOR/day\n`);

  const durations = [
    { label: "6 hours", seconds: 21600, stake: DAILY_STAKE_RATE * 0.25 },
    { label: "12 hours", seconds: 43200, stake: DAILY_STAKE_RATE * 0.5 },
    { label: "1 day", seconds: 86400, stake: DAILY_STAKE_RATE },
    { label: "3 days", seconds: 259200, stake: DAILY_STAKE_RATE * 3 },
    { label: "7 days", seconds: 604800, stake: DAILY_STAKE_RATE * 7 },
  ];

  console.log("   Duration    Stake Needed    Router Can?    With Safe?");
  console.log("   ─────────   ────────────    ───────────    ──────────");
  for (const d of durations) {
    const canRouter = routerMor >= d.stake ? "✅ yes" : "❌ no ";
    const canTotal = (routerMor + safeMor) >= d.stake ? "✅ yes" : "❌ no ";
    console.log(`   ${d.label.padEnd(11)}  ${formatMor(d.stake).padStart(8)} MOR    ${canRouter}         ${canTotal}`);
  }

  const maxDays = routerMor / DAILY_STAKE_RATE;
  const maxSeconds = Math.floor(maxDays * 86400);
  console.log(`\n   Max single session from router: ~${maxDays.toFixed(1)} days (${maxSeconds}s)`);
  console.log(`   Recommended MORPHEUS_SESSION_DURATION: ${Math.min(maxSeconds, 604800)}`);
  console.log(`\n   Note: MOR is STAKED and returned after session close.`);
  console.log(`   Longer sessions lock more MOR but it all comes back.\n`);
}

async function cmdFund() {
  const amount = process.argv[3];
  const execute = process.argv.includes("--execute");

  if (!amount || isNaN(parseFloat(amount))) {
    console.error("Usage: node morpheus-session-mgr.mjs fund <amount> [--execute]");
    console.error("Example: node morpheus-session-mgr.mjs fund 2000 --execute\n");
    process.exit(1);
  }

  // Delegate to safe-transfer.mjs
  const scriptDir = new URL(".", import.meta.url).pathname;
  const cmd = `node ${scriptDir}safe-transfer.mjs ${amount} ${execute ? "--execute" : ""}`;
  console.log(`\n🏦 Delegating to safe-transfer.mjs...\n`);

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

async function cmdSessions() {
  console.log("\n📡 Active Sessions\n");

  let health;
  try {
    health = await httpGet(`${PROXY_URL}/health`);
  } catch {
    console.error("❌ Proxy not responding\n");
    process.exit(1);
  }

  const sessions = health.activeSessions || [];
  if (sessions.length === 0) {
    console.log("   No active sessions\n");
    return;
  }

  for (const s of sessions) {
    const expiresAt = new Date(s.expiresAt);
    const expiresIn = Math.max(0, (expiresAt.getTime() - Date.now()) / 3600000);
    const active = s.active ? "✅" : "❌";
    console.log(`   ${active} ${s.model}`);
    console.log(`      Session: ${s.sessionId}`);
    console.log(`      Expires: ${expiresAt.toISOString()} (~${expiresIn.toFixed(1)}h remaining)\n`);
  }
}

async function cmdLogs() {
  console.log("\n📋 Recent Session Logs\n");

  const logPaths = [
    `${process.env.HOME}/morpheus/proxy/proxy.log`,
    `${process.env.HOME}/morpheus/data/logs/router-stdout.log`,
  ];

  for (const logPath of logPaths) {
    if (!fs.existsSync(logPath)) continue;
    console.log(`--- ${logPath} ---`);
    try {
      const lines = fs.readFileSync(logPath, "utf-8").split("\n");
      const sessionLines = lines.filter(
        (l) => /session|stake|balance|error|fail|opened|expired/i.test(l)
      ).slice(-15);
      for (const line of sessionLines) {
        console.log(`   ${line.trim()}`);
      }
    } catch {
      console.log("   (could not read)");
    }
    console.log("");
  }
}

function showHelp() {
  console.log(`
Morpheus Session Manager — EverClaw

Usage: node morpheus-session-mgr.mjs <command>

Commands:
  status     Show session health, balance, provider info
  balance    Check MOR balance (router + safe)
  fund       Transfer MOR from Safe to Router (delegates to safe-transfer.mjs)
  models     List available P2P models
  sessions   List active sessions with expiry info
  estimate   Estimate max session duration from current balance
  logs       Show recent session-related log entries

Examples:
  node morpheus-session-mgr.mjs status
  node morpheus-session-mgr.mjs fund 2000 --execute
  node morpheus-session-mgr.mjs estimate
`);
}

// --- Main ---
const command = process.argv[2];

switch (command) {
  case "status": await cmdStatus(); break;
  case "balance": await cmdBalance(); break;
  case "models": await cmdModels(); break;
  case "sessions": await cmdSessions(); break;
  case "estimate": await cmdEstimate(); break;
  case "fund": await cmdFund(); break;
  case "logs": await cmdLogs(); break;
  case "help":
  case "--help":
  case "-h":
  default:
    showHelp();
    break;
}

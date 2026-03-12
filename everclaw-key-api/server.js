import express from "express";
import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import cors from "cors";

// --- Config ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.EVERCLAW_API_PORT || 3000;
const DB_PATH = process.env.EVERCLAW_DB_PATH || join(__dirname, "data", "keys.db");
const SECRET = process.env.EVERCLAW_ADMIN_SECRET;

// --- Database ---
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  api_key TEXT UNIQUE,
  device_fingerprint TEXT UNIQUE,
  everclaw_version TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  last_renewed_at DATETIME,
  request_count_today INTEGER DEFAULT 0,
  request_count_total INTEGER DEFAULT 0,
  last_request_at DATETIME,
  last_reset_at DATETIME,
  rate_limit_daily INTEGER DEFAULT 1000,
  is_revoked BOOLEAN DEFAULT 0,
  revoke_reason TEXT
)`);

// --- App ---
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// --- Helpers ---
const genKey = () => "evcl_" + randomBytes(16).toString("hex");
const exp = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

// --- Routes ---

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Request or renew an API key
app.post("/api/keys/request", (req, res) => {
  const { device_fingerprint: f, everclaw_version: v } = req.body;

  if (!f) {
    return res.status(400).json({ error: "missing fingerprint" });
  }

  // Check for existing key by device fingerprint
  let k = db.prepare("SELECT * FROM keys WHERE device_fingerprint = ?").get(f);

  if (k) {
    // Existing device — check status
    if (k.is_revoked) {
      return res.status(403).json({ error: "revoked" });
    }

    // Auto-renew if expired
    if (new Date(k.expires_at) < new Date()) {
      db.prepare("UPDATE keys SET expires_at = ?, last_renewed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(exp(), k.id);
      k = db.prepare("SELECT * FROM keys WHERE id = ?").get(k.id);
    }

    return res.json({
      api_key: k.api_key,
      expires_at: k.expires_at,
      rate_limit: {
        daily: k.rate_limit_daily,
        remaining: k.rate_limit_daily - k.request_count_today,
      },
    });
  }

  // New device — issue key
  const key = genKey();
  db.prepare("INSERT INTO keys (api_key, device_fingerprint, everclaw_version, expires_at) VALUES (?, ?, ?, ?)")
    .run(key, f, v || null, exp());

  console.log("[ISSUE]", key.substring(0, 12));

  res.status(201).json({
    api_key: key,
    expires_at: exp(),
    rate_limit: { daily: 1000, remaining: 1000 },
  });
});

// Admin stats (requires EVERCLAW_ADMIN_SECRET)
app.get("/api/stats", (req, res) => {
  if (!SECRET || req.headers["x-admin-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const stats = db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN is_revoked = 0 THEN 1 ELSE 0 END) as active FROM keys"
  ).get();

  res.json(stats);
});

// --- Start ---
app.listen(PORT, () => console.log(`EverClaw Key API on port ${PORT}`));

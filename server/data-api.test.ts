import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use process.cwd() to mirror the fix applied in server/_core/index.ts
const PROJECT_ROOT = process.cwd();

// ---------------------------------------------------------------
// Minimal Express app that mirrors the data API routes in _core/index.ts
// ---------------------------------------------------------------
function createTestApp() {
  const app = express();

  app.get("/api/data/gasoline-prices", (_req, res) => {
    try {
      const dataPath = join(PROJECT_ROOT, "server/data/gasoline_prices.json");
      const raw = readFileSync(dataPath, "utf-8");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=1800");
      res.send(raw);
    } catch {
      res.status(500).json({ error: "Failed to load gasoline price data" });
    }
  });

  app.get("/api/data/oil-reserves", (_req, res) => {
    try {
      const dataPath = join(PROJECT_ROOT, "server/data/oil_reserves.json");
      const raw = readFileSync(dataPath, "utf-8");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=1800");
      res.send(raw);
    } catch {
      res.status(500).json({ error: "Failed to load oil reserve data" });
    }
  });

  return app;
}

// ---------------------------------------------------------------
// Lightweight fetch helper (no external deps)
// ---------------------------------------------------------------
let baseUrl: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  const app = createTestApp();
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve()))
  );
});

// ---------------------------------------------------------------
// Tests: GET /api/data/gasoline-prices
// ---------------------------------------------------------------
describe("GET /api/data/gasoline-prices", () => {
  it("returns HTTP 200", async () => {
    const res = await fetch(`${baseUrl}/api/data/gasoline-prices`);
    expect(res.status).toBe(200);
  });

  it("responds with Content-Type application/json", async () => {
    const res = await fetch(`${baseUrl}/api/data/gasoline-prices`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns valid JSON with metadata and weekly array", async () => {
    const res = await fetch(`${baseUrl}/api/data/gasoline-prices`);
    const data = await res.json();
    expect(data).toHaveProperty("metadata");
    expect(data).toHaveProperty("weekly");
    expect(Array.isArray(data.weekly)).toBe(true);
    expect(data.weekly.length).toBeGreaterThan(0);
  });

  it("each weekly entry has required fields", async () => {
    const res = await fetch(`${baseUrl}/api/data/gasoline-prices`);
    const data = await res.json();
    const entry = data.weekly[0];
    expect(entry).toHaveProperty("date");
    expect(entry).toHaveProperty("regular");
    expect(entry).toHaveProperty("premium");
    expect(entry).toHaveProperty("diesel");
    expect(entry).toHaveProperty("kerosene_18L");
  });

  it("regular gasoline price is a positive number", async () => {
    const res = await fetch(`${baseUrl}/api/data/gasoline-prices`);
    const data = await res.json();
    const latest = data.weekly[data.weekly.length - 1];
    expect(typeof latest.regular).toBe("number");
    expect(latest.regular).toBeGreaterThan(0);
  });

  it("sets Cache-Control header", async () => {
    const res = await fetch(`${baseUrl}/api/data/gasoline-prices`);
    expect(res.headers.get("cache-control")).toContain("max-age=1800");
  });
});

// ---------------------------------------------------------------
// Tests: GET /api/data/oil-reserves
// ---------------------------------------------------------------
describe("GET /api/data/oil-reserves", () => {
  it("returns HTTP 200", async () => {
    const res = await fetch(`${baseUrl}/api/data/oil-reserves`);
    expect(res.status).toBe(200);
  });

  it("responds with Content-Type application/json", async () => {
    const res = await fetch(`${baseUrl}/api/data/oil-reserves`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns valid JSON with metadata and monthly array", async () => {
    const res = await fetch(`${baseUrl}/api/data/oil-reserves`);
    const data = await res.json();
    expect(data).toHaveProperty("metadata");
    expect(data).toHaveProperty("monthly");
    expect(Array.isArray(data.monthly)).toBe(true);
    expect(data.monthly.length).toBeGreaterThan(0);
  });

  it("each monthly entry has required reserve fields", async () => {
    const res = await fetch(`${baseUrl}/api/data/oil-reserves`);
    const data = await res.json();
    const entry = data.monthly[0];
    expect(entry).toHaveProperty("date");
    expect(entry).toHaveProperty("total_days");
    expect(entry).toHaveProperty("national_days");
    expect(entry).toHaveProperty("private_days");
    expect(entry).toHaveProperty("joint_days");
    expect(entry).toHaveProperty("total_volume_10k_kl");
    expect(entry).toHaveProperty("national_volume_10k_kl");
    expect(entry).toHaveProperty("private_volume_10k_kl");
    expect(entry).toHaveProperty("joint_volume_10k_kl");
  });

  it("total_days is a positive integer above 90 (IEA target)", async () => {
    const res = await fetch(`${baseUrl}/api/data/oil-reserves`);
    const data = await res.json();
    const latest = data.monthly[data.monthly.length - 1];
    expect(typeof latest.total_days).toBe("number");
    expect(latest.total_days).toBeGreaterThan(90);
  });

  it("national_days + private_days + joint_days equals total_days", async () => {
    const res = await fetch(`${baseUrl}/api/data/oil-reserves`);
    const data = await res.json();
    for (const entry of data.monthly) {
      const sum = entry.national_days + entry.private_days + entry.joint_days;
      expect(sum).toBe(entry.total_days);
    }
  });

  it("sets Cache-Control header", async () => {
    const res = await fetch(`${baseUrl}/api/data/oil-reserves`);
    expect(res.headers.get("cache-control")).toContain("max-age=1800");
  });
});

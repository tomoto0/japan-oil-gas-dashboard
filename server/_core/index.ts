import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the project root regardless of whether we are running from
// server/_core/ (dev via tsx) or dist/ (production build via esbuild).
// In dev:  __dirname = <root>/server/_core  → root is ../../
// In prod: __dirname = <root>/dist          → root is ../
// Using process.cwd() is the most reliable anchor since the server is
// always started from the project root.
const PROJECT_ROOT = process.cwd();

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Data API endpoints — serve JSON files from server/data/
  app.get("/api/data/gasoline-prices", (_req, res) => {
    try {
      const dataPath = join(PROJECT_ROOT, "server/data/gasoline_prices.json");
      const raw = readFileSync(dataPath, "utf-8");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=1800");
      res.send(raw);
    } catch (err) {
      console.error("[API] Failed to read gasoline_prices.json:", err);
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
    } catch (err) {
      console.error("[API] Failed to read oil_reserves.json:", err);
      res.status(500).json({ error: "Failed to load oil reserve data" });
    }
  });

  // Data refresh endpoint — scrapes pps-net.org for latest weekly gasoline prices
  app.post("/api/data/refresh", async (_req, res) => {
    try {
      const gasolinePath = join(PROJECT_ROOT, "server/data/gasoline_prices.json");
      const current = JSON.parse(readFileSync(gasolinePath, "utf-8"));

      // Fetch pps-net.org (source: 資源エネルギー庁 石油製品価格調査)
      const response = await fetch("https://pps-net.org/oilstand", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        throw new Error(`pps-net.org returned HTTP ${response.status}`);
      }

      const html = await response.text();

      // Extract chartData11 — the weekly retail price array embedded as JSON in the page
      // Fields: year (date string), genyu (premium), kihatsuyu (regular), toyu (diesel), keyu (kerosene store), juyu (kerosene delivery)
      // Use [\\s\\S] instead of dotAll flag (s) for ES2017 compatibility
      const match = html.match(/var chartData11 = (\[[\s\S]*?\]);/);
      if (!match) {
        throw new Error("Could not find chartData11 in pps-net.org response");
      }

      const rawRows: Array<{ year: string; genyu: number; kihatsuyu: number; toyu: number; keyu: number; juyu: number }> =
        JSON.parse(match[1]);

      // Convert to our schema: date YYYY-MM-DD, regular, premium, diesel, kerosene_18L
      const newRows = rawRows.map(r => {
        const [y, m, d] = r.year.split("/").map(Number);
        const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        return {
          date,
          regular: r.kihatsuyu,
          premium: r.genyu,
          diesel: r.toyu,
          kerosene_18L: Math.round(r.keyu * 18),
        };
      });

      // Merge with existing data (new rows override existing by date)
      const existing: Record<string, typeof newRows[0]> = {};
      for (const row of current.weekly) existing[row.date] = row;
      for (const row of newRows) existing[row.date] = row;

      const merged = Object.values(existing).sort((a, b) => a.date.localeCompare(b.date));
      const latestDate = merged[merged.length - 1]?.date ?? current.metadata.last_updated;

      const updated = {
        ...current,
        metadata: { ...current.metadata, last_updated: latestDate },
        weekly: merged,
      };

      writeFileSync(gasolinePath, JSON.stringify(updated, null, 2), "utf-8");

      const addedCount = newRows.filter(r => !current.weekly.find((e: { date: string }) => e.date === r.date)).length;
      console.log(`[Refresh] Gasoline data updated to ${latestDate} (+${addedCount} new rows, total ${merged.length})`);

      res.json({
        success: true,
        last_updated: latestDate,
        total_rows: merged.length,
        new_rows: addedCount,
        source: "pps-net.org (資源エネルギー庁)",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Refresh] Failed:", msg);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);

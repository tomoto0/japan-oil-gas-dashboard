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

  // Data refresh endpoint — scrapes pps-net.org for full monthly+weekly gasoline price history
  // Monthly data (2024-2025): parsed from the HTML table in title2 section
  // Weekly data (2026+): parsed from chartData11 JSON embedded in the page
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
        signal: AbortSignal.timeout(25000),
      });

      if (!response.ok) {
        throw new Error(`pps-net.org returned HTTP ${response.status}`);
      }

      const html = await response.text();

      // ---------------------------------------------------------------
      // STEP 1: Parse monthly data from the HTML table (title2 section)
      // The table has repeating blocks: header row (11 date cols) + 5 fuel rows
      // ---------------------------------------------------------------
      type GasolineRow = { date: string; regular: number; premium: number | null; diesel: number | null; kerosene_18L: number | null };

      const monthlyRows: Record<string, GasolineRow> = {};

      const idx2 = html.indexOf('id="title2"');
      const idx3 = html.indexOf('id="title3"', idx2);
      if (idx2 >= 0 && idx3 > idx2) {
        const section = html.slice(idx2, idx3);
        // Find the big monthly table
        const tableMatch = section.match(/<table[^>]*graph-description[^>]*>([\s\S]*?)<\/table>/);
        if (tableMatch) {
          const tableHtml = tableMatch[1];
          const rows = Array.from(tableHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)).map(m => m[1]);

          const FUEL_ORDER = ["premium", "regular", "diesel", "kerosene_store"] as const;

          let i = 0;
          while (i < rows.length) {
            const headerThs = Array.from(rows[i].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)).map(m => m[1].trim());
            const dateCols = headerThs.filter(t => /^\d{4}\/\d{1,2}$/.test(t));
            if (dateCols.length === 0) { i++; continue; }

            // Collect next fuel rows
            const fuelVals: Record<string, (number | null)[]> = { premium: [], regular: [], diesel: [], kerosene_store: [] };
            const FUEL_LABEL_MAP: Record<string, string> = {
              "ハイオク": "premium", "レギュラー": "regular", "軽油": "diesel", "灯油(店頭)": "kerosene_store",
            };
            let j = i + 1;
            let fuelCount = 0;
            while (j < rows.length && fuelCount < 4) {
              const thMatch = rows[j].match(/<th[^>]*>([\s\S]*?)<\/th>/);
              const label = thMatch ? thMatch[1].replace(/<[^>]+>/g, "").trim() : "";
              if (label in FUEL_LABEL_MAP) {
                const key = FUEL_LABEL_MAP[label];
                const tds = Array.from(rows[j].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map(m => {
                  const text = m[1].replace(/<[^>]+>/g, "").trim();
                  const num = text.match(/(\d+\.?\d*)/);
                  return num ? parseFloat(num[1]) : null;
                });
                // Pad to dateCols length
                while (tds.length < dateCols.length) tds.push(null);
                fuelVals[key] = tds.slice(0, dateCols.length);
                fuelCount++;
              }
              j++;
            }

            // Map to date entries
            for (let ci = 0; ci < dateCols.length; ci++) {
              const parts = dateCols[ci].split("/");
              const y = parseInt(parts[0]), m = parseInt(parts[1]);
              if (y < 2024) continue;
              const dateKey = `${y}-${String(m).padStart(2, "0")}-01`;
              const regular = (fuelVals.regular[ci] ?? null) as number | null;
              const premium = (fuelVals.premium[ci] ?? null) as number | null;
              const diesel = (fuelVals.diesel[ci] ?? null) as number | null;
              const ks = (fuelVals.kerosene_store[ci] ?? null) as number | null;
              if (regular !== null) {
                monthlyRows[dateKey] = {
                  date: dateKey, regular, premium, diesel,
                  kerosene_18L: ks !== null ? Math.round(ks * 18) : null,
                };
              }
            }
            i = j;
          }
        }
      }

      console.log(`[Refresh] Parsed ${Object.keys(monthlyRows).length} monthly rows (2024+)`);

      // ---------------------------------------------------------------
      // STEP 2: Parse weekly data from chartData11 (recent 13 weeks)
      // ---------------------------------------------------------------
      const weeklyMatch = html.match(/var chartData11 = (\[[\s\S]*?\]);/);
      if (!weeklyMatch) throw new Error("Could not find chartData11 in pps-net.org response");

      const rawWeekly: Array<{ year: string; genyu: number; kihatsuyu: number; toyu: number; keyu: number }> =
        JSON.parse(weeklyMatch[1]);

      const weeklyRows: GasolineRow[] = rawWeekly.map(r => {
        const [y, m, d] = r.year.split("/").map(Number);
        return {
          date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
          regular: r.kihatsuyu,
          premium: r.genyu,
          diesel: r.toyu,
          kerosene_18L: Math.round(r.keyu * 18),
        };
      });

      // ---------------------------------------------------------------
      // STEP 3: Merge — monthly base, weekly overrides (remove monthly placeholder for same month)
      // ---------------------------------------------------------------
      const merged: Record<string, GasolineRow> = { ...monthlyRows };
      for (const row of weeklyRows) {
        const monthKey = row.date.slice(0, 7) + "-01";
        if (monthKey in merged) delete merged[monthKey];
        merged[row.date] = row;
      }

      const allRows = Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));
      const latestDate = allRows[allRows.length - 1]?.date ?? current.metadata.last_updated;

      const updated = {
        ...current,
        metadata: {
          ...current.metadata,
          last_updated: latestDate,
          source: "pps-net.org (資源エネルギー庁 石油製品価格調査)",
          note: "2024-2025年は月次平均、2026年2月以降は週次データ",
        },
        weekly: allRows,
      };

      writeFileSync(gasolinePath, JSON.stringify(updated, null, 2), "utf-8");

      const prevDates = new Set(current.weekly.map((e: { date: string }) => e.date));
      const addedCount = allRows.filter(r => !prevDates.has(r.date)).length;
      console.log(`[Refresh] Gasoline data updated to ${latestDate} (+${addedCount} new rows, total ${allRows.length})`);

      res.json({
        success: true,
        last_updated: latestDate,
        total_rows: allRows.length,
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

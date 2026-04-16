import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { readFileSync } from "fs";
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

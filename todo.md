# Japan Oil & Gas Dashboard TODO

- [x] Copy gasoline_prices.json and oil_reserves.json into server/data/
- [x] Add REST API endpoints: GET /api/data/gasoline-prices and GET /api/data/oil-reserves
- [x] Build enhanced dashboard HTML (dashboard.html) in client/public/ with:
  - All 6 Chart.js charts preserved intact
  - 4 KPI cards: regular gasoline price, total reserve days, national reserve days, private reserve days
  - Week-over-week AND month-over-month change indicators on KPI cards
  - Manual refresh button in status bar
  - Auto-refresh every 30 minutes
  - Data fetched from backend REST API endpoints
  - Responsive layout using existing CSS grid system
- [x] Wire React Home.tsx to redirect to dashboard.html
- [x] Configure SEO/OGP meta tags in client/index.html (Japanese title, description, keywords)
- [x] Generate OGP image and upload to CDN
- [x] Write vitest tests for REST API endpoints
- [x] Run pnpm test - all 14 tests pass
- [x] Save checkpoint

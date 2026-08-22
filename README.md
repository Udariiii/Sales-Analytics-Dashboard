# RetailPulse AI

RetailPulse AI is a web-based sales analytics and predictive decision-support dashboard created for the CIS 6000 research project on AI-supported decision-making in SMEs.

## Features

- Requires each signed-in user to upload their own CSV, TSV or XLSX file; no sales data is bundled.
- Uses a free quantized MiniLM model in the browser to interpret unfamiliar column names without a paid AI API.
- Detects worksheets and header rows, profiles sample values, and asks only for mappings that genuinely need review.
- Requires only a sale date and net-sales field; other mapped fields dynamically unlock compatible analytics.
- Email/password sign-up and sign-in, Google login, password recovery and protected sessions.
- Processes raw uploaded rows locally without server-side file storage.
- Adapts historical KPIs, sales trends, profit, basket, category, payment, promotion and product panels to available evidence.
- Seven-day, 30-day, three-month and six-month revenue forecasts.
- A Render-hosted StatsForecast service with AutoETS, AutoARIMA, AutoTheta, dynamic Theta and seasonal-naive candidates.
- Five fast local candidates are retained and compared with StatsForecast; the lowest rolling historical error wins for each horizon.
- Honest WAPE, MAE, bias and empirical 80% historical-error ranges instead of a synthetic "accuracy" percentage.
- Optional DeepSeek V4 Flash analysis of compact verified metrics, with no raw spreadsheet rows sent to DeepSeek.
- Horizon-reconciled category demand outlook and evidence-based decision brief.
- Responsive desktop, tablet and mobile layouts.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Authentication setup

RetailPulse uses Supabase Auth. Create a Supabase project, copy `.env.example` to
`.env.local`, and add the project URL and publishable key. In Supabase Auth URL
Configuration, set the production Site URL and allow these redirects:

```text
http://localhost:3000/**
https://sales-analytics-dashboard-seven-lime.vercel.app/**
```

Enable Email authentication for account registration. For Google login, create
a Google Web OAuth client, add the Supabase callback URL shown in the Google
provider settings, and save its client ID and secret in Supabase.

For production email confirmation and password resets, configure a custom SMTP
provider in Supabase before inviting real users.

## Validation

```bash
npm test
```

When a local research CSV is present (it remains ignored and is never bundled), reproduce both forecast benchmarks with:

```bash
npm run benchmark:forecast -- "C:\path\to\sales.csv"
.venv-forecast\Scripts\python.exe forecast_service\benchmark.py "C:\path\to\sales.csv"
```

The benchmarks must be run on the same file before comparing model error.

## Deployment

Deploy the repository's `render.yaml` as a Render Blueprint. After Render
creates the `retailpulse-forecast` web service, copy its public URL.

In Vercel, add these Production and Preview variables:

```text
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
NEXT_PUBLIC_FORECAST_API_URL=https://your-service.onrender.com
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
```

Redeploy Vercel after saving the variables. Keep `DEEPSEEK_API_KEY` server-side;
never rename it with a `NEXT_PUBLIC_` prefix. Node.js 22 is declared in `package.json`.

The legacy Sites/Cloudflare-compatible build remains available through:

```bash
npm run build:sites
```

## Data handling

No sales dataset is included in the repository or deployment. CSV, TSV and
XLSX rows are read and analysed in browser memory and are not persisted by the
application. On first use, the browser downloads open-source model weights from
Hugging Face for semantic column matching. Raw sales rows are not sent to that
model host. Daily date-and-sales totals are sent to the configured Render
forecasting service. DeepSeek receives only compact verified metrics after the
user explicitly requests an AI analysis. Deterministic validation remains
authoritative for financial mappings and calculations.

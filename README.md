# RetailPulse AI

RetailPulse AI is a web-based sales analytics and predictive decision-support dashboard created for the CIS 6000 research project on AI-supported decision-making in SMEs.

## Features

- Requires each signed-in user to upload their own CSV; no sales data is bundled.
- Email/password sign-up and sign-in, Google login, password recovery and protected sessions.
- Processes uploaded transaction data locally in the browser without server-side file storage.
- Historical KPIs, sales trends, category contribution, payment mix and weekday analysis.
- Product and category rankings.
- Seven-day and 30-day sales forecasts.
- Chronological backtesting against unseen historical days.
- Seasonal-naive and trend-plus-weekday model comparison.
- WAPE, MAE and model-error-based forecast intervals.
- Category demand outlook and calculation-grounded executive summary.
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

## Deployment

The production application uses Supabase Auth as its managed backend and does
not require a separate Render service. Deploy the GitHub repository to Vercel
with the Next.js preset and add `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to the Production and Preview
environments. Vercel will run `npm run build` automatically. Node.js 22 is
declared in `package.json`.

The legacy Sites/Cloudflare-compatible build remains available through:

```bash
npm run build:sites
```

## Data handling

No sales dataset is included in the repository or deployment. CSV files are
read and analysed in browser memory and are not persisted by the application.

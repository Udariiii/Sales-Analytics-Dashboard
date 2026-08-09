# RetailPulse AI

RetailPulse AI is a web-based sales analytics and predictive decision-support dashboard created for the CIS 6000 research project on AI-supported decision-making in SMEs.

## Features

- Loads the included Sri Lankan supermarket CSV automatically.
- Accepts replacement CSV uploads using the documented sales schema.
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

## Validation

```bash
npm test
```

## Dataset disclosure

The included demonstration dataset is synthetic and modeled on realistic Sri Lankan supermarket operations. It contains no records obtained from an actual supermarket and should be described as simulated data in academic reporting.

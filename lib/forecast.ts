export type DailyPoint = {
  date: string;
  sales: number;
  profit: number;
  units: number;
  invoices: number;
};

export type ForecastPoint = {
  date: string;
  value: number;
  lower: number;
  upper: number;
};

export type ConfidenceLevel = "High" | "Moderate" | "Low" | "Very low";

export type ModelResult = {
  name: string;
  wape: number;
  mae: number;
  bias: number;
  foldWapes: number[];
  residuals: number[];
};

export type ForecastResult = {
  winner: ModelResult;
  baseline: ModelResult;
  models: ModelResult[];
  points: ForecastPoint[];
  folds: number;
  evaluatedDays: number;
  intervalCoverage: number;
  relativeImprovement: number;
  confidence: ConfidenceLevel;
  engine?: "StatsForecast" | "Browser fallback";
  historyDays?: number;
};

type ForecastModel = {
  name: string;
  predict: (history: DailyPoint[], horizon: number) => number[];
};

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function seasonalNaive(history: DailyPoint[], horizon: number) {
  const output: number[] = [];
  for (let i = 0; i < horizon; i++) {
    output.push(Math.max(0, i < 7 ? history[history.length - 7 + i]?.sales ?? 0 : output[i - 7]));
  }
  return output;
}

function weekdayValues(history: DailyPoint[], date: string, weeks: number) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return history
    .filter((point) => new Date(`${point.date}T00:00:00Z`).getUTCDay() === weekday)
    .slice(-weeks)
    .map((point) => point.sales)
    .sort((a, b) => a - b);
}

function weekdayAverage(history: DailyPoint[], horizon: number, weeks: number) {
  return Array.from({ length: horizon }, (_, i) => {
    const values = weekdayValues(history, addDays(history.at(-1)!.date, i + 1), weeks);
    return Math.max(0, values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
  });
}

function trimmedWeekdayAverage(history: DailyPoint[], horizon: number, weeks: number) {
  return Array.from({ length: horizon }, (_, i) => {
    const values = weekdayValues(history, addDays(history.at(-1)!.date, i + 1), weeks);
    const trimmed = values.length >= 6 ? values.slice(1, -1) : values;
    return Math.max(0, trimmed.reduce((sum, value) => sum + value, 0) / Math.max(1, trimmed.length));
  });
}

function trendWeekdayForecast(history: DailyPoint[], horizon: number) {
  const recent = history.slice(-84);
  const last28 = history.slice(-28);
  const previous28 = history.slice(-56, -28);
  const mean = (points: DailyPoint[]) => points.reduce((sum, point) => sum + point.sales, 0) / Math.max(1, points.length);
  const recentMean = mean(last28);
  const previousMean = mean(previous28);
  const growth = Math.max(-0.12, Math.min(0.12, previousMean ? recentMean / previousMean - 1 : 0));
  const weekdaySum = Array(7).fill(0) as number[];
  const weekdayCount = Array(7).fill(0) as number[];
  recent.forEach((point) => {
    const weekday = new Date(`${point.date}T00:00:00Z`).getUTCDay();
    weekdaySum[weekday] += point.sales;
    weekdayCount[weekday]++;
  });
  const overall = mean(recent);
  const weekdayFactor = weekdaySum.map((sum, weekday) => weekdayCount[weekday] ? sum / weekdayCount[weekday] / Math.max(1, overall) : 1);
  return Array.from({ length: horizon }, (_, i) => {
    const date = addDays(history.at(-1)!.date, i + 1);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const dampedTrend = 1 + growth * (1 - Math.exp(-(i + 1) / 21));
    return Math.max(0, recentMean * weekdayFactor[weekday] * dampedTrend);
  });
}

function solve(matrix: number[][], vector: number[]) {
  const size = vector.length;
  const augmented = matrix.map((row, i) => [...row, vector[i]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = Math.abs(augmented[column][column]) < 1e-9 ? 1e-9 : augmented[column][column];
    for (let j = column; j <= size; j++) augmented[column][j] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = column; j <= size; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map((row) => row[size]);
}

function calendarRidgeForecast(history: DailyPoint[], horizon: number) {
  const origin = new Date(`${history[0].date}T00:00:00Z`).getTime();
  const features = (date: string) => {
    const value = new Date(`${date}T00:00:00Z`);
    const elapsedDays = (value.getTime() - origin) / 86_400_000;
    const weekday = value.getUTCDay();
    const annualAngle = 2 * Math.PI * elapsedDays / 365.25;
    return [
      1,
      elapsedDays / 365.25,
      Math.sin(annualAngle),
      Math.cos(annualAngle),
      ...Array.from({ length: 6 }, (_, i) => weekday === i + 1 ? 1 : 0),
    ];
  };
  const design = history.map((point) => features(point.date));
  const featureCount = design[0].length;
  const xtx = Array.from({ length: featureCount }, () => Array(featureCount).fill(0) as number[]);
  const xty = Array(featureCount).fill(0) as number[];
  design.forEach((row, rowIndex) => row.forEach((value, a) => {
    xty[a] += value * history[rowIndex].sales;
    row.forEach((other, b) => { xtx[a][b] += value * other; });
  }));
  for (let i = 1; i < featureCount; i++) xtx[i][i] += 0.1;
  const coefficients = solve(xtx, xty);
  return Array.from({ length: horizon }, (_, i) => {
    const date = addDays(history.at(-1)!.date, i + 1);
    return Math.max(0, features(date).reduce((sum, value, feature) => sum + value * coefficients[feature], 0));
  });
}


function annualSeasonalForecast(history: DailyPoint[], horizon: number) {
  if (history.length < 392) return calendarRidgeForecast(history, horizon);
  const lag = 364;
  const mean = (points: DailyPoint[]) => points.reduce((sum, point) => sum + point.sales, 0) / Math.max(1, points.length);
  const recentMean = mean(history.slice(-56));
  const priorYearMean = mean(history.slice(-lag - 56, -lag));
  const levelAdjustment = Math.max(0.85, Math.min(1.15, priorYearMean ? recentMean / priorYearMean : 1));
  const fallback = calendarRidgeForecast(history, horizon);
  return Array.from({ length: horizon }, (_, i) => {
    const source = history[history.length - lag + i]?.sales;
    return Math.max(0, (source ?? fallback[i]) * levelAdjustment);
  });
}

function calendarAnnualBlend(history: DailyPoint[], horizon: number) {
  const calendar = calendarRidgeForecast(history, horizon);
  const annual = annualSeasonalForecast(history, horizon);
  const weekday = trimmedWeekdayAverage(history, horizon, 12);
  const annualWeight = horizon >= 90 ? 0.4 : 0.2;
  const calendarWeight = horizon >= 90 ? 0.4 : 0.55;
  const weekdayWeight = 1 - annualWeight - calendarWeight;
  return calendar.map((value, i) => Math.max(0, value * calendarWeight + annual[i] * annualWeight + weekday[i] * weekdayWeight));
}

const models: ForecastModel[] = [
  { name: "Seasonal naive", predict: seasonalNaive },
  { name: "Recent weekday average", predict: (history, horizon) => weekdayAverage(history, horizon, 8) },
  { name: "Robust weekday average", predict: (history, horizon) => trimmedWeekdayAverage(history, horizon, 8) },
  { name: "Trend + weekday", predict: trendWeekdayForecast },
  { name: "Calendar ridge", predict: calendarRidgeForecast },
  { name: "Annual seasonal", predict: annualSeasonalForecast },
  { name: "Calendar + annual blend", predict: calendarAnnualBlend },
];

function scoreModel(name: string, actual: number[], predicted: number[], foldWapes: number[]): ModelResult {
  const residuals = actual.map((value, i) => value - predicted[i]);
  const absoluteErrors = residuals.map(Math.abs);
  const actualTotal = Math.max(1, actual.reduce((sum, value) => sum + value, 0));
  return {
    name,
    wape: absoluteErrors.reduce((sum, value) => sum + value, 0) / actualTotal,
    mae: absoluteErrors.reduce((sum, value) => sum + value, 0) / Math.max(1, absoluteErrors.length),
    bias: residuals.reduce((sum, value) => sum + value, 0) / actualTotal,
    foldWapes,
    residuals,
  };
}

function quantile(values: number[], probability: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower] || 0) * fraction;
}

function confidenceFor(wape: number, folds: number): ConfidenceLevel {
  if (folds < 3 || wape > 0.3) return "Very low";
  if (wape > 0.2) return "Low";
  if (wape > 0.1) return "Moderate";
  return "High";
}

export function minimumHistoryDays(horizon: number) {
  return 84 + horizon;
}

export function buildForecast(daily: DailyPoint[], horizon: number): ForecastResult | null {
  if (daily.length < minimumHistoryDays(horizon)) return null;
  const folds: { train: DailyPoint[]; test: DailyPoint[] }[] = [];
  for (let end = daily.length; end - horizon >= 84 && folds.length < 8; end -= horizon) {
    folds.push({ train: daily.slice(0, end - horizon), test: daily.slice(end - horizon, end) });
  }

  const results = models.map((model) => {
    const actual: number[] = [];
    const predicted: number[] = [];
    const foldWapes: number[] = [];
    folds.forEach((fold) => {
      const foldActual = fold.test.map((point) => point.sales);
      const foldPredicted = model.predict(fold.train, horizon);
      actual.push(...foldActual);
      predicted.push(...foldPredicted);
      foldWapes.push(scoreModel(model.name, foldActual, foldPredicted, []).wape);
    });
    return scoreModel(model.name, actual, predicted, foldWapes);
  }).sort((a, b) => a.wape - b.wape);

  const winner = results[0];
  const baseline = results.find((result) => result.name === "Seasonal naive")!;
  const selectedModel = models.find((model) => model.name === winner.name)!;
  const values = selectedModel.predict(daily, horizon);
  const absoluteResiduals = winner.residuals.map(Math.abs);
  const interval = quantile(absoluteResiduals, 0.8);
  const intervalCoverage = absoluteResiduals.filter((error) => error <= interval).length / Math.max(1, absoluteResiduals.length);
  const points = values.map((value, i) => {
    const distanceScale = 1 + 0.6 * Math.sqrt((i + 1) / Math.max(1, horizon));
    const widenedInterval = interval * distanceScale;
    return {
      date: addDays(daily.at(-1)!.date, i + 1),
      value,
      lower: Math.max(0, value - widenedInterval),
      upper: value + widenedInterval,
    };
  });

  return {
    winner,
    baseline,
    models: results,
    points,
    folds: folds.length,
    evaluatedDays: folds.length * horizon,
    intervalCoverage,
    relativeImprovement: baseline.wape ? (baseline.wape - winner.wape) / baseline.wape : 0,
    confidence: confidenceFor(winner.wape, folds.length),
    engine: "Browser fallback",
    historyDays: daily.length,
  };
}

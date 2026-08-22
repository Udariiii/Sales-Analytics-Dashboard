export type SalesRow = {
  date: string;
  invoice: string;
  category: string;
  product: string;
  sku: string;
  quantity: number;
  gross: number;
  discount: number;
  net: number;
  profit: number;
  payment: string;
  promotion: string;
};

export type CanonicalField =
  | "date"
  | "netSales"
  | "invoice"
  | "category"
  | "product"
  | "quantity"
  | "profit"
  | "cost"
  | "grossSales"
  | "discount"
  | "discountRate"
  | "unitCost"
  | "sku"
  | "payment"
  | "promotion"
  | "customer"
  | "store";

type FieldKind = "date" | "number" | "text" | "identifier";

export type FieldDefinition = {
  label: string;
  description: string;
  kind: FieldKind;
  aliases: string[];
};

export const FIELD_DEFINITIONS: Record<CanonicalField, FieldDefinition> = {
  date: { label: "Sale date", description: "transaction, order, invoice or business date", kind: "date", aliases: ["date", "sale date", "sales date", "transaction date", "order date", "invoice date", "business date", "sold at", "created date"] },
  netSales: { label: "Net sales", description: "final revenue or sales amount after discounts", kind: "number", aliases: ["net sales", "net revenue", "revenue", "sales", "sales amount", "sale amount", "final amount", "total amount", "amount", "line total", "order total", "net amount", "total", "turnover"] },
  invoice: { label: "Invoice ID", description: "receipt, bill, transaction or order identifier", kind: "identifier", aliases: ["invoice id", "invoice number", "invoice no", "receipt id", "receipt number", "bill no", "bill number", "transaction id", "order id", "order number"] },
  category: { label: "Category", description: "product category, department, family or group", kind: "text", aliases: ["category", "product category", "department", "dept", "family", "product group", "item group", "division"] },
  product: { label: "Product", description: "product, item, service or description name", kind: "text", aliases: ["product", "product name", "item", "item name", "description", "item description", "product description", "service", "service name"] },
  quantity: { label: "Quantity", description: "number of units, items or volume sold", kind: "number", aliases: ["quantity", "qty", "units", "units sold", "item quantity", "sales quantity", "volume"] },
  profit: { label: "Gross profit", description: "gross profit, contribution or margin amount", kind: "number", aliases: ["gross profit", "profit", "profit amount", "gross margin", "margin amount", "contribution", "gp"] },
  cost: { label: "Total cost", description: "total cost of goods for the sales row", kind: "number", aliases: ["total cost", "cost amount", "cost of goods", "cogs", "purchase cost", "line cost"] },
  unitCost: { label: "Unit cost", description: "cost per single unit or item", kind: "number", aliases: ["unit cost", "cost per unit", "item cost", "unit purchase cost"] },
  grossSales: { label: "Gross sales", description: "sales before discounts, returns or deductions", kind: "number", aliases: ["gross sales", "gross revenue", "sales before discount", "subtotal", "gross amount"] },
  discount: { label: "Discount amount", description: "monetary discount, markdown or promotional reduction amount", kind: "number", aliases: ["discount amount", "discount value", "markdown amount", "promotion discount amount", "promo discount amount"] },
  discountRate: { label: "Discount rate", description: "discount percentage or decimal rate rather than a money amount", kind: "number", aliases: ["discount pct", "discount percent", "discount percentage", "discount rate", "markdown pct"] },
  sku: { label: "SKU", description: "stock keeping unit, item code or product identifier", kind: "identifier", aliases: ["sku", "item code", "product code", "stock code", "article number", "material code"] },
  payment: { label: "Payment method", description: "payment type, tender, channel or method", kind: "text", aliases: ["payment", "payment method", "payment type", "tender", "tender type", "payment channel"] },
  promotion: { label: "Promotion", description: "promotion, campaign, offer or coupon", kind: "text", aliases: ["promotion", "promo", "campaign", "offer", "coupon", "discount code"] },
  customer: { label: "Customer ID", description: "customer, member, account or shopper identifier", kind: "identifier", aliases: ["customer id", "customer", "member id", "client id", "account id", "shopper id", "loyalty id"] },
  store: { label: "Store or branch", description: "store, branch, outlet or location", kind: "text", aliases: ["store", "store name", "store id", "branch", "branch name", "outlet", "location", "shop"] },
};

export const CANONICAL_FIELDS = Object.keys(FIELD_DEFINITIONS) as CanonicalField[];

export type ColumnProfile = {
  index: number;
  header: string;
  samples: string[];
  nonBlank: number;
  numericRate: number;
  dateRate: number;
  kind: "date" | "number" | "text" | "mixed";
};

export type MappingChoice = {
  sourceIndex: number;
  target: CanonicalField | null;
  confidence: number;
  method: "Exact match" | "Smart rules" | "Local AI + validation" | "Manual";
  reason: string;
};

export type RawSheet = { sheet: string; data: unknown[][] };

export type ImportPreview = {
  fileName: string;
  sheetName: string;
  headerRow: number;
  headers: string[];
  rows: unknown[][];
  profiles: ColumnProfile[];
};

export type AnalyticsCapabilities = {
  salesTrend: boolean;
  forecast: boolean;
  profit: boolean;
  quantity: boolean;
  invoices: boolean;
  category: boolean;
  product: boolean;
  payment: boolean;
  promotion: boolean;
  customer: boolean;
  store: boolean;
};

export type ImportReport = {
  sourceRows: number;
  acceptedRows: number;
  rejectedRows: number;
  invalidDates: number;
  invalidSales: number;
  exactDuplicateRows: number;
  mappedFields: CanonicalField[];
  capabilities: AnalyticsCapabilities;
};

export type AppliedImport = { rows: SalesRow[]; report: ImportReport };

function cleanHeader(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function normalizedWords(value: string) {
  return value
    .normalize("NFKD")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function delimiterScore(text: string, delimiter: string) {
  return text.split(/\r?\n/).slice(0, 12).reduce((score, line) => {
    let quoted = false;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === delimiter && !quoted) count++;
    }
    return score + count;
  }, 0);
}

export function parseDelimited(text: string): unknown[][] {
  const delimiters = [",", "\t", ";", "|"];
  const delimiter = [...delimiters].sort((a, b) => delimiterScore(text, b) - delimiterScore(text, a))[0];
  const result: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(cell); cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) result.push(row);
      row = [];
    } else cell += character;
  }
  if (cell || row.length) { row.push(cell); if (row.some((value) => value.trim())) result.push(row); }
  return result;
}

function aliasStrength(header: string) {
  const normalized = normalizedWords(header);
  return CANONICAL_FIELDS.reduce((best, field) => {
    const aliases = FIELD_DEFINITIONS[field].aliases.map(normalizedWords);
    return Math.max(best, aliases.includes(normalized) ? 1 : aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized)) ? 0.6 : 0);
  }, 0);
}

export function detectHeaderRow(data: unknown[][]) {
  let bestRow = 0;
  let bestScore = -Infinity;
  data.slice(0, 25).forEach((row, rowIndex) => {
    const values = row.map(cleanHeader).filter(Boolean);
    const textValues = values.filter((value) => /[A-Za-z]/.test(value));
    const uniqueness = new Set(values.map(normalizedWords)).size;
    const score = textValues.length * 2 + uniqueness + values.reduce((sum, value) => sum + aliasStrength(value) * 7, 0) - rowIndex * 0.08;
    if (values.length >= 2 && score > bestScore) { bestScore = score; bestRow = rowIndex; }
  });
  return bestRow;
}

function excelSerialToDate(value: number) {
  if (value < 20_000 || value > 80_000) return "";
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function dateLike(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  if (typeof value === "number") return Boolean(excelSerialToDate(value));
  const raw = String(value ?? "").trim();
  return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T\s].*)?$/.test(raw)
    || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(raw)
    || /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}$/.test(raw)
    || /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}$/.test(raw);
}

export function parseNumeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "boolean" || value === null || value === undefined) return Number.NaN;
  let raw = String(value).trim();
  if (!raw || /^(?:n\/?a|null|none|-)$/i.test(raw)) return Number.NaN;
  const negative = /^\(.*\)$/.test(raw);
  raw = raw.replace(/[()]/g, "").replace(/[^0-9,.-]/g, "");
  if (raw.includes(",") && !raw.includes(".") && /,\d{1,2}$/.test(raw)) raw = raw.replace(",", ".");
  else raw = raw.replace(/,/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : Number.NaN;
}

function detectSlashOrder(values: unknown[]): "dmy" | "mdy" {
  for (const value of values) {
    const parts = String(value ?? "").trim().split(/[/-]/).map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) continue;
    if (parts[0] > 12) return "dmy";
    if (parts[1] > 12) return "mdy";
  }
  return "dmy";
}

export function normalizeDateValue(value: unknown, slashOrder: "dmy" | "mdy") {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return excelSerialToDate(value);
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let year: number, month: number, day: number;
  if (iso) [, year, month, day] = iso.map(Number);
  else {
    const parts = raw.split(/[/-]/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      if (String(parts[0]).length === 4) [year, month, day] = parts;
      else {
        year = parts[2] < 100 ? 2000 + parts[2] : parts[2];
        if (slashOrder === "dmy") { day = parts[0]; month = parts[1]; }
        else { month = parts[0]; day = parts[1]; }
      }
    } else {
      const parsed = Date.parse(raw);
      if (Number.isNaN(parsed)) return "";
      return new Date(parsed).toISOString().slice(0, 10);
    }
  }
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.getUTCFullYear() !== year! || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day!) return "";
  return date.toISOString().slice(0, 10);
}

function profileColumn(rows: unknown[][], header: string, index: number): ColumnProfile {
  const values = rows.slice(0, 800).map((row) => row[index]).filter((value) => value !== null && value !== undefined && String(value).trim() !== "");
  const numeric = values.filter((value) => Number.isFinite(parseNumeric(value))).length;
  const dates = values.filter(dateLike).length;
  const numericRate = numeric / Math.max(1, values.length);
  const dateRate = dates / Math.max(1, values.length);
  const kind = dateRate >= 0.7 ? "date" : numericRate >= 0.8 ? "number" : numericRate > 0.2 || dateRate > 0.2 ? "mixed" : "text";
  return { index, header, samples: [...new Set(values.slice(0, 40).map((value) => String(value).slice(0, 60)))].slice(0, 4), nonBlank: values.length, numericRate, dateRate, kind };
}

export function createImportPreview(fileName: string, sheet: RawSheet): ImportPreview {
  if (sheet.data.length < 2) throw new Error(`${sheet.sheet} does not contain enough rows to analyse.`);
  const headerRow = detectHeaderRow(sheet.data);
  const width = Math.max(...sheet.data.slice(headerRow).map((row) => row.length));
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, index) => {
    const base = cleanHeader(sheet.data[headerRow]?.[index]) || `Column ${index + 1}`;
    const count = (seen.get(base) || 0) + 1; seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  const rows = sheet.data.slice(headerRow + 1).filter((row) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ""));
  if (!rows.length) throw new Error(`${sheet.sheet} has headers but no data rows.`);
  return { fileName, sheetName: sheet.sheet, headerRow, headers, rows, profiles: headers.map((header, index) => profileColumn(rows, header, index)) };
}

function tokenSimilarity(a: string, b: string) {
  const left = new Set(normalizedWords(a).split(" ").filter(Boolean));
  const right = new Set(normalizedWords(b).split(" ").filter(Boolean));
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / Math.max(1, new Set([...left, ...right]).size);
}

export function compatibilityScore(profile: ColumnProfile, field: CanonicalField) {
  const definition = FIELD_DEFINITIONS[field];
  if (definition.kind === "date") return profile.dateRate >= 0.7 ? 1 : profile.dateRate >= 0.35 ? 0.65 : 0.12;
  if (definition.kind === "number") return profile.numericRate >= 0.8 ? 1 : profile.numericRate >= 0.45 ? 0.65 : 0.15;
  if (profile.kind === "date" || (profile.kind === "number" && definition.kind === "text")) return 0.35;
  return 1;
}

export function heuristicScore(profile: ColumnProfile, field: CanonicalField) {
  const header = normalizedWords(profile.header);
  const aliases = FIELD_DEFINITIONS[field].aliases.map(normalizedWords);
  const exact = aliases.includes(header);
  const containedAliases = aliases.filter((alias) => header.includes(alias) || alias.includes(header));
  const strongestContained = Math.max(0, ...containedAliases.map((alias) => Math.min(0.96, 0.76 + alias.length / Math.max(alias.length, header.length) * 0.2)));
  const semantic = Math.max(...aliases.map((alias) => tokenSimilarity(header, alias)), tokenSimilarity(header, FIELD_DEFINITIONS[field].description));
  let nameScore = exact ? 1 : strongestContained || semantic * 0.78;
  if (field === "netSales" && /\bgross\b/.test(header)) nameScore *= 0.35;
  if (field === "discount" && /\b(?:pct|percent|percentage|rate)\b/.test(header)) nameScore *= 0.35;
  if (field === "cost" && /\bunit\b/.test(header)) nameScore *= 0.35;
  return Math.min(1, nameScore * 0.82 + compatibilityScore(profile, field) * 0.18);
}

export function suggestMappings(profiles: ColumnProfile[]): MappingChoice[] {
  const candidates = profiles.flatMap((profile) => CANONICAL_FIELDS.map((field) => ({ profile, field, score: heuristicScore(profile, field) })))
    .sort((a, b) => b.score - a.score);
  const columns = new Set<number>();
  const fields = new Set<CanonicalField>();
  const selected = new Map<number, MappingChoice>();
  candidates.forEach(({ profile, field, score }) => {
    if (score < 0.42 || columns.has(profile.index) || fields.has(field)) return;
    const exact = FIELD_DEFINITIONS[field].aliases.map(normalizedWords).includes(normalizedWords(profile.header));
    selected.set(profile.index, { sourceIndex: profile.index, target: field, confidence: score, method: exact ? "Exact match" : "Smart rules", reason: exact ? "Header matches a known sales field." : "Header meaning and sample values are compatible." });
    columns.add(profile.index); fields.add(field);
  });
  return profiles.map((profile) => selected.get(profile.index) || { sourceIndex: profile.index, target: null, confidence: 0, method: "Smart rules", reason: "No safe match yet." });
}

function valueAt(row: unknown[], index: number | undefined) {
  return index === undefined ? undefined : row[index];
}

function textValue(value: unknown, fallback = "") {
  const output = String(value ?? "").trim();
  return output || fallback;
}

function analyticsCapabilities(mapped: Set<CanonicalField>): AnalyticsCapabilities {
  const core = mapped.has("date") && mapped.has("netSales");
  return {
    salesTrend: core,
    forecast: core,
    profit: mapped.has("profit") || mapped.has("cost"),
    quantity: mapped.has("quantity"),
    invoices: mapped.has("invoice"),
    category: mapped.has("category"),
    product: mapped.has("product"),
    payment: mapped.has("payment"),
    promotion: mapped.has("promotion") || mapped.has("discount") || mapped.has("discountRate"),
    customer: mapped.has("customer"),
    store: mapped.has("store"),
  };
}

export function applyMapping(preview: ImportPreview, choices: MappingChoice[]): AppliedImport {
  const fieldIndex = new Map<CanonicalField, number>();
  choices.forEach((choice) => { if (choice.target) fieldIndex.set(choice.target, choice.sourceIndex); });
  if (!fieldIndex.has("date") || !fieldIndex.has("netSales")) throw new Error("Map both Sale date and Net sales before generating the dashboard.");
  const mapped = new Set(fieldIndex.keys());
  const dateIndex = fieldIndex.get("date")!;
  const slashOrder = detectSlashOrder(preview.rows.slice(0, 1000).map((row) => valueAt(row, dateIndex)));
  let invalidDates = 0;
  let invalidSales = 0;
  const rows: SalesRow[] = [];
  const fingerprints = new Set<string>();
  let exactDuplicateRows = 0;
  preview.rows.forEach((source) => {
    const fingerprint = JSON.stringify(source);
    if (fingerprints.has(fingerprint)) exactDuplicateRows++;
    else fingerprints.add(fingerprint);
    const date = normalizeDateValue(valueAt(source, dateIndex), slashOrder);
    const net = parseNumeric(valueAt(source, fieldIndex.get("netSales")));
    if (!date) { invalidDates++; return; }
    if (!Number.isFinite(net)) { invalidSales++; return; }
    const numeric = (field: CanonicalField, fallback = 0) => {
      const parsed = parseNumeric(valueAt(source, fieldIndex.get(field)));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const quantity = numeric("quantity");
    const grossValue = fieldIndex.has("grossSales") ? numeric("grossSales") : Number.NaN;
    const rateValue = fieldIndex.has("discountRate") ? numeric("discountRate") : Number.NaN;
    const discountRate = Number.isFinite(rateValue) ? Math.abs(rateValue) <= 1 ? rateValue : rateValue / 100 : Number.NaN;
    const derivedDiscount = Number.isFinite(discountRate) && discountRate >= 0 && discountRate < 1
      ? Number.isFinite(grossValue) ? grossValue * discountRate : net / Math.max(0.0001, 1 - discountRate) - net
      : 0;
    const discount = fieldIndex.has("discount") ? numeric("discount") : derivedDiscount;
    const gross = Number.isFinite(grossValue) ? grossValue : net + discount;
    const totalCost = fieldIndex.has("cost") ? numeric("cost") : fieldIndex.has("unitCost") && fieldIndex.has("quantity") ? numeric("unitCost") * quantity : Number.NaN;
    const profit = fieldIndex.has("profit") ? numeric("profit") : Number.isFinite(totalCost) ? net - totalCost : 0;
    rows.push({
      date,
      invoice: textValue(valueAt(source, fieldIndex.get("invoice"))),
      category: textValue(valueAt(source, fieldIndex.get("category")), "Uncategorized"),
      product: textValue(valueAt(source, fieldIndex.get("product")), "Unspecified product"),
      sku: textValue(valueAt(source, fieldIndex.get("sku"))),
      quantity,
      gross,
      discount,
      net,
      profit,
      payment: textValue(valueAt(source, fieldIndex.get("payment")), "Unspecified"),
      promotion: textValue(valueAt(source, fieldIndex.get("promotion")), "None"),
    });
  });
  if (!rows.length) throw new Error("No usable sales rows remained after validating the mapped date and sales columns.");
  const capabilities = analyticsCapabilities(mapped);
  return {
    rows,
    report: {
      sourceRows: preview.rows.length,
      acceptedRows: rows.length,
      rejectedRows: preview.rows.length - rows.length,
      invalidDates,
      invalidSales,
      exactDuplicateRows,
      mappedFields: [...mapped],
      capabilities,
    },
  };
}

export function confidenceLabel(confidence: number) {
  return confidence >= 0.82 ? "High" : confidence >= 0.58 ? "Review" : "Low";
}

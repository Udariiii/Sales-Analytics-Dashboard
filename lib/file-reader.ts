import { parseDelimited, RawSheet } from "@/lib/sales-import";

export async function readSalesFile(file: File): Promise<RawSheet[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["csv", "tsv", "txt"].includes(extension || "")) {
    return [{ sheet: "Data", data: parseDelimited(await file.text()) }];
  }
  if (extension === "xlsx") {
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    const sheets = await readXlsxFile(file);
    return sheets.map((sheet) => ({ sheet: sheet.sheet, data: sheet.data }));
  }
  throw new Error("Choose a CSV, TSV or XLSX sales file.");
}

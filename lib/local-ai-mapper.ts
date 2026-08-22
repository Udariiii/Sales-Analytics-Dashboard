import { CANONICAL_FIELDS, ColumnProfile, compatibilityScore, FIELD_DEFINITIONS, heuristicScore, MappingChoice } from "@/lib/sales-import";

function dot(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * (right[index] || 0), 0);
}

export async function mapColumnsWithLocalAI(profiles: ColumnProfile[], onProgress?: (message: string) => void): Promise<MappingChoice[]> {
  onProgress?.("Downloading the private browser AI model for its first use…");
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", "onnx-community/all-MiniLM-L6-v2-ONNX", { dtype: "q4" });
  onProgress?.("AI is interpreting headers and sample value types…");
  const columnTexts = profiles.map((profile) => `Sales spreadsheet column named ${profile.header}. Detected ${profile.kind} values. Examples: ${profile.samples.slice(0, 3).join(", ")}.`);
  const fieldTexts = CANONICAL_FIELDS.map((field) => {
    const definition = FIELD_DEFINITIONS[field];
    return `${definition.label}: ${definition.description}. Similar names: ${definition.aliases.join(", ")}.`;
  });
  const output = await extractor([...columnTexts, ...fieldTexts], { pooling: "mean", normalize: true });
  const embeddings = output.tolist() as number[][];
  const columnVectors = embeddings.slice(0, profiles.length);
  const fieldVectors = embeddings.slice(profiles.length);
  const candidates = profiles.flatMap((profile, profileIndex) => CANONICAL_FIELDS.map((field, fieldIndex) => {
    const semantic = Math.max(0, dot(columnVectors[profileIndex], fieldVectors[fieldIndex]));
    const heuristic = heuristicScore(profile, field);
    const compatible = compatibilityScore(profile, field);
    const score = compatible < 0.3 ? Math.min(0.38, semantic * 0.5 + heuristic * 0.5) : semantic * 0.58 + heuristic * 0.42;
    return { profile, field, score };
  })).sort((a, b) => b.score - a.score);
  const usedColumns = new Set<number>();
  const usedFields = new Set<string>();
  const selected = new Map<number, MappingChoice>();
  candidates.forEach(({ profile, field, score }) => {
    if (score < 0.44 || usedColumns.has(profile.index) || usedFields.has(field)) return;
    selected.set(profile.index, {
      sourceIndex: profile.index,
      target: field,
      confidence: Math.min(0.99, score),
      method: "Local AI + validation",
      reason: "A local semantic model matched the meaning; data-type rules checked the result.",
    });
    usedColumns.add(profile.index);
    usedFields.add(field);
  });
  return profiles.map((profile) => selected.get(profile.index) || {
    sourceIndex: profile.index,
    target: null,
    confidence: 0,
    method: "Local AI + validation",
    reason: "The local model could not identify this column safely.",
  });
}

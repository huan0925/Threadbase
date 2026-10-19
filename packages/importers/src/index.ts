import { readFile } from "node:fs/promises";
import type { Importer, NormalizedConversation, SourceId } from "@threadbase/core";
import { unzipSync } from "fflate";
import { chatgptImporter } from "./chatgpt/index.ts";
import { claudeImporter } from "./claude/index.ts";

export { chatgptImporter, claudeImporter };

/** Every built-in importer. New providers are added here. */
export const importers: readonly Importer[] = [chatgptImporter, claudeImporter];

export interface LoadedExport {
  importer: Importer;
  conversations: NormalizedConversation[];
}

/**
 * Reads an export (the provider's .zip as downloaded, or the extracted
 * conversations.json) and parses it with the matching importer.
 * Pass `source` to skip auto-detection.
 */
export async function loadExport(path: string, source?: SourceId): Promise<LoadedExport> {
  const documents = await readJsonDocuments(path);
  const candidates = source ? importers.filter((i) => i.source === source) : importers;
  if (candidates.length === 0) {
    throw new Error(`Unknown source "${source}". Known sources: ${importers.map((i) => i.source).join(", ")}`);
  }

  for (const importer of candidates) {
    const matching = documents.filter((data) => importer.detect(data));
    if (matching.length > 0) {
      return { importer, conversations: matching.flatMap((data) => [...importer.parse(data)]) };
    }
  }
  if (documents.every((data) => Array.isArray(data) && data.length === 0)) {
    throw new Error(`${path} contains no conversations`);
  }
  throw new Error(`${path} doesn't look like a ${source ?? "supported"} chat export`);
}

async function readJsonDocuments(path: string): Promise<unknown[]> {
  const bytes = await readFile(path);
  if (!isZip(bytes)) return [JSON.parse(bytes.toString("utf8"))];

  const decoder = new TextDecoder();
  const files = unzipSync(bytes, { filter: (file) => /(^|\/)conversations[^/]*\.json$/.test(file.name) });
  const names = Object.keys(files).sort();
  if (names.length === 0) throw new Error(`${path} has no conversations.json inside`);
  return names.map((name) => JSON.parse(decoder.decode(files[name])));
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

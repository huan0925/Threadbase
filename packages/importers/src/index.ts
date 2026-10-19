import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
 * Reads an export (the provider's .zip as downloaded, the folder it was
 * extracted to, or its conversations.json) and parses it with the matching importer.
 * Pass `source` to skip auto-detection.
 */
export async function loadExport(path: string, source?: SourceId): Promise<LoadedExport> {
  const documents = await readJsonDocuments(path);
  for (const data of documents) {
    if (isExportManifest(data)) throw new Error(manifestMessage(path, data));
  }
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
  throw new Error(
    `${path} doesn't look like a ${source ?? "supported"} chat export. ` +
      "Import the export's .zip, the folder it was extracted to, or the conversations.json inside it.",
  );
}

const CONVERSATIONS_FILE = /(^|[/\\])conversations[^/\\]*\.json$/;

async function readJsonDocuments(path: string): Promise<unknown[]> {
  // Browsers such as Safari unzip downloads automatically, leaving a folder.
  if ((await stat(path)).isDirectory()) {
    const names = (await readdir(path, { recursive: true })).filter((name) => CONVERSATIONS_FILE.test(name)).sort();
    if (names.length === 0) throw new Error(`No conversations.json found in folder ${path}`);
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(path, name), "utf8"))));
  }

  const bytes = await readFile(path);
  if (!isZip(bytes)) return [JSON.parse(bytes.toString("utf8"))];

  const decoder = new TextDecoder();
  const files = unzipSync(bytes, { filter: (file) => CONVERSATIONS_FILE.test(file.name) });
  const names = Object.keys(files).sort();
  if (names.length === 0) throw new Error(`${path} has no conversations.json inside`);
  return names.map((name) => JSON.parse(decoder.decode(files[name])));
}

/**
 * Claude's export arrives as a manifest listing one zip per data category,
 * each downloaded separately from a short-lived link.
 */
interface ExportManifest {
  data_files: { category?: string; filename?: string }[];
}

function isExportManifest(data: unknown): data is ExportManifest {
  return typeof data === "object" && data !== null && Array.isArray((data as ExportManifest).data_files);
}

function manifestMessage(path: string, manifest: ExportManifest): string {
  const files = manifest.data_files
    .filter((file) => file.category === "conversations" && file.filename)
    .map((file) => file.filename);
  const wanted = files.length > 0 ? files.join(", ") : "the conversations files";
  return (
    `${path} is the export's list of download links, not the data itself. ` +
    `Open the export_url for ${wanted} in it (links expire 24 hours after the export was created), ` +
    "then import the downloaded zip."
  );
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

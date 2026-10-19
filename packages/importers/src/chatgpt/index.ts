import type { Importer, NormalizedConversation, NormalizedMessage, Role } from "@threadbase/core";
import { toEpochMs } from "../util.ts";

/**
 * ChatGPT export: Settings → Data controls → Export data. The emailed zip
 * contains `conversations.json`, an array of conversations whose messages
 * form a tree in `mapping` (editing or regenerating creates sibling branches).
 */

interface ChatGPTContent {
  content_type: string;
  parts?: unknown[];
  text?: string;
  result?: string;
  title?: string;
}

interface ChatGPTMessage {
  id: string;
  author: { role: string };
  create_time?: number | null;
  content?: ChatGPTContent;
  metadata?: { model_slug?: string; is_visually_hidden_from_conversation?: boolean };
}

interface ChatGPTNode {
  id: string;
  message?: ChatGPTMessage | null;
  parent?: string | null;
  children?: string[];
}

interface ChatGPTConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  mapping: Record<string, ChatGPTNode>;
  current_node?: string | null;
}

/** Content types that hold settings or model reasoning rather than conversation text. */
const SKIPPED_CONTENT_TYPES = new Set([
  "user_editable_context",
  "model_editable_context",
  "thoughts",
  "reasoning_recap",
]);

export const chatgptImporter: Importer = {
  source: "chatgpt",
  name: "ChatGPT",

  detect(data) {
    return Array.isArray(data) && data.length > 0 && isConversation(data[0]);
  },

  *parse(data) {
    if (!Array.isArray(data)) throw new Error("ChatGPT export must be a JSON array of conversations");
    for (const item of data) {
      if (isConversation(item)) yield normalizeConversation(item);
    }
  },
};

function isConversation(value: unknown): value is ChatGPTConversation {
  return typeof value === "object" && value !== null && "mapping" in value;
}

function normalizeConversation(conversation: ChatGPTConversation): NormalizedConversation {
  const id = conversation.conversation_id ?? conversation.id;
  if (!id) throw new Error(`ChatGPT conversation "${conversation.title}" has no id`);

  const { mapping } = conversation;
  const messages: NormalizedMessage[] = [];
  // Node id → id of the nearest kept message at or above it, so children of
  // skipped nodes (the empty root, hidden system prompts) attach correctly.
  const resolved = new Map<string, string | null>();

  // Depth-first walk keeps each branch contiguous and in conversation order.
  const roots = Object.values(mapping).filter((node) => !node.parent || !mapping[node.parent]);
  const stack: { node: ChatGPTNode; parentId: string | null }[] = roots
    .reverse()
    .map((node) => ({ node, parentId: null }));
  while (stack.length > 0) {
    const { node, parentId } = stack.pop()!;
    if (resolved.has(node.id)) continue;

    const message = node.message ? normalizeMessage(node.id, node.message, parentId) : null;
    if (message) messages.push(message);
    const resolvedId = message ? message.sourceId : parentId;
    resolved.set(node.id, resolvedId);

    for (const childId of [...(node.children ?? [])].reverse()) {
      const child = mapping[childId];
      if (child) stack.push({ node: child, parentId: resolvedId });
    }
  }

  const currentNode = conversation.current_node;
  return {
    source: "chatgpt",
    sourceId: id,
    title: conversation.title?.trim() || "Untitled",
    createdAt: toEpochMs(conversation.create_time),
    updatedAt: toEpochMs(conversation.update_time),
    url: `https://chatgpt.com/c/${id}`,
    activeLeafSourceId: currentNode ? (resolved.get(currentNode) ?? null) : null,
    messages,
    raw: conversation,
  };
}

function normalizeMessage(
  nodeId: string,
  message: ChatGPTMessage,
  parentId: string | null,
): NormalizedMessage | null {
  if (message.metadata?.is_visually_hidden_from_conversation) return null;
  const content = message.content;
  if (!content || SKIPPED_CONTENT_TYPES.has(content.content_type)) return null;

  const text = extractText(content).trim();
  if (!text) return null;

  return {
    sourceId: nodeId,
    parentSourceId: parentId,
    role: toRole(message.author.role),
    content: text,
    createdAt: toEpochMs(message.create_time),
    model: message.metadata?.model_slug ?? null,
  };
}

function extractText(content: ChatGPTContent): string {
  switch (content.content_type) {
    case "code":
    case "execution_output":
      return content.text ?? "";
    case "tether_quote":
      return [content.title, content.text].filter(Boolean).join("\n");
    case "tether_browsing_display":
      return content.result ?? "";
    default:
      if (Array.isArray(content.parts)) return content.parts.map(partToText).filter(Boolean).join("\n");
      return content.text ?? "";
  }
}

function partToText(part: unknown): string {
  if (typeof part === "string") return part;
  if (typeof part !== "object" || part === null) return "";
  const { content_type, text } = part as { content_type?: string; text?: string };
  if (content_type === "image_asset_pointer") return "[image]";
  if (content_type === "audio_transcription") return text ?? "";
  return "";
}

function toRole(role: string): Role {
  return role === "user" || role === "assistant" || role === "system" ? role : "tool";
}

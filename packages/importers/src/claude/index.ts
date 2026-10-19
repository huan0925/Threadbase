import type { Importer, NormalizedConversation, NormalizedMessage } from "@threadbase/core";
import { toEpochMs } from "../util.ts";

/**
 * Claude export: Settings → Privacy → Export data. The emailed zip contains
 * `conversations.json`, an array of conversations with a flat, chronological
 * `chat_messages` list. Newer exports link messages with `parent_message_uuid`.
 */

interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: { title?: string; content?: unknown };
}

interface ClaudeMessage {
  uuid: string;
  sender: "human" | "assistant" | string;
  text?: string;
  content?: ClaudeContentBlock[];
  created_at?: string;
  parent_message_uuid?: string | null;
  attachments?: { file_name?: string }[];
  files?: { file_name?: string }[];
}

interface ClaudeConversation {
  uuid: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  chat_messages: ClaudeMessage[];
}

export const claudeImporter: Importer = {
  source: "claude",
  name: "Claude",

  detect(data) {
    return Array.isArray(data) && data.length > 0 && isConversation(data[0]);
  },

  *parse(data) {
    if (!Array.isArray(data)) throw new Error("Claude export must be a JSON array of conversations");
    for (const item of data) {
      if (isConversation(item)) yield normalizeConversation(item);
    }
  },
};

function isConversation(value: unknown): value is ClaudeConversation {
  return typeof value === "object" && value !== null && "chat_messages" in value && "uuid" in value;
}

function normalizeConversation(conversation: ClaudeConversation): NormalizedConversation {
  const hasParentLinks = conversation.chat_messages.some((m) => m.parent_message_uuid !== undefined);
  const messages: NormalizedMessage[] = [];
  // Message uuid → nearest kept message at or above it (empty messages are dropped).
  const resolved = new Map<string, string | null>();
  let previousId: string | null = null;

  for (const message of conversation.chat_messages) {
    const parentId = hasParentLinks
      ? (resolved.get(message.parent_message_uuid ?? "") ?? null)
      : previousId;
    const text = extractText(message).trim();
    if (text) {
      messages.push({
        sourceId: message.uuid,
        parentSourceId: parentId,
        role: message.sender === "human" ? "user" : "assistant",
        content: text,
        createdAt: toEpochMs(message.created_at),
        model: null,
      });
      previousId = message.uuid;
    }
    resolved.set(message.uuid, text ? message.uuid : parentId);
  }

  return {
    source: "claude",
    sourceId: conversation.uuid,
    title: conversation.name?.trim() || "Untitled",
    createdAt: toEpochMs(conversation.created_at),
    updatedAt: toEpochMs(conversation.updated_at),
    url: `https://claude.ai/chat/${conversation.uuid}`,
    // The export doesn't mark the active branch; the latest message is the best guess.
    activeLeafSourceId: hasParentLinks ? (messages.at(-1)?.sourceId ?? null) : null,
    messages,
    raw: conversation,
  };
}

function extractText(message: ClaudeMessage): string {
  const parts: string[] = [];
  if (message.content && message.content.length > 0) {
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else if (block.type === "tool_use" && block.name === "artifacts") {
        // Artifacts (code, documents) are often the answer the user wants to find again.
        const body = typeof block.input?.content === "string" ? block.input.content : "";
        parts.push([`[artifact: ${block.input?.title ?? "untitled"}]`, body].filter(Boolean).join("\n"));
      }
    }
  } else if (message.text) {
    parts.push(message.text);
  }
  const fileNames = new Set([...(message.attachments ?? []), ...(message.files ?? [])].map((f) => f.file_name));
  for (const name of fileNames) {
    if (name) parts.push(`[attachment: ${name}]`);
  }
  return parts.join("\n");
}

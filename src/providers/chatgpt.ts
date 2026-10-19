import type { ConversationSummary, ProviderClient } from "../sync.ts";
import type { NormalizedConversation, NormalizedMessage, Role } from "../types.ts";
import { getJson, NotLoggedInError, toEpochMs, type FetchLike } from "./http.ts";

/**
 * ChatGPT, read through the same endpoints chatgpt.com's own UI uses.
 * Conversation messages form a tree in `mapping`: editing or regenerating a
 * message creates sibling branches, and `current_node` is the visible leaf.
 */

export const CHATGPT_ORIGIN = "https://chatgpt.com";
const PAGE_SIZE = 100;

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

export interface ChatGPTConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | string | null;
  update_time?: number | string | null;
  mapping: Record<string, ChatGPTNode>;
  current_node?: string | null;
}

interface ConversationListPage {
  items: { id: string; title?: string | null; update_time?: number | string | null }[];
  total?: number;
}

export function createChatGPTClient(fetch: FetchLike, origin = CHATGPT_ORIGIN): ProviderClient {
  let accessToken: Promise<string> | undefined;

  // The backend API wants a bearer token, which the session endpoint hands
  // to any page that carries the user's login cookies.
  const authHeaders = async () => {
    accessToken ??= getJson<{ accessToken?: string }>(`${origin}/api/auth/session`, { fetch, site: "ChatGPT" }).then(
      (session) => {
        if (!session.accessToken) throw new NotLoggedInError("ChatGPT");
        return session.accessToken;
      },
    );
    return { Authorization: `Bearer ${await accessToken}` };
  };

  return {
    source: "chatgpt",

    async *listConversations(): AsyncIterable<ConversationSummary> {
      const headers = await authHeaders();
      for (let offset = 0; ; ) {
        const page = await getJson<ConversationListPage>(
          `${origin}/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`,
          { fetch, site: "ChatGPT", headers },
        );
        for (const item of page.items) {
          yield { id: item.id, title: item.title ?? "", updatedAt: toEpochMs(item.update_time) };
        }
        offset += page.items.length;
        if (page.items.length === 0 || (typeof page.total === "number" && offset >= page.total)) return;
      }
    },

    async getConversation(id) {
      const conversation = await getJson<ChatGPTConversation>(`${origin}/backend-api/conversation/${id}`, {
        fetch,
        site: "ChatGPT",
        headers: await authHeaders(),
      });
      return normalizeChatGPTConversation({ ...conversation, conversation_id: conversation.conversation_id ?? id });
    },
  };
}

/** Content types that hold settings or model reasoning rather than conversation text. */
const SKIPPED_CONTENT_TYPES = new Set([
  "user_editable_context",
  "model_editable_context",
  "thoughts",
  "reasoning_recap",
]);

export function normalizeChatGPTConversation(conversation: ChatGPTConversation): NormalizedConversation {
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
    url: `${CHATGPT_ORIGIN}/c/${id}`,
    activeLeafSourceId: currentNode ? (resolved.get(currentNode) ?? null) : null,
    messages,
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

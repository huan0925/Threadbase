import type { ConversationSummary, ProviderClient } from "../sync.ts";
import type { NormalizedConversation, NormalizedMessage } from "../types.ts";
import { getJson, NotLoggedInError, toEpochMs, type FetchLike } from "./http.ts";

/**
 * Claude, read through the same endpoints claude.ai's own UI uses.
 * Conversations belong to an organization (a personal account is one too);
 * messages link to their parent with `parent_message_uuid`.
 */

export const CLAUDE_ORIGIN = "https://claude.ai";

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

export interface ClaudeConversation {
  uuid: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  current_leaf_message_uuid?: string | null;
  chat_messages: ClaudeMessage[];
}

interface ClaudeOrganization {
  uuid: string;
  capabilities?: string[];
}

interface ClaudeConversationSummary {
  uuid: string;
  name?: string | null;
  updated_at?: string;
}

export function createClaudeClient(fetch: FetchLike, origin = CLAUDE_ORIGIN): ProviderClient {
  /** Conversation uuid → the organization it belongs to, filled while listing. */
  const organizationOf = new Map<string, string>();

  return {
    source: "claude",

    async *listConversations(): AsyncIterable<ConversationSummary> {
      const organizations = await getJson<ClaudeOrganization[]>(`${origin}/api/organizations`, {
        fetch,
        site: "Claude",
      });
      if (!Array.isArray(organizations) || organizations.length === 0) throw new NotLoggedInError("Claude");

      const summaries: (ConversationSummary & { organization: string })[] = [];
      for (const organization of organizations) {
        // API-only organizations have no chats.
        if (organization.capabilities && !organization.capabilities.includes("chat")) continue;
        const conversations = await getJson<ClaudeConversationSummary[]>(
          `${origin}/api/organizations/${organization.uuid}/chat_conversations`,
          { fetch, site: "Claude" },
        );
        for (const conversation of conversations) {
          summaries.push({
            id: conversation.uuid,
            title: conversation.name ?? "",
            updatedAt: toEpochMs(conversation.updated_at),
            organization: organization.uuid,
          });
        }
      }

      summaries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      for (const { organization, ...summary } of summaries) {
        organizationOf.set(summary.id, organization);
        yield summary;
      }
    },

    async getConversation(id) {
      const organization = organizationOf.get(id);
      if (!organization) throw new Error(`Claude conversation ${id} wasn't in the conversation list`);
      const conversation = await getJson<ClaudeConversation>(
        `${origin}/api/organizations/${organization}/chat_conversations/${id}` +
          "?tree=True&rendering_mode=messages&render_all_tools=true",
        { fetch, site: "Claude" },
      );
      return normalizeClaudeConversation(conversation);
    },
  };
}

export function normalizeClaudeConversation(conversation: ClaudeConversation): NormalizedConversation {
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

  const leaf = conversation.current_leaf_message_uuid;
  return {
    source: "claude",
    sourceId: conversation.uuid,
    title: conversation.name?.trim() || "Untitled",
    createdAt: toEpochMs(conversation.created_at),
    updatedAt: toEpochMs(conversation.updated_at),
    url: `${CLAUDE_ORIGIN}/chat/${conversation.uuid}`,
    activeLeafSourceId: leaf
      ? (resolved.get(leaf) ?? null)
      : hasParentLinks
        ? (messages.at(-1)?.sourceId ?? null)
        : null,
    messages,
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

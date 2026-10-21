import { getConversation } from "../db.ts";
import { activeBranch, parseQuery } from "../search.ts";
import { SOURCE_NAMES } from "../types.ts";
import { el, formatDate, highlighted, sourceTag } from "./dom.ts";

const ROLE_LABELS = { user: "You", assistant: "Assistant", system: "System", tool: "Tool" } as const;

const viewer = document.querySelector<HTMLElement>("#viewer")!;
const params = new URLSearchParams(location.search);
const terms = parseQuery(params.get("q") ?? "");

async function render(): Promise<void> {
  const conversation = await getConversation(params.get("key") ?? "");
  if (!conversation) {
    viewer.replaceChildren(el("p", { className: "empty" }, ["This conversation isn't saved in Threadbase."]));
    return;
  }
  document.title = `${conversation.title} · Threadbase`;
  viewer.replaceChildren(
    el("h1", {}, highlighted(conversation.title, terms)),
    el("p", { className: "meta" }, [
      sourceTag(conversation.source),
      ` ${formatDate(conversation.createdAt)} · `,
      el("a", { href: conversation.url, target: "_blank", rel: "noreferrer" }, [
        `Open in ${SOURCE_NAMES[conversation.source]}`,
      ]),
    ]),
    ...activeBranch(conversation).map((message) =>
      el("section", { className: `message ${message.role}` }, [
        el("div", { className: "role" }, [
          [ROLE_LABELS[message.role], message.model].filter(Boolean).join(" · "),
        ]),
        el("div", { className: "content" }, highlighted(message.content, terms)),
      ]),
    ),
  );
  viewer.querySelector("mark")?.scrollIntoView({ block: "center" });
}

void render();

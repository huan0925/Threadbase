import { highlightSegments } from "../search.ts";
import { SOURCE_NAMES, type SourceId } from "../types.ts";

/**
 * Tiny DOM builder. Conversation text is always inserted as text nodes, never
 * as HTML, so chat content can't inject markup into extension pages.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

export function highlighted(text: string, terms: string[]): Node[] {
  return highlightSegments(text, terms).map((segment) =>
    segment.match ? el("mark", {}, [segment.text]) : document.createTextNode(segment.text),
  );
}

export function sourceTag(source: SourceId): HTMLElement {
  return el("span", { className: `source-tag ${source}` }, [SOURCE_NAMES[source]]);
}

export function formatDate(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatAgo(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(ms);
}

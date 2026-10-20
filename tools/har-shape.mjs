#!/usr/bin/env node
// Prints the *shape* of a site's internal API calls recorded in a HAR file,
// with every piece of text masked, so contributors can share how a site's
// API is structured without sharing their conversations.
//
//   node tools/har-shape.mjs recording.har [host]
//
// Strings become <text N> (N = length); ids that look like Gemini/Google ids
// become <id prefix_ N>. Numbers, booleans and nulls are kept: they're
// positions, flags and timestamps. Short arrays (records whose fields are
// identified by position) are shown whole; long ones (lists) only their
// first items. Pass a host to skip requests to other sites.
// Built for Google's batchexecute format (gemini.google.com) and plain JSON.
import { readFileSync } from "node:fs";

const LONG_ARRAY = 30;
const LIST_PREVIEW = 2;
const MAX_DEPTH = 24;

const [path, host] = process.argv.slice(2);
if (!path) {
  console.error("Usage: node har-shape.mjs <recording.har> [host]");
  process.exit(1);
}
const har = JSON.parse(readFileSync(path, "utf8"));

function maskString(value) {
  const id = value.match(/^([a-z]{1,3}_)[A-Za-z0-9]+$/);
  if (id) return `<id ${id[1]} ${value.length}>`;
  return `<text ${value.length}>`;
}

function shape(value, depth = 0) {
  if (typeof value === "string") return maskString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    if (value.length <= LONG_ARRAY) return value.map((item) => shape(item, depth + 1));
    const items = value.slice(0, LIST_PREVIEW).map((item) => shape(item, depth + 1));
    items.push(`… ${value.length - LIST_PREVIEW} more`);
    return items;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)]));
}

/** Parses a JSON string nested inside a response, falling back to masking it. */
function shapeNestedJson(text) {
  if (typeof text !== "string") return shape(text);
  try {
    return shape(JSON.parse(text));
  } catch {
    return maskString(text);
  }
}

function responseText(content) {
  if (!content?.text) return "";
  return content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
}

/** batchexecute responses: ")]}'" then length-prefixed JSON chunks of ["wrb.fr", rpcid, payloadJson, …]. */
function batchexecuteResults(text) {
  const results = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("[")) continue;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    for (const item of chunk) {
      if (Array.isArray(item) && item[0] === "wrb.fr") results.push({ rpcid: item[1], payload: shapeNestedJson(item[2]) });
    }
  }
  return results;
}

/** Values that identify the user or browser are withheld entirely. */
const SECRET_HEADERS = new Set(["cookie", "authorization", "x-client-data", "x-goog-authuser"]);
/** Plain protocol headers whose values are safe and useful to show. */
const SHOWN_HEADERS = new Set(["content-type", "x-same-domain", "origin", "accept"]);

/** Request header names; x-goog-* values as masked JSON shapes; other values hidden. */
function describeHeaders(headers) {
  return headers
    .filter(({ name }) => !name.startsWith(":"))
    .map(({ name, value }) => {
      const lower = name.toLowerCase();
      if (SECRET_HEADERS.has(lower)) return `${lower}=<withheld>`;
      if (SHOWN_HEADERS.has(lower)) return `${lower}=${value}`;
      if (lower.startsWith("x-goog-") || lower.startsWith("x-")) return `${lower}=${JSON.stringify(shapeNestedJson(value))}`;
      return lower;
    })
    .join(" | ");
}

function maskPath(pathname) {
  return pathname
    .split("/")
    .map((part) => (/^[a-z]{0,3}_?[0-9a-f]{8,}$/i.test(part) ? maskString(part) : part))
    .join("/");
}

/**
 * True when every script frame that led to the request belongs to an
 * extension. An extension that wraps XMLHttpRequest or fetch shows up in the
 * page's own calls too, but those also have the page's frames below it.
 */
function sentByExtension(initiator) {
  const urls = [];
  for (let stack = initiator?.stack; stack; stack = stack.parent) {
    for (const frame of stack.callFrames ?? []) if (frame.url) urls.push(frame.url);
  }
  if (initiator?.url) urls.push(initiator.url);
  return urls.length > 0 && urls.every((url) => url.startsWith("chrome-extension://"));
}

/** batchexecute calls kept for the page-vs-extension comparison at the end. */
const batchCalls = [];

let printed = 0;
for (const entry of har.log?.entries ?? []) {
  const { request, response } = entry;
  const url = new URL(request.url);
  if (host && url.host !== host) continue;
  const body = responseText(response.content);
  const isBatch = url.pathname.endsWith("/batchexecute");
  const isJson = body.trimStart().startsWith("{") || body.trimStart().startsWith("[") || body.startsWith(")]}'");
  if (!isBatch && !isJson) continue;

  printed++;
  const query = [...url.searchParams.keys()]
    .map((key) => (key === "rpcids" ? `rpcids=${url.searchParams.get(key)}` : key === "source-path" ? `source-path=${maskPath(url.searchParams.get(key))}` : key))
    .join(" ");
  const fromExtension = sentByExtension(entry._initiator);
  console.log(
    `\n=== ${request.method} ${url.host}${maskPath(url.pathname)} [${response.status}]${fromExtension ? " (sent by an extension)" : ""}`,
  );
  if (query) console.log(`query: ${query}`);
  if (isBatch) console.log(`headers: ${describeHeaders(request.headers ?? [])}`);

  if (isBatch) {
    const form = new URLSearchParams(request.postData?.text ?? "");
    batchCalls.push({
      rpcids: url.searchParams.get("rpcids") ?? "",
      fromExtension,
      fields: new Map([
        ...[...url.searchParams].map(([key, value]) => [`query ${key}`, value]),
        ...(request.headers ?? [])
          .filter(({ name }) => !name.startsWith(":"))
          .map(({ name, value }) => [`header ${name.toLowerCase()}`, value]),
        ...[...form].map(([key, value]) => [`form ${key}`, value]),
      ]),
    });
    console.log(`form fields: ${[...form.keys()].join(" ")}`);
    const freq = form.get("f.req");
    if (freq) {
      try {
        for (const [rpcid, args] of JSON.parse(freq)[0]) {
          console.log(`request ${rpcid} args: ${JSON.stringify(shapeNestedJson(args))}`);
        }
      } catch {
        console.log("request: (unparsed f.req)");
      }
    }
    for (const { rpcid, payload } of batchexecuteResults(body)) {
      console.log(`response ${rpcid}: ${JSON.stringify(payload)}`);
    }
  } else {
    try {
      console.log(`response: ${JSON.stringify(shape(JSON.parse(body.replace(/^\)\]\}'\n?/, ""))))}`);
    } catch {
      console.log(`response: <unparsed ${body.length} chars>`);
    }
  }
}
if (printed === 0) console.error("No JSON or batchexecute requests found in this HAR file.");

/** Positions (like [8][2]) where two JSON values differ; never the values themselves. */
function differingPaths(a, b, path = "") {
  if (Array.isArray(a) && Array.isArray(b)) {
    const paths = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) paths.push(...differingPaths(a[i], b[i], `${path}[${i}]`));
    return paths;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path || "(whole value)"];
}

function compareValues(a, b) {
  if (a === undefined) return "only in the second";
  if (b === undefined) return "only in the first";
  if (a === b) return "same";
  try {
    const paths = differingPaths(JSON.parse(a), JSON.parse(b));
    return `different at ${paths.slice(0, 8).join(" ")}${paths.length > 8 ? " …" : ""}`;
  } catch {
    return `different (length ${a.length} vs ${b.length})`;
  }
}

function compareCalls(label, first, second) {
  console.log(`\n### ${label}`);
  for (const key of new Set([...first.fields.keys(), ...second.fields.keys()])) {
    console.log(`${key}: ${compareValues(first.fields.get(key), second.fields.get(key))}`);
  }
}

const extensionCount = batchCalls.filter((call) => call.fromExtension).length;
console.log(`\n### summary: ${batchCalls.length} batchexecute calls, ${extensionCount} sent by an extension`);

// Same-or-different only, so values never appear in the output.
const extensionCall = batchCalls.find((call) => call.fromExtension);
if (extensionCall) {
  const pageCall =
    batchCalls.find((call) => !call.fromExtension && call.rpcids === extensionCall.rpcids) ??
    batchCalls.find((call) => !call.fromExtension);
  if (pageCall) compareCalls(`page ${pageCall.rpcids} vs extension ${extensionCall.rpcids}`, pageCall, extensionCall);
}
const [pageFirst, pageSecond] = batchCalls.filter((call) => !call.fromExtension);
if (pageFirst && pageSecond) {
  compareCalls(`page ${pageFirst.rpcids} vs the page's next call, ${pageSecond.rpcids}`, pageFirst, pageSecond);
}

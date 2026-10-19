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

function maskPath(pathname) {
  return pathname
    .split("/")
    .map((part) => (/^[a-z]{0,3}_?[0-9a-f]{8,}$/i.test(part) ? maskString(part) : part))
    .join("/");
}

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
  console.log(`\n=== ${request.method} ${url.host}${maskPath(url.pathname)} [${response.status}]`);
  if (query) console.log(`query: ${query}`);

  if (isBatch) {
    const form = new URLSearchParams(request.postData?.text ?? "");
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

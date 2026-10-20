import assert from "node:assert/strict";
import { test } from "node:test";
import { restampHeaders } from "../src/content/gemini-headers.ts";

test("renews the timestamp in the page's extension headers and nothing else", () => {
  const recorded =
    `[1,null,null,null,null,null,null,null,[4,5,6,8,16,19,20],null,null,null,null,null,null,null,"SESSION",["token"],null,[[1792423028,731000000]]]`;
  const now = Date.UTC(2026, 9, 20, 12, 0, 5, 250);
  const restamped = restampHeaders(
    {
      "x-goog-ext-525001261-jspb": recorded,
      "x-goog-ext-73010989-jspb": "[0]",
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      "x-goog-ext-1-jspb": "not json",
    },
    now,
  );
  assert.equal(
    restamped["x-goog-ext-525001261-jspb"],
    `[1,null,null,null,null,null,null,null,[4,5,6,8,16,19,20],null,null,null,null,null,null,null,"SESSION",["token"],null,[[${Math.floor(now / 1000)},250000000]]]`,
  );
  assert.equal(restamped["x-goog-ext-73010989-jspb"], "[0]", "small numbers aren't mistaken for timestamps");
  assert.equal(restamped["content-type"], "application/x-www-form-urlencoded;charset=utf-8");
  assert.equal(restamped["x-goog-ext-1-jspb"], "not json");
});

test("finds timestamps wherever the page puts them", () => {
  const now = 1_800_000_000_123;
  const { h } = restampHeaders({ h: "" }, now);
  assert.equal(h, "");
  const nested = restampHeaders({ "x-goog-ext-2-jspb": "[[],[1792423028,1]]" }, now)["x-goog-ext-2-jspb"];
  assert.equal(nested, "[[],[1800000000,123000000]]");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSnippet, parseQuery } from "../src/index.ts";

test("splits terms and routes short ones to LIKE", () => {
  assert.deepEqual(parseQuery('房貸 扣繳憑單 "GIN index" ok'), {
    terms: ["房貸", "扣繳憑單", "GIN index", "ok"],
    ftsTerms: ['"扣繳憑單"', '"GIN index"'],
    likeTerms: ["房貸", "ok"],
  });
});

test("escapes double quotes inside FTS phrases", () => {
  assert.deepEqual(parseQuery('say"hi"').ftsTerms, ['"say""hi"""']);
});

test("builds a single-line snippet around the first match", () => {
  const content = `${"a".repeat(100)}\n\nthe NEEDLE is here\n${"b".repeat(200)}`;
  const snippet = buildSnippet(content, ["needle"], 10, 20);
  assert.equal(snippet, "…aaaa the NEEDLE is here bbbbb…");
  assert.equal(buildSnippet("short text", ["missing"]), "short text");
});

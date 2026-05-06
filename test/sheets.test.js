import test from "node:test";
import assert from "node:assert/strict";
import { ensureHeaderRow, normalizeHeader, rowsToObjects } from "../lib/sheets.js";

test("normalizeHeader creates stable object keys", () => {
  assert.equal(normalizeHeader("Content Type"), "content_type");
  assert.equal(normalizeHeader(" Unique   Impressions "), "unique_impressions");
});

test("rowsToObjects preserves sheet row numbers", () => {
  const rows = [
    ["Date", "Post URL", "Content Type"],
    ["2026-05-06", "https://example.com", "image"],
  ];

  assert.deepEqual(rowsToObjects(rows), [
    {
      __rowNumber: 2,
      date: "2026-05-06",
      post_url: "https://example.com",
      content_type: "image",
    },
  ]);
});

test("ensureHeaderRow appends missing headers without removing legacy columns", async () => {
  const calls = [];
  const sheets = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { title: "Posts" } }] } }),
      batchUpdate: async () => calls.push(["batchUpdate"]),
      values: {
        get: async () => ({ data: { values: [["Date", "Topic", "Hook", "Output Folder", "Status", "Post URL"]] } }),
        update: async (request) => {
          calls.push(["update", request.requestBody.values[0]]);
          return {};
        },
      },
    },
  };

  const header = await ensureHeaderRow(sheets, "sheet-id", "Posts", [
    "Date",
    "Topic",
    "Hook",
    "Output Folder",
    "Status",
    "Post URL",
    "Content Type",
  ]);

  assert.deepEqual(header, ["Date", "Topic", "Hook", "Output Folder", "Status", "Post URL", "Content Type"]);
  assert.deepEqual(calls, [["update", header]]);
});

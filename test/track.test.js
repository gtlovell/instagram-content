import test from "node:test";
import assert from "node:assert/strict";
import { extractUrnFromUrl } from "../lib/linkedin.js";
import { today } from "../lib/content-contracts.js";
import { findPostRow, parseTrackArgs } from "../track.js";

test("extractUrnFromUrl supports common LinkedIn URL shapes", () => {
  assert.equal(
    extractUrnFromUrl("https://www.linkedin.com/feed/update/urn:li:share:1234567890/"),
    "urn:li:share:1234567890"
  );
  assert.equal(
    extractUrnFromUrl("https://www.linkedin.com/posts/org_slug-ugcPost-9876543210"),
    "urn:li:ugcPost:9876543210"
  );
  assert.equal(
    extractUrnFromUrl("https://www.linkedin.com/feed/update/urn:li:activity:555/"),
    "urn:li:activity:555"
  );
});

test("parseTrackArgs supports --urn and --folder", () => {
  assert.deepEqual(parseTrackArgs(["--all"]), { all: true });
  assert.deepEqual(parseTrackArgs(["https://example.com", "--urn", "urn:li:share:1", "--folder", "./output/a"]), {
    all: false,
    url: "https://example.com",
    manualUrn: "urn:li:share:1",
    folder: "./output/a",
  });
});

test("findPostRow uses folder first", () => {
  const posts = [
    { __rowNumber: 2, output_folder: "./output/one", status: "draft", date: today() },
    { __rowNumber: 3, output_folder: "./output/two", status: "draft", date: today() },
  ];

  assert.equal(findPostRow({ posts, url: "https://example.com", folder: "./output/two" }).__rowNumber, 3);
});

test("findPostRow refuses ambiguous recent drafts without folder", () => {
  const posts = [
    { __rowNumber: 2, output_folder: "./output/one", status: "draft", date: today() },
    { __rowNumber: 3, output_folder: "./output/two", status: "draft", date: today() },
  ];

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(findPostRow({ posts, url: "https://example.com", folder: null }), null);
  } finally {
    console.error = originalError;
  }
});

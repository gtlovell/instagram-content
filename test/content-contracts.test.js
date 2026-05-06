import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CAROUSEL_SLIDE_COUNT,
  finalPostText,
  parseGenerateArgs,
  slugify,
  validateContent,
  writeCommonOutputFiles,
} from "../lib/content-contracts.js";

test("parseGenerateArgs defaults to carousel and supports --type", () => {
  assert.deepEqual(parseGenerateArgs(["seed oils"]), { type: "carousel", topic: "seed oils" });
  assert.deepEqual(parseGenerateArgs(["--type", "post", "hidden sugar"]), { type: "post", topic: "hidden sugar" });
  assert.deepEqual(parseGenerateArgs(["--type", "image", "protein", "bars"]), { type: "image", topic: "protein bars" });
});

test("slugify strips unsafe folder characters", () => {
  assert.equal(slugify("The HFCS vs. Sugar Lie!"), "the-hfcs-vs-sugar-lie");
});

test("carousel validation rejects non-eight-slide output", () => {
  const content = {
    slides: Array.from({ length: CAROUSEL_SLIDE_COUNT - 1 }, (_, index) => ({
      slideNumber: index + 1,
      headline: `Headline ${index + 1}`,
      body: `Body ${index + 1}`,
    })),
    caption: "This is a valid-looking caption with enough length.",
  };

  assert.throws(() => validateContent("carousel", content), /exactly 8 slides/);
});

test("post validation and final text composition", () => {
  const content = validateContent("post", {
    hook: "Your protein bar is doing too much",
    body: "Most people read the calories and stop there.\n\nThe ingredient list is where the real signal lives, especially when the label is full of sweeteners and gums.",
    cta: "Save this before your next grocery run.",
    hashtags: ["#ultraprocessedfood", "#foodlabels", "#cleanstreak", "#nutritionlabel"],
  });

  assert.match(finalPostText(content), /Your protein bar/);
  assert.match(finalPostText(content), /#cleanstreak/);
});

test("image validation requires prompt, caption, and alt text", () => {
  const content = validateContent("image", {
    headline: "The label hides the answer",
    subheadline: "Scan the barcode before the claim on the front wins.",
    caption: "A compact LinkedIn caption with enough detail for validation.",
    imagePrompt: "A premium realistic editorial grocery aisle image focused on a nutrition label and barcode scanner moment, no readable text.",
    altText: "A shopper scans a packaged food barcode in a grocery aisle.",
  });

  assert.equal(content.headline, "The label hides the answer");
});

test("writeCommonOutputFiles creates manifest and content files", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-content-"));
  try {
    const result = writeCommonOutputFiles({
      type: "post",
      topic: "test topic",
      outputDir: dir,
      content: {
        hook: "A hook with enough words",
        body: "A body with enough detail to write a draft.",
        cta: "Save this.",
        hashtags: ["#ultraprocessedfood", "#foodlabels", "#cleanstreak"],
      },
      files: [join(dir, "post.txt")],
    });

    assert.equal(result.manifest.contentType, "post");
    assert.match(result.manifestPath, /manifest\.json$/);
    assert.match(result.contentPath, /content\.json$/);
    assert.match(result.captionPath, /caption\.txt$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

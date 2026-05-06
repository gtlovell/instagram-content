import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export const CONTENT_TYPES = ["carousel", "post", "image"];
export const CAROUSEL_SLIDE_COUNT = 8;

export const POSTS_HEADER = [
  "Date",
  "Topic",
  "Hook",
  "Output Folder",
  "Status",
  "Post URL",
  "Content Type",
  "Asset Count",
  "Caption Path",
  "Manifest Path",
  "Image Prompt Path",
];

export const METRICS_HEADER = [
  "Fetched At",
  "Post URL",
  "Post URN",
  "Topic",
  "Hook",
  "Impressions",
  "Unique Impressions",
  "Clicks",
  "Likes",
  "Comments",
  "Reposts",
  "Engagement Rate",
  "Content Type",
];

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function parseGenerateArgs(argv) {
  const args = [...argv];
  let type = "carousel";

  const typeIdx = args.indexOf("--type");
  if (typeIdx >= 0) {
    type = args[typeIdx + 1];
    args.splice(typeIdx, 2);
  }

  if (!CONTENT_TYPES.includes(type)) {
    throw new Error(`Unknown content type "${type}". Use one of: ${CONTENT_TYPES.join(", ")}.`);
  }

  const topic = args.join(" ").trim();
  if (!topic) {
    throw new Error('Usage: node generate.js [--type carousel|post|image] "your topic here"');
  }

  return { type, topic };
}

function assertString(value, field, minLength = 1) {
  if (typeof value !== "string" || value.trim().length < minLength) {
    throw new Error(`Generated content is missing required field: ${field}`);
  }
}

export function validateContent(type, content) {
  if (!content || typeof content !== "object") {
    throw new Error("Generated content must be an object.");
  }

  if (type === "carousel") {
    if (!Array.isArray(content.slides)) {
      throw new Error("Carousel content must include a slides array.");
    }
    if (content.slides.length !== CAROUSEL_SLIDE_COUNT) {
      throw new Error(`Carousel must contain exactly ${CAROUSEL_SLIDE_COUNT} slides; got ${content.slides.length}.`);
    }
    content.slides.forEach((slide, index) => {
      const expectedNumber = index + 1;
      if (Number(slide.slideNumber) !== expectedNumber) {
        throw new Error(`Carousel slide ${expectedNumber} has invalid slideNumber.`);
      }
      assertString(slide.headline, `slides[${index}].headline`, 3);
      if (expectedNumber !== CAROUSEL_SLIDE_COUNT) {
        assertString(slide.body, `slides[${index}].body`, 3);
      }
    });
    assertString(content.caption, "caption", 20);
    return content;
  }

  if (type === "post") {
    assertString(content.hook, "hook", 8);
    assertString(content.body, "body", 80);
    assertString(content.cta, "cta", 8);
    if (!Array.isArray(content.hashtags) || content.hashtags.length < 3) {
      throw new Error("Post content must include at least 3 hashtags.");
    }
    content.hashtags.forEach((tag, index) => assertString(tag, `hashtags[${index}]`, 2));
    return content;
  }

  if (type === "image") {
    assertString(content.headline, "headline", 8);
    assertString(content.subheadline, "subheadline", 8);
    assertString(content.caption, "caption", 20);
    assertString(content.imagePrompt, "imagePrompt", 40);
    assertString(content.altText, "altText", 20);
    return content;
  }

  throw new Error(`Unsupported content type: ${type}`);
}

export function finalPostText(content) {
  return [content.hook, content.body, content.cta, content.hashtags.join(" ")]
    .filter(Boolean)
    .join("\n\n");
}

export function getHook(type, content) {
  if (type === "carousel") return content.slides[0]?.headline || "";
  if (type === "post") return content.hook || "";
  if (type === "image") return content.headline || "";
  return "";
}

export function getAssetCount(type, content) {
  if (type === "carousel") return content.slides.length;
  if (type === "image") return 1;
  return 0;
}

export function ensureOutputDir(topic, type) {
  const outputDir = `./output/${today()}-${type}-${slugify(topic)}`;
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

export function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function writeCommonOutputFiles({ type, topic, outputDir, content, files }) {
  const manifestPath = resolve(outputDir, "manifest.json");
  const contentPath = resolve(outputDir, "content.json");
  const captionPath = resolve(outputDir, "caption.txt");

  const manifest = {
    generatedAt: new Date().toISOString(),
    contentType: type,
    topic,
    hook: getHook(type, content),
    assetCount: getAssetCount(type, content),
    files,
  };

  writeJson(contentPath, content);
  if (type === "post") {
    writeFileSync(captionPath, finalPostText(content));
  } else if (content.caption) {
    writeFileSync(captionPath, content.caption);
  }
  writeJson(manifestPath, manifest);

  return { manifestPath, contentPath, captionPath, manifest };
}

export function debugModelResponse(type, text) {
  const dir = "./research";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `claude-debug-${type}-${Date.now()}.txt`);
  writeFileSync(path, text);
  return path;
}

export function parseJsonResponse(type, text) {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (err) {
        const debugPath = debugModelResponse(type, text);
        throw new Error(`JSON parse failed: ${err.message}; saved raw response to ${debugPath}`);
      }
    }
    const debugPath = debugModelResponse(type, text);
    throw new Error(`No JSON object found in model response; saved raw response to ${debugPath}`);
  }
}

export function assertPngDimensions(filePath, expectedWidth, expectedHeight, minBytes = 50 * 1024) {
  const stats = statSync(filePath);
  if (stats.size < minBytes) {
    throw new Error(`PNG ${filePath} is only ${Math.round(stats.size / 1024)} KB; expected at least ${Math.round(minBytes / 1024)} KB.`);
  }

  const dimensions = readPngDimensions(readFileSync(filePath));
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new Error(`PNG ${filePath} is ${dimensions.width}x${dimensions.height}; expected ${expectedWidth}x${expectedHeight}.`);
  }
  return dimensions;
}

export function readPngDimensions(buffer) {
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("File is not a PNG.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

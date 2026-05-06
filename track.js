import "dotenv/config";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { METRICS_HEADER, POSTS_HEADER, today } from "./lib/content-contracts.js";
import { extractUrnFromUrl, fetchPostMetrics } from "./lib/linkedin.js";
import {
  appendObjectRow,
  getSheetsClient,
  readObjects,
  updateObjectRow,
} from "./lib/sheets.js";
import { requireEnv } from "./lib/retry.js";

const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LINKEDIN_ORGANIZATION_ID = process.env.LINKEDIN_ORGANIZATION_ID;
const SHEETS_ID = process.env.SHEETS_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH || "./credentials/sheets-service-account.json";

export function parseTrackArgs(argv) {
  if (!argv.length) {
    throw new Error("Usage: node track.js <url> [--urn urn:li:share:XXXXX] [--folder ./output/...] OR node track.js --all");
  }

  if (argv[0] === "--all") return { all: true };

  const args = [...argv];
  const url = args.shift();
  const urnIdx = args.indexOf("--urn");
  const folderIdx = args.indexOf("--folder");

  return {
    all: false,
    url,
    manualUrn: urnIdx >= 0 ? args[urnIdx + 1] : null,
    folder: folderIdx >= 0 ? args[folderIdx + 1] : null,
  };
}

function isoDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function sameFolder(a = "", b = "") {
  if (!a || !b) return false;
  const cleanA = a.replace(/\/$/, "");
  const cleanB = b.replace(/\/$/, "");
  return cleanA === cleanB || resolve(cleanA) === resolve(cleanB);
}

async function loadPosts(sheets) {
  return readObjects(sheets, SHEETS_ID, "Posts", POSTS_HEADER, 1000);
}

export function findPostRow({ posts, url, folder }) {
  if (folder) {
    const match = posts.find((row) => sameFolder(row.output_folder, folder));
    if (!match) {
      throw new Error(`No Posts draft found for --folder ${folder}.`);
    }
    return match;
  }

  const byUrl = posts.find((row) => row.post_url && row.post_url.trim() === url.trim());
  if (byUrl) return byUrl;

  const cutoff = isoDaysAgo(14);
  const recentDrafts = posts.filter((row) => row.status === "draft" && (row.date || "") >= cutoff);
  if (recentDrafts.length === 1) return recentDrafts[0];

  if (recentDrafts.length > 1) {
    console.error("Multiple recent draft rows found. Re-run with --folder:");
    for (const row of recentDrafts) {
      console.error(`  ${row.output_folder || "(missing folder)"} | ${row.content_type || "carousel"} | ${row.topic || ""}`);
    }
  }

  return null;
}

async function writeMetricsToSheet(sheets, row) {
  await appendObjectRow(sheets, SHEETS_ID, "Metrics", METRICS_HEADER, row);
}

function printMetrics(metrics) {
  console.log(`  Impressions: ${metrics.impressions}`);
  console.log(`  Unique Impressions: ${metrics.uniqueImpressions}`);
  console.log(`  Clicks: ${metrics.clicks}`);
  console.log(`  Likes: ${metrics.likes}`);
  console.log(`  Comments: ${metrics.comments}`);
  console.log(`  Reposts: ${metrics.reposts}`);
}

async function updatePostRowAsPosted(sheets, header, row, url) {
  const next = { ...row, status: "posted", post_url: url };
  await updateObjectRow(sheets, SHEETS_ID, "Posts", header, row.__rowNumber, next);
  console.log(`  Updated Posts row ${row.__rowNumber} to posted.`);
}

export async function trackUrl(sheets, { url, manualUrn = null, folder = null, skipPostUpdate = false }) {
  console.log(`\nTracking: ${url}`);

  const postUrn = manualUrn || extractUrnFromUrl(url);
  if (!postUrn) {
    throw new Error("Could not extract post URN from URL. Provide it manually with --urn urn:li:share:XXXXX.");
  }
  console.log(`  URN: ${postUrn}`);

  const metrics = await fetchPostMetrics({
    accessToken: LINKEDIN_ACCESS_TOKEN,
    organizationId: LINKEDIN_ORGANIZATION_ID,
    postUrn,
  });
  if (!metrics) {
    throw new Error("No metrics returned. Check that the post is published and token has r_organization_social.");
  }
  printMetrics(metrics);

  const { header, objects: posts } = await loadPosts(sheets);
  const postRow = findPostRow({ posts, url, folder });

  if (!postRow && !skipPostUpdate) {
    throw new Error("No unambiguous Posts row found. Re-run with --folder <outputDir>.");
  }

  await writeMetricsToSheet(sheets, {
    fetched_at: today(),
    post_url: url,
    post_urn: postUrn,
    topic: postRow?.topic || "",
    hook: postRow?.hook || "",
    impressions: metrics.impressions,
    unique_impressions: metrics.uniqueImpressions,
    clicks: metrics.clicks,
    likes: metrics.likes,
    comments: metrics.comments,
    reposts: metrics.reposts,
    engagement_rate: metrics.engagement,
    content_type: postRow?.content_type || "carousel",
  });

  console.log("  Written to Metrics tab.");

  if (postRow && !skipPostUpdate && postRow.status !== "posted") {
    await updatePostRowAsPosted(sheets, header, postRow, url);
  }
}

export async function trackAll(sheets) {
  console.log("Fetching metrics for all posted entries...");

  const { objects: posts } = await loadPosts(sheets);
  if (!posts.length) {
    console.log("No posts found in Posts tab.");
    return;
  }

  const posted = posts.filter((row) => row.status === "posted" && row.post_url);
  console.log(`Found ${posted.length} posted entries.`);

  for (const row of posted) {
    await trackUrl(sheets, {
      url: row.post_url,
      manualUrn: null,
      folder: row.output_folder || null,
      skipPostUpdate: true,
    }).catch((err) => console.error(`  Error tracking ${row.post_url}: ${err.message}`));
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseTrackArgs(argv);
  requireEnv("LINKEDIN_ACCESS_TOKEN", "tracking");
  requireEnv("LINKEDIN_ORGANIZATION_ID", "tracking");
  requireEnv("SHEETS_ID", "tracking");

  const sheets = await getSheetsClient({ credentialsPath: CREDENTIALS_PATH });

  if (args.all) {
    await trackAll(sheets);
    return;
  }

  await trackUrl(sheets, args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

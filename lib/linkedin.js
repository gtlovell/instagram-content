import { withRetry } from "./retry.js";

export const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202604";

export function extractUrnFromUrl(url) {
  const shareMatch = url.match(/urn:li:share:(\d+)/);
  if (shareMatch) return `urn:li:share:${shareMatch[1]}`;

  const ugcMatch = url.match(/ugcPost[_-](\d+)/i);
  if (ugcMatch) return `urn:li:ugcPost:${ugcMatch[1]}`;

  const activityMatch = url.match(/activity:(\d+)/);
  if (activityMatch) return `urn:li:activity:${activityMatch[1]}`;

  return null;
}

export async function fetchPostMetrics({ accessToken, organizationId, postUrn }) {
  const orgUrn = `urn:li:organization:${organizationId}`;
  const url =
    "https://api.linkedin.com/rest/organizationalEntityShareStatistics" +
    `?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}` +
    `&shares=List(${encodeURIComponent(postUrn)})`;

  const res = await withRetry(`LinkedIn metrics for ${postUrn}`, () =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    })
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LinkedIn API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const element = data?.elements?.[0];
  if (!element) return null;

  const s = element.totalShareStatistics || {};
  return {
    impressions: s.impressionCount || 0,
    uniqueImpressions: s.uniqueImpressionsCount || 0,
    clicks: s.clickCount || 0,
    likes: s.likeCount || 0,
    comments: s.commentCount || 0,
    reposts: s.shareCount || 0,
    engagement: s.engagement || 0,
  };
}

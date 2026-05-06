# CleanStreak LinkedIn Content Pipeline Guide

## What This System Does

The pipeline has four jobs:

| Script | Job |
|---|---|
| `research.js` | Searches LinkedIn keywords through Apify, sends top posts to Claude for analysis, saves `research/latest.json`, and appends to Sheets |
| `generate.js` | Creates a draft in one of three formats: `carousel`, `post`, or `image` |
| `track.js` | Pulls LinkedIn metrics, appends a Metrics row, and updates the matching generated draft to `posted` |
| `iterate.js` | Joins Posts and Metrics, compares performance by format, and refreshes the Playbook |

## One-Time Setup

```bash
cp .env.example .env
npm install
chmod +x run.sh
```

Fill `.env`:

```bash
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6

OPENAI_API_KEY=
OPENAI_IMAGE_MODEL=gpt-image-1.5
OPENAI_IMAGE_QUALITY=medium

APIFY_TOKEN=

SHEETS_ID=
GOOGLE_CREDENTIALS_PATH=./credentials/sheets-service-account.json

LINKEDIN_ACCESS_TOKEN=
LINKEDIN_ORGANIZATION_ID=
LINKEDIN_API_VERSION=202604

OFFER_MONTHLY_PRICE=$5.99/mo
OFFER_LIFETIME_PRICE=$29.99
OFFER_LIMIT=First 1,000 only
OFFER_CTA_TEXT=Link in Bio
```

Google Sheets setup:

1. Create a Google Cloud service account and download the JSON key.
2. Save it at `./credentials/sheets-service-account.json`, or update `GOOGLE_CREDENTIALS_PATH`.
3. Share the Google Sheet with the service account email as Editor.
4. Enable the Google Sheets API.

LinkedIn setup:

1. Create or use a LinkedIn app attached to the Company Page.
2. Use an OAuth token with `r_organization_social`.
3. Set `LINKEDIN_ORGANIZATION_ID` to the numeric ID from `urn:li:organization:XXXXXXXX`.

## Google Sheet Tabs

The scripts create missing tabs and append new columns without deleting old data.

| Tab | Purpose |
|---|---|
| `Posts` | Generated drafts and posted URLs |
| `Metrics` | Each LinkedIn tracking fetch |
| `Research` | Scraped LinkedIn posts |
| `Playbook` | Current strategy and format recommendations |

New Posts columns include `Content Type`, `Asset Count`, `Caption Path`, `Manifest Path`, and `Image Prompt Path`. Old six-column Posts rows still work.

## Generate Drafts

Carousel is the default:

```bash
./run.sh generate "seed oils hiding in bread"
./run.sh generate --type carousel "seed oils hiding in bread"
```

Text-only post:

```bash
./run.sh generate --type post "why granola bars are candy"
```

Single-image post:

```bash
./run.sh generate --type image "natural flavors on food labels"
```

Each output folder is under:

```bash
./output/YYYY-MM-DD-<type>-<topic-slug>/
```

Every format writes `manifest.json`, `content.json`, and `caption.txt`.

Format-specific assets:

```text
carousel: slide-01.png ... slide-08.png
post:     post.txt
image:    image-raw.png, image-final.png, image-prompt.txt
```

## Track Posted Content

After posting manually on LinkedIn, pass the live URL and the generated output folder:

```bash
./run.sh track "https://www.linkedin.com/posts/..." --folder ./output/2026-05-06-image-natural-flavors-on-food-labels
```

If LinkedIn’s URL format does not expose the URN:

```bash
./run.sh track "https://www.linkedin.com/posts/..." --urn urn:li:share:1234567890 --folder ./output/...
```

The tracker:

1. Fetches LinkedIn metrics.
2. Appends to `Metrics`.
3. Updates the matching `Posts` row to `status: posted`.
4. Saves the live `Post URL`.

If `--folder` is omitted, the tracker updates the only recent draft when there is exactly one. If multiple recent drafts exist, it prints candidates and asks you to rerun with `--folder`.

Refresh all posted content:

```bash
./run.sh track --all
```

## Iterate

```bash
./run.sh iterate
```

The iteration engine scores posts as:

```text
score = reposts * 5 + comments * 3 + likes
```

It now reports format performance for `carousel`, `post`, and `image`, then writes a refreshed Playbook with `next_content_ideas`.

## Validation

```bash
npm run check
npm test
```

`npm run check` syntax-checks all scripts and tests. `npm test` runs no-network unit tests for parsing, contracts, sheet migration, URN extraction, draft matching, and manifest writing.

## Troubleshooting

`Carousel must contain exactly 8 slides`
: Claude returned the wrong contract. The raw response is saved under `research/claude-debug-carousel-*.txt`.

`Missing OPENAI_API_KEY`
: Only image posts require OpenAI. Carousel and text posts only require Anthropic.

`No Posts draft found for --folder`
: Confirm the folder path matches the `Output Folder` value in the Posts tab.

`Could not extract post URN`
: Use `--urn urn:li:share:...` or `--urn urn:li:ugcPost:...`.

`LinkedIn API 403`
: Refresh the access token and confirm it has `r_organization_social` for the organization page.

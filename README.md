# LinkedIn Authority Content Pipeline

Research, generate, track, and iterate LinkedIn content across three formats: carousel documents, text-only posts, and single-image posts. The current configured example is CleanStreak, but the workflow is intended to support broader niche authority building, personal brand growth, and career advancement.

| Script | Job |
|---|---|
| `research.js` | Scrapes LinkedIn posts through Apify, analyzes winners with Claude, and appends results to Sheets |
| `generate.js` | Creates `carousel`, `post`, or `image` drafts from research, playbook, and metrics context |
| `track.js` | Fetches LinkedIn metrics, writes Metrics rows, and updates generated drafts to `posted` |
| `iterate.js` | Scores past posts by format and refreshes the content playbook |

## Quick Start

```bash
cp .env.example .env
npm install
chmod +x run.sh
./run.sh weekly
./run.sh generate "your niche framework"
./run.sh generate --type post "your contrarian lesson"
./run.sh generate --type image "your memorable concept"
```

## Commands

```bash
./run.sh research
./run.sh generate <topic>                 # default: carousel
./run.sh generate --type carousel <topic>
./run.sh generate --type post <topic>
./run.sh generate --type image <topic>
./run.sh track <url> --folder <outputDir>
./run.sh track <url> --urn <urn> --folder <outputDir>
./run.sh track --all
./run.sh iterate
./run.sh daily [--type carousel|post|image] <topic>
./run.sh weekly
npm run check
npm test
```

## Output

Every generated draft writes:

- `manifest.json`
- `content.json`
- `caption.txt`

Format-specific files:

- Carousel: `slide-01.png` through `slide-08.png`
- Text post: `post.txt`
- Image post: `image-raw.png`, `image-final.png`, `image-prompt.txt`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude content generation and analysis |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-4-6` |
| `OPENAI_API_KEY` | Yes for image posts | OpenAI image generation |
| `OPENAI_IMAGE_MODEL` | No | Defaults to `gpt-image-1.5` |
| `OPENAI_IMAGE_QUALITY` | No | Defaults to `medium` |
| `APIFY_TOKEN` | Yes for research | Apify LinkedIn scraping |
| `SHEETS_ID` | Yes for Sheets/track/iterate | Google Sheet ID |
| `GOOGLE_CREDENTIALS_PATH` | No | Defaults to `./credentials/sheets-service-account.json` |
| `LINKEDIN_ACCESS_TOKEN` | Yes for track | LinkedIn OAuth token |
| `LINKEDIN_ORGANIZATION_ID` | Yes for track | Numeric organization ID |
| `LINKEDIN_API_VERSION` | No | Defaults to `202604` |
| `OFFER_MONTHLY_PRICE` | No | CTA offer copy |
| `OFFER_LIFETIME_PRICE` | No | CTA offer copy |
| `OFFER_LIMIT` | No | CTA offer copy |
| `OFFER_CTA_TEXT` | No | CTA button text |

Start with [AUTHORITY_GUIDE.md](AUTHORITY_GUIDE.md) for the full authority-building workflow. See [GUIDE.md](GUIDE.md) for the technical setup and command reference.

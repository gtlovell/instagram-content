# LinkedIn Authority Content Pipeline Guide

This guide explains how to use this pipeline as a repeatable authority-building system for LinkedIn. It is not limited to CleanStreak. CleanStreak is the current configured example brand, but the workflow can support any focused niche, personal brand, product thesis, consulting practice, job-search positioning, or career moat.

The goal is simple: publish sharper content, learn from the market, track what earns attention, and turn that feedback into a stronger point of view over time.

## What This Tool Is For

Use this pipeline to:

- Build visible authority in a niche.
- Develop a clear public point of view.
- Create consistent LinkedIn posts without starting from a blank page.
- Turn high-performing market patterns into your own original posts.
- Compare content formats instead of guessing what works.
- Track posts after publishing and use performance data to improve future drafts.
- Support career goals such as better inbound opportunities, recruiting visibility, advisory credibility, consulting leads, founder credibility, or product audience growth.

This is not an auto-publishing bot. It is a research, drafting, tracking, and iteration system. You still review the draft, edit it in your voice, and post manually.

## Mental Model

The pipeline has four loops:

| Loop | Command | Purpose |
|---|---|---|
| Market research | `./run.sh research` | Find what is already working in your niche |
| Draft generation | `./run.sh generate ...` | Create a carousel, text post, or image post |
| Performance tracking | `./run.sh track ...` | Pull LinkedIn metrics after posting |
| Strategy iteration | `./run.sh iterate` | Update the playbook based on actual results |

The system gets better when you complete the full loop. If you only generate drafts and never track posts, the playbook will not learn what actually advances your authority.

## Define Your Authority Strategy

Before using the tool heavily, write a simple authority brief for yourself. This gives the generated content a strategic direction.

Use this structure:

```text
Niche:
Who I want to be known by:
What I want to be known for:
Career outcome I want:
Topics I can speak about credibly:
Topics I want to avoid:
Tone:
Proof I can reference:
Offer or next step:
```

Example:

```text
Niche: AI product engineering and developer tools
Who I want to be known by: founders, engineering leaders, product teams
What I want to be known for: building practical AI tools that ship, not demos
Career outcome I want: advisory opportunities, senior engineering credibility, founder network
Topics I can speak about credibly: AI workflows, product engineering, code agents, developer UX
Topics I want to avoid: generic AI news, hype threads, shallow tool lists
Tone: direct, practical, technical, opinionated
Proof I can reference: shipped projects, benchmarks, implementation lessons, mistakes learned
Offer or next step: follow, comment, DM, newsletter, portfolio, consulting call
```

Store this brief somewhere easy to reference. The current scripts use the configured brand and niche in prompts, so if you are moving beyond CleanStreak, use this brief when editing prompts or generated drafts.

## Configure the Tool for Your Niche

The current repo defaults are written around CleanStreak and food-label content. To use the system for a broader personal authority strategy, update these areas:

| Area | Where | What to adapt |
|---|---|---|
| Research keywords | `research.js` | Replace the keyword list with your niche terms |
| Brand/person positioning | `generate.js` | Replace CleanStreak-specific positioning with your authority brief |
| CTA copy | `.env` | Replace offer text with your desired next step |
| Docs/examples | README/GUIDE files | Keep examples aligned with your niche |
| Google Sheet | Sheets tabs | Use the same tab structure for any niche |

For career authority, your CTA may not be a product offer. It can be:

- `Follow for practical breakdowns on AI product engineering.`
- `Comment BUILD and I’ll send the checklist.`
- `DM me if your team is trying to turn AI prototypes into shipped workflow tools.`
- `Save this before your next architecture review.`
- `I’m documenting what I learn building this in public.`

## Setup

Install dependencies:

```bash
cp .env.example .env
npm install
chmod +x run.sh
```

Fill in `.env`:

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

OFFER_MONTHLY_PRICE=
OFFER_LIFETIME_PRICE=
OFFER_LIMIT=
OFFER_CTA_TEXT=
```

For non-product authority building, treat the offer variables as generic CTA variables. They are currently named around a product offer, but you can use them for career-oriented next steps until the code is generalized further.

## Google Sheet Structure

The scripts create and maintain four tabs:

| Tab | Purpose |
|---|---|
| `Research` | Market examples scraped from LinkedIn |
| `Playbook` | Strategy recommendations generated from research and performance |
| `Posts` | Drafts generated by this tool and their publish status |
| `Metrics` | LinkedIn metrics fetched after posts go live |

The important tracking fields are:

- `Topic`
- `Hook`
- `Content Type`
- `Output Folder`
- `Status`
- `Post URL`
- `Impressions`
- `Likes`
- `Comments`
- `Reposts`
- `Clicks`

Do not treat likes as the only signal. For authority building, comments and reposts often matter more because they show that your ideas are creating conversation and peer endorsement.

## Content Formats

The generator supports three content types.

### Carousel

Command:

```bash
./run.sh generate "your topic"
./run.sh generate --type carousel "your topic"
```

Best for:

- Frameworks
- Step-by-step breakdowns
- Contrarian explanations
- Complex ideas that need sequencing
- Career-capital posts that should feel polished and saveable

Output:

```text
slide-01.png ... slide-08.png
caption.txt
content.json
manifest.json
```

Use carousel posts when you want to teach a concept and make people save or share it.

### Text-Only Post

Command:

```bash
./run.sh generate --type post "your topic"
```

Best for:

- Strong opinions
- Personal lessons
- Short stories
- Career reflections
- Founder/operator observations
- Fast reactions to something happening in your niche

Output:

```text
post.txt
caption.txt
content.json
manifest.json
```

Use text posts when you want to sound direct, human, and conversational.

### Single-Image Post

Command:

```bash
./run.sh generate --type image "your topic"
```

Best for:

- Visual metaphors
- Before/after comparisons
- One strong claim
- A memorable concept
- A polished authority-building asset

Output:

```text
image-raw.png
image-final.png
image-prompt.txt
caption.txt
content.json
manifest.json
```

The tool uses Claude for the concept and copy, OpenAI Images for the raw visual, and Puppeteer for the final text overlay.

## Recommended Weekly Workflow

### Monday: Research the Market

```bash
./run.sh weekly
```

This runs:

```text
research -> iterate
```

Review the `Playbook` tab. Look for:

- Winning hooks
- Repeated pain points
- Common formats
- Content gaps
- Topics with high comment/repost potential
- Ideas that align with the reputation you want

### Tuesday to Thursday: Generate and Publish

Pick one idea from the playbook or your own content backlog:

```bash
./run.sh generate --type post "why most AI prototypes never become products"
```

Open the output folder, review the draft, and edit it before posting.

Editing checklist:

- Does this sound like you?
- Is the first line strong enough?
- Is the claim specific?
- Is there a real lesson, not just a take?
- Does it support the authority you want?
- Is the CTA natural?
- Would the right person comment, save, or DM?

### After Publishing: Track the Post

Once the post is live, copy the LinkedIn URL and run:

```bash
./run.sh track "https://www.linkedin.com/posts/..." --folder ./output/YYYY-MM-DD-type-topic
```

If the URL does not expose the LinkedIn URN:

```bash
./run.sh track "https://www.linkedin.com/posts/..." --urn urn:li:share:1234567890 --folder ./output/YYYY-MM-DD-type-topic
```

Track again after engagement has settled:

```bash
./run.sh track "https://www.linkedin.com/posts/..." --folder ./output/YYYY-MM-DD-type-topic
```

Good checkpoints:

- 2 hours after posting
- 24 hours after posting
- 48 to 72 hours after posting

### Friday: Refresh Performance

```bash
./run.sh track --all
./run.sh iterate
```

Then review which content types and topics are moving your authority forward.

## Choosing Topics

Strong authority content usually comes from one of these buckets:

| Bucket | Example |
|---|---|
| Contrarian truth | `Why most AI workflow tools fail after the demo` |
| Field lesson | `What I learned shipping an agent into a real codebase` |
| Mistake teardown | `The hidden cost of letting AI write code without product context` |
| Framework | `A 4-part test for whether an AI feature is worth building` |
| Before/after | `How our workflow changed after adding code review automation` |
| Myth correction | `AI does not remove product taste. It exposes whether you have any.` |
| Tool/process breakdown | `The exact loop I use to turn rough ideas into working prototypes` |
| Career signal | `What senior engineers should be learning before AI changes the job again` |

Avoid topics that are only interesting because they are trending. The point is not to post news. The point is to show how you think.

## What to Track Beyond Metrics

LinkedIn metrics are useful, but authority also has qualitative signals.

Add notes manually in the Google Sheet when useful:

- Who commented?
- Did the right people engage?
- Did anyone DM you?
- Did it create a recruiting, consulting, advisory, sales, or collaboration opportunity?
- Did it clarify your positioning?
- Did people quote your language back to you?
- Did it attract peers or only casual likes?

For career advancement, one comment from the right operator can matter more than 100 passive likes.

## Interpreting Results

Use this scoring formula as the default:

```text
score = reposts * 5 + comments * 3 + likes
```

General interpretation:

- High impressions, low engagement: the hook may work, but the idea did not land.
- Low impressions, high comments: the idea may be strong but the hook or timing needs work.
- High reposts: the idea carries social currency.
- High comments: the idea creates conversation.
- High clicks: the CTA or offer is relevant.
- High saves: the content is useful enough to revisit, if you track saves manually.

Do not overreact to one post. Look for patterns across at least 5 to 10 posts.

## Building a Career-Advancing Content Mix

A strong weekly mix might look like:

| Day | Format | Purpose |
|---|---|---|
| Monday | Text post | Opinion or lesson from the field |
| Tuesday | Carousel | Framework or teardown |
| Wednesday | Text post | Personal story or career signal |
| Thursday | Image post | One memorable concept |
| Friday | Text post | Reflection, recap, or discussion prompt |

If you have limited time, publish three times per week:

```text
1 opinion post
1 teaching post
1 proof/lesson post
```

Authority grows from repeated association. Pick a narrow lane and stay there long enough for people to connect your name with the topic.

## Review Before Posting

Before anything goes live, ask:

- Is this aligned with the niche I want to own?
- Does this make me look more credible to the right audience?
- Is there a concrete insight?
- Is there a sentence someone would quote?
- Does the hook create curiosity without becoming clickbait?
- Did I remove generic language?
- Did I add my own lived context?
- Is the CTA appropriate for my career goal?

The generated draft is a starting point. The authority comes from your judgment.

## Common Commands

```bash
# Research and refresh strategy
./run.sh weekly

# Generate default carousel
./run.sh generate "your topic"

# Generate text-only post
./run.sh generate --type post "your topic"

# Generate single-image post
./run.sh generate --type image "your topic"

# Track one live post
./run.sh track "https://www.linkedin.com/posts/..." --folder ./output/YYYY-MM-DD-type-topic

# Track all posted rows
./run.sh track --all

# Rebuild playbook from current metrics
./run.sh iterate

# Validate local scripts
npm run check
npm test
```

## Troubleshooting

`Missing ANTHROPIC_API_KEY`
: Required for content generation, research analysis, and playbook iteration.

`Missing OPENAI_API_KEY`
: Required only for `--type image`.

`Carousel must contain exactly 8 slides`
: The model returned the wrong shape. Check `research/claude-debug-carousel-*.txt`.

`No Posts draft found for --folder`
: Confirm the folder path matches the `Output Folder` value in the `Posts` tab.

`Multiple recent draft rows found`
: Rerun tracking with `--folder` so the system knows which draft became the live LinkedIn post.

`Could not extract post URN`
: Use `--urn urn:li:share:...` or `--urn urn:li:ugcPost:...`.

`LinkedIn API 403`
: Refresh the LinkedIn token and confirm it has organization social read access.

## Practical Rule

Use the tool to accelerate the loop, not replace your point of view.

The highest-value workflow is:

```text
research what works -> generate draft -> add your experience -> publish -> track -> iterate
```

That loop is what turns posting into compounding authority instead of random content output.

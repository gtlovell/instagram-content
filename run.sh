#!/usr/bin/env bash
# ── CleanStreak LinkedIn Content Pipeline ─────────────────────────────────────
# Usage:
#   ./run.sh research              Run LinkedIn niche research (appends to Research tab)
#   ./run.sh generate <topic>      Generate a carousel document for a topic
#   ./run.sh generate --type post <topic>   Generate a text-only post
#   ./run.sh generate --type image <topic>  Generate a single-image post
#   ./run.sh track <url>           Track a single posted LinkedIn URL
#   ./run.sh track --all           Re-fetch metrics for all posted entries
#   ./run.sh track <url> --urn <urn>  Track with manual post URN (skip URL extraction)
#   ./run.sh iterate               Analyze performance and regenerate playbook
#   ./run.sh daily [--type type] <topic>    generate → track --all
#   ./run.sh weekly                research → iterate       (weekly strategy review)

set -euo pipefail

CMD="${1:-}"

if [[ -z "$CMD" ]]; then
  echo "Usage: ./run.sh <command> [args]"
  echo ""
  echo "Commands:"
  echo "  research                  Scrape & analyze niche posts; append to Research tab"
  echo "  generate <topic>          Generate carousel slides + caption for a topic"
  echo "  generate --type post <topic>   Generate a text-only LinkedIn post"
  echo "  generate --type image <topic>  Generate an AI visual + caption"
  echo "  track <url>               Track a single posted LinkedIn URL"
  echo "  track --all               Re-fetch metrics for all posted entries"
  echo "  track <url> --urn <urn>   Track with a manually-supplied post URN"
  echo "  iterate                   Score posts, run Claude analysis, update Playbook"
  echo "  daily [--type type] <topic>    generate → track --all"
  echo "  weekly                    research → iterate"
  exit 1
fi

case "$CMD" in

  research)
    echo "=== [1/1] Running research ==="
    node research.js
    ;;

  generate)
    shift
    if [[ $# -eq 0 ]]; then
      echo "Error: topic required.  Usage: ./run.sh generate [--type carousel|post|image] \"your topic\""
      exit 1
    fi
    echo "=== [1/1] Generating content: $* ==="
    node generate.js "$@"
    ;;

  track)
    # Pass all remaining args directly to track.js
    # Supports: <url>, --all, <url> --urn <urn>
    shift
    if [[ $# -eq 0 ]]; then
      echo "Error: url or --all required.  Usage: ./run.sh track <url>  OR  ./run.sh track --all"
      exit 1
    fi
    echo "=== [1/1] Running track $* ==="
    node track.js "$@"
    ;;

  iterate)
    echo "=== [1/1] Running iterate ==="
    node iterate.js
    ;;

  daily)
    shift
    if [[ $# -eq 0 ]]; then
      echo "Error: topic required.  Usage: ./run.sh daily [--type carousel|post|image] \"your topic\""
      exit 1
    fi
    echo "=== [1/2] Generating content: $* ==="
    node generate.js "$@"
    echo ""
    echo "=== [2/2] Refreshing metrics for all posted entries ==="
    node track.js --all
    echo ""
    echo "Done! Content generated and metrics refreshed."
    ;;

  weekly)
    echo "=== [1/2] Running research ==="
    node research.js
    echo ""
    echo "=== [2/2] Running iterate ==="
    node iterate.js
    echo ""
    echo "Done! Research updated and playbook regenerated."
    ;;

  *)
    echo "Unknown command: $CMD"
    echo "Run ./run.sh with no arguments to see usage."
    exit 1
    ;;

esac

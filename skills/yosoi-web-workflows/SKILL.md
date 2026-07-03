---
name: yosoi-web-workflows
description: Use when an agent needs to use Yosoi for crawl, search, fetch, or research workflows. Triggers include web crawl, source discovery, page fetch, evidence packet, research frontier, local Perplexity, candidate contracts, scrape pipeline planning, and turning web research into repeatable Yosoi commands.
---

# Yosoi Web Workflows

Use this skill to choose the right Yosoi primitive before touching scraper/discovery code.

In Pi, the project-local extension adds `/yosoi` helpers:

```text
/yosoi search QUERY          # prefill search workflow
/yosoi fetch URL             # prefill fetch workflow
/yosoi crawl URL             # prefill crawl workflow
/yosoi research TOPIC        # prefill research packet workflow
/yosoi dashboard             # show live Yosoi command/status dashboard
/yosoi hide                  # hide dashboard
/yosoi clear                 # clear dashboard history
```

The dashboard observes bash tool calls that run `yosoi`, tracks commands, URLs, HTTP status codes/errors from stdout or small redirected JSON artifacts, redirected output paths, and latest Pi context-token usage.

Global install targets:

```bash
uvx yosoi agents install --target pi        # Pi skills + Pi extension
uvx yosoi agents install --target agents    # generic ~/.agents/skills
uvx yosoi agents install --target claude
uvx yosoi agents install --target codex
uvx yosoi agents install --target opencode
uvx yosoi agents install --target all
```

If Pi reports skill collisions between project `.agents/skills/...` and global `~/.pi/agent/skills/...`, that is expected: project-local skills win and the global duplicates are skipped for that session.

## First Decision

| User intent | Start with |
| --- | --- |
| Find candidate URLs/sources | `yosoi search` |
| Inspect one page / save evidence | `yosoi fetch` |
| Walk a site/frontier | `yosoi crawl` |
| Answer an open-ended data question | `yosoi research init` + packet loop |
| Extract structured records | `yosoi scrape` |
| Populate selector cache deliberately | `yosoi discover` |
| Find sitemaps/subdomains | `yosoi map` |

Rules:

- Use `uvx yosoi ...` for global/agent workflows so agents run the latest published Yosoi.
- If developing Yosoi itself, follow the repo AGENTS.md local-development command rules instead.
- Prefer JSON to files for machine artifacts; do not paste huge HTML into chat.
- Use `fetch` for evidence, not records. Use `scrape` for records.
- Use `crawl` for frontier traversal, not repeated ad hoc fetches.
- Keep research hypotheses separate from validated contracts.
- Do not introduce Playwright; browser behavior goes through Yosoi/VoidCrawl.

## Search Workflow

Use when the target is unclear or you need candidate sources.

```bash
uvx yosoi search "QUERY" --limit 10 --json > .yosoi/search-query.json
```

Then:

1. Read titles, URLs, snippets, rank, and source diversity.
2. Fetch promising pages before claiming content.
3. Save search JSON into a research packet when the work is exploratory.

Useful options:

```bash
--region us-en
--safesearch moderate
--timelimit d|w|m|y
--page 2
--policy FILE
--dump-request
```

## Fetch Workflow

Use when you need page evidence without selector discovery.

Safe first look:

```bash
uvx yosoi fetch "URL" --view text --chars 12000 --json
```

Rendered/browser evidence:

```bash
uvx yosoi fetch "URL" --view rendered-html --fetcher headless --chars 20000 --json
```

Artifact bundle:

```bash
uvx yosoi fetch "URL" --view bundle --output .yosoi/fetches/source-name --json
```

Contract fit probe only; not scraping:

```bash
uvx yosoi fetch "URL" --contract @Contract --view metadata --include fingerprint,links --json
```

Interpret and report: status, fetcher, truncation/next page, saved artifacts, JS/bot/redirect risk, and recommended next step.

See also `yosoi-fetch` for the full fetch-only skill.

## Crawl Workflow

Use when you need a frontier, not a single page.

Conservative crawl:

```bash
uvx yosoi crawl "https://example.com" --limit 25 --json > .yosoi/crawls/example.json
```

Budgeted/stress-friendly crawl:

```bash
uvx yosoi crawl "https://example.com" \
  --max-pages 100 --max-depth 2 --workers 4 --per-host-concurrency 2 \
  --politeness 0.5 --timeout 30 --retries 2 --stress --json \
  > .yosoi/crawls/example-stress.json
```

Use policy for repeated crawls:

```bash
uvx yosoi crawl "URL" --policy .yosoi/policy.yaml --json
```

Crawler outputs are leads. Fetch or scrape representative pages before turning them into claims or contracts.

## Research Workflow

Use when the deliverable is a decision, source map, MVP data plan, or pipeline plan.

Create packet:

```bash
uvx yosoi research init "TOPIC" --json
```

Core loop:

```bash
uvx yosoi search "QUERY" --limit 10 --json > PACKET/sources/search-001.json
uvx yosoi research observe PACKET --from-search PACKET/sources/search-001.json
uvx yosoi crawl "URL" --limit 20 --json > PACKET/sources/crawl-001.json
uvx yosoi research observe PACKET --from-crawl PACKET/sources/crawl-001.json
uvx yosoi research status PACKET --json
```

When a candidate contract exists:

```bash
uvx yosoi scrape "URL" --contract @Contract --json > PACKET/scrape-results/scrape-001.json
uvx yosoi research observe PACKET --from-scrape PACKET/scrape-results/scrape-001.json --contract-status provisional
```

Final answer must separate: available now, unavailable/paid/blocked, candidate contracts, evidence quality, MVP plan, repeatable pipeline path.

See also `yosoi-research-frontier` for packet details.

## Auxiliary Commands Worth Showing

```bash
# Site map / sitemap discovery
uvx yosoi map "https://example.com" --json

# Explicit selector discovery; expensive LLM path
uvx yosoi discover "URL" --contract @Contract --fetcher auto

# Structured records
uvx yosoi scrape "URL" --contract @Contract --json

# Cache/health diagnostics
uvx yosoi status --url "URL" --contract @Contract

# Policy inspection
uvx yosoi policy effective --json
```

## Agent Reporting Shape

Return only what is supported by artifacts:

- Commands run and output files saved.
- Source count / page count / fetched URLs.
- Fetcher and status, including truncation or failed pages.
- Evidence-backed findings with URLs.
- Known gaps: bot gates, robots/legal, JS-only pages, stale cache, missing fields, paid-only data.
- Next step: fetch more, crawl wider, draft contract, discover selectors, scrape records, or stop.

---
name: jira-mcp-ticket-formatting
description: Use when creating or updating Jira tickets through the jira MCP server, especially ticket descriptions, acceptance criteria, Gherkin specs, story points, assignee, sprint, or Jira markdown formatting.
---

# Jira MCP Ticket Formatting

When updating Jira issues through the `jira` MCP server:

## Formatting rules

- Use `contentFormat: "markdown"` for `jira_editJiraIssue` / create calls when writing descriptions.
- Use Markdown, not Jira wiki markup:
  - headings: `## Problem summary`, not `h2. Problem summary`
  - bullets: `- item`
  - fenced code: triple backticks, not `{code}` macros
- For Gherkin specs, wrap with a fenced block:

````markdown
## Gherkin specs

```gherkin
Feature: Example feature
  Scenario: Example behavior
    Given some state
    When an action happens
    Then the expected result occurs
```
````

- Keep scenarios readable in Jira by preserving indentation inside the fenced block.
- Prefer concise ticket sections:
  - `## Problem summary`
  - `## Gherkin specs` or `## Acceptance criteria`
  - `## Assumptions / scope`
  - `## Test plan`
  - `## Risks / unknowns` when needed

## Story points

- In the Alita `SCRUM` project, Story point estimate is `customfield_10016`.
- Example: set 2 SP with:

```json
{"customfield_10016": 2}
```

## Assignee

- Assign by account ID, not display name, when known.
- Andrew Berg account ID:

```json
{"assignee": {"accountId": "712020:d2b5ce21-c674-414b-b2a8-0b563c3754b4"}}
```

## Verification

After editing, call `jira_getJiraIssue` with the fields changed, e.g.:

```json
{
  "fields": ["assignee", "customfield_10016", "description"],
  "responseContentFormat": "markdown"
}
```

If Jira UI shows literal markup like `h2.` or `{code:gherkin}`, rewrite the description using Markdown syntax with `contentFormat: "markdown"`.

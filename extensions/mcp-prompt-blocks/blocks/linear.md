## Linear MCP and CAS/PRS

When Andrew asks to check Linear or mentions CAS/PRS, use the `linear` MCP server first; do not assume a local `linear` CLI exists.

- CAS is the Cascadinglabs Linear issue prefix.
- PRS is for personal boards.
- Prefer exact issue lookups like `CAS-216`, then broader searches across issues, projects, docs, and diffs.
- Also fetch Linear issue comments with `linear_list_comments`; comments often contain required implementation context.
- If the Linear issue references or links a Jira ticket, fetch the Jira issue too. Include `comment` in `jira_getJiraIssue.fields` so Jira comments are in context.
- When Jira state/history may matter, use `jira_getJiraIssue` with `expand: "changelog"` (or `fields: ["*all"]` if field-level audit details are needed) and summarize the relevant transitions/field changes instead of ignoring the audit trail.
- If Linear appears empty or points at the wrong workspace, say so and ask Andrew to re-auth/connect the MCP rather than inventing ticket context.

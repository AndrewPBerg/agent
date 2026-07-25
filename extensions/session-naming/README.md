# Session naming

Automatically gives unnamed Pi sessions concise model-generated titles and adds `/rename` plus `/sessions` management commands.

This directory is adapted from [`furbyhaxx/pi-session-naming`](https://github.com/furbyhaxx/pi-session-naming) v0.2.1 under the MIT license. Andrew's tracking fork is [`AndrewPBerg/pi-session-naming`](https://github.com/AndrewPBerg/pi-session-naming). See [`UPSTREAM.md`](UPSTREAM.md) for provenance.

## Local default

Title generation uses `openai-codex/gpt-5.3-codex-spark` by default. Global or project `settings.json` can override it:

```json
{
  "session": {
    "titleGeneration": {
      "model": "openai-codex/gpt-5.3-codex-spark"
    }
  }
}
```

Automatic generation only names unnamed sessions. Use `/rename auto` to regenerate a title from the current session context.

## Commands

- `/rename` — interactively rename the current session.
- `/rename <title>` — set a title directly.
- `/rename auto` — generate a title from current context.
- `/sessions` — browse, switch, rename, or delete project sessions.

## Security notes

Title generation sends the configured session transcript and compact project metadata to the selected Pi model. The `/sessions` browser can delete non-current session files after its configured confirmation flow, preferring the system trash command when available.

# Semantic Markdown

Global Pi extension that changes built-in transcript Markdown from source-oriented rendering to terminal-native semantic rendering.

## Behavior

- Semantic mode is the default for every session.
- `/presentation semantic|source` changes the active branch and persists through resume.
- Headings, lists, tasks, code blocks, images, `<details>`, and safe uppercase MDX-like wrappers receive semantic terminal rendering.
- Stored Markdown, model context, exports, and clipboard source are unchanged.

The extension patches Pi's shared `Markdown` component at startup because Pi does not currently expose a renderer hook for built-in assistant and user transcript messages. Keep `renderer.ts` synchronized when Pi's upstream Markdown component changes.

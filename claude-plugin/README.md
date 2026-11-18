# typemark plugin for Claude Code

Lets Claude build writing tools, pages and artifacts on the **typemark** engine, and (planned) act as the
reviewing agent through the engine's AI review layer.

```bash
claude plugin marketplace add <owner>/typemark
claude plugin install typemark@typemark
```

## Contents

| Part | Status |
|---|---|
| `skills/typemark-editor`: how to build a typemark page or artifact (CDN snippet, API, extension and review-layer patterns) | planned |
| MCP server: review-layer tools for Claude as the agent (`suggest_edit`, `add_note`, `reply_to_thread`, `get_thread`, `get_dirty_units`), bridged to a running page | planned |

MIT licensed.

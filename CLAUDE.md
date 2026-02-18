# wopr-plugin-googlechat

Google Chat channel plugin for WOPR. Integrates with Google Workspace via HTTP endpoint and service account authentication.

## Commands

```bash
bun run build       # tsc
bun run check       # biome check + tsc --noEmit
bun run lint:fix    # biome check --fix src/
bun run format      # biome format --write src/
bun run test        # vitest run
bun run typecheck   # tsc --noEmit
```

## Architecture

```
src/
  index.ts   # Plugin entry — HTTP webhook handler, event routing, WOPR injection, ChannelProvider
  types.ts   # Google Chat-specific types (events, config, cards v2)
tests/
  unit/
    index.test.ts  # Unit tests for pure functions and webhook handler
```

## Key Details

- **Auth**: Google Cloud service account with `chat.bot` scope
- **Transport**: HTTP POST endpoint (Google Chat pushes events)
- **Events**: MESSAGE, ADDED_TO_SPACE, REMOVED_FROM_SPACE, CARD_CLICKED
- **Responses**: Synchronous JSON (text or Cards v2)
- **Async API**: `@googleapis/chat` client for outbound messages via ChannelProvider
- **Imports**: `@wopr-network/plugin-types` only. Never import from `@wopr-network/wopr` core.
- **Gotcha**: Always return HTTP 200 to Google Chat, even on errors (prevents retries)
- **Gotcha**: ADDED_TO_SPACE + @mention = single event with both space join AND message
- **Gotcha**: Slash commands are registered in Google Cloud Console, not programmatically

## Plugin Contract

Imports only from `@wopr-network/plugin-types`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-googlechat`.

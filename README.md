# bs

Brain Surgeons treasury. Cloudflare Worker, D1, Discord interactions.

## One time setup

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create bs` and paste the returned `database_id` into `wrangler.toml`.
4. `npm run migrate`
5. Secrets, each prompts for a value:
   - `npx wrangler secret put DISCORD_TOKEN` (bot token from the developer portal)
   - `npx wrangler secret put ENCRYPTION_KEY` (run `openssl rand -base64 32` and paste the output)
   - `npx wrangler secret put SESSION_SECRET` (run `openssl rand -base64 32` again)
   - `npx wrangler secret put SITE_PASSWORD` (the council password)
6. `npm run deploy`
7. In the Discord developer portal, General Information, set Interactions Endpoint URL to `https://brainsurgeons.systoned.cc/interactions` and save. Discord verifies it immediately; the Worker must be deployed first.
8. `DISCORD_TOKEN=... npm run commands` to register the slash commands.

## Config

Channel IDs, role IDs and log type IDs live in the `config` table. Until the settings page exists, set them with:

```
npx wrangler d1 execute bs --remote --command "UPDATE config SET value='CHANNEL_ID' WHERE key='requests_channel'"
```

Keys: `requests_channel`, `log_channel`, `bankers_channel`, `council_role`, `banker_role`, `log_types_item_send`, `log_types_item_receive`, `log_types_cash_send`, `log_types_cash_receive`, `log_types_market_buy`, `log_types_bazaar_buy`, `keyword`.

Log type IDs come from `https://api.torn.com/torn/?selections=logtypes&key=KEY`. Preset: item send 4102, item receive 4103, money send 4800, money receive 4810, item market buy 1112, bazaar buy 1225.

## Bankers

Add via `POST /api/bankers` with `{ "key": "..." }` after logging in, or from the settings page once built. Keys are validated against Torn, encrypted with `ENCRYPTION_KEY`, and never returned.

## Poll

Runs every minute. Fetches each active banker's logs since their last poll, records entries whose message contains the keyword, and posts to the log channel. Sends to a member matching an approved request mark it fulfilled.

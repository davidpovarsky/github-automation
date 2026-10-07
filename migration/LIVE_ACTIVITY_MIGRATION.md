# Event-driven Live Activity migration

This repository now contains the central event-driven implementation in `worker/` and the fail-open source instrumentation action in `live-refresh/`.

## Deployment gate

Cloudflare authentication is intentionally required before any source repository is modified. From an authenticated environment:

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put GH_MONITOR_TOKEN
npx wrangler secret put NOTIFY_DEVICE_ID
npx wrangler secret put NOTIFY_DEVICE_TOKEN
```

The three commands reading secret values are interactive and must be performed by the account owner. Values must never be committed or copied to source repositories.

After deployment, set the Worker URL as the default endpoint in `live-refresh/action.yml` (or pass `endpoint` explicitly in a canary), verify `GET /health`, and run the canary workflow before mass rollout.

## Architecture

`POST /v1/refresh` accepts only repository/run identifiers. The Worker verifies the repository and run through GitHub using `GH_MONITOR_TOKEN`; a Durable Object named `<repository>#<run_id>#<run_attempt>` serializes Notify start/update/end operations and schedules alarms only while an activity is active.

The legacy account monitor remains enabled until the deployed endpoint and external canary have passed. This is intentional rollback protection.

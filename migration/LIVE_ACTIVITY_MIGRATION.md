# Event-driven Live Activity migration

This repository now contains the central event-driven implementation in `worker/` and the fail-open source instrumentation action in `live-refresh/`.

## Deployment gate

Cloudflare authentication is intentionally required before any source repository is modified. Deployment is prepared for an iPad-friendly, manual-only GitHub Actions workflow at `.github/workflows/deploy-live-activity-worker.yml`; it does not require `wrangler login` or a local terminal.

Add only these two GitHub repository secrets before manually running that workflow:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The workflow securely forwards the already-existing central GitHub/Notify secrets to Cloudflare as Worker secrets using the official Wrangler action. Values must never be committed or copied to source repositories. The workflow deploys, resolves the stable Worker URL, verifies `GET /health`, and prints the URL in the GitHub job summary. It does not run canary instrumentation automatically.

After the first successful deployment, set the real Worker URL as the default endpoint in `live-refresh/action.yml` (a separate small commit), then run the external canary before mass rollout.

## Architecture

`POST /v1/refresh` accepts only repository/run identifiers. The Worker verifies the repository and run through GitHub using `GH_MONITOR_TOKEN`; a Durable Object named `<repository>#<run_id>#<run_attempt>` serializes Notify start/update/end operations and schedules alarms only while an activity is active.

The legacy account monitor remains enabled until the deployed endpoint and external canary have passed. This is intentional rollback protection.

## Security and abuse model

The refresh endpoint is intentionally secret-free. It accepts only repository/run identifiers, rejects repositories outside `davidpovarsky`, verifies the repository, run, and attempt through GitHub, and never accepts Notify credentials, activity IDs, display text, or arbitrary payloads from the caller. Each run is serialized by its Durable Object; duplicate bursts are debounced for approximately one second and active runs use only a short safety alarm. This limits quota waste while keeping normal step transitions responsive. GitHub and Notify credentials exist only as Worker secrets.

Configuration fails closed: a fresh `config.json` is preferred, then a last-known-good value is used. If no valid configuration has ever been read, the Worker does not create or update activities; it can still end an existing activity when GitHub reports completion.

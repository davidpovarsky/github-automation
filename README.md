
## Event-driven Live Activity architecture

The primary migration target is now the Cloudflare Worker in `worker/`, backed by a per-run Durable Object. Source workflows use the secret-free, fail-open action at `live-refresh/`; it sends only the repository and GitHub Actions run identifiers. The Worker verifies the run with its centralized GitHub token, reads the authoritative `config.json`, and owns all Notify credentials.

The legacy account-wide polling monitor remains a documented rollback path until the Worker is deployed and an external-repository canary has passed. See [`migration/LIVE_ACTIVITY_MIGRATION.md`](migration/LIVE_ACTIVITY_MIGRATION.md) for the deployment gate and exact secret setup commands.

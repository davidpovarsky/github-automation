# Direct-to-Notify Actions Architecture & Rollout Plan

## Architectural Shift: Direct-to-Notify (No Cloudflare, No Continuous Polling)

The architecture has moved away from the Cloudflare Worker intermediary and away from continuous 24/7 runner polling. Instead, workflows communicate directly with the Notify! API using a reusable, fail-open action (`davidpovarsky/github-automation/live-refresh@main`) and event-driven GitHub Actions lifecycle hooks.

### Architecture Overview

```text
GitHub workflow event
│
├── requested / in_progress
│   ↓
│   tiny workflow_run bridge (.github/workflows/live-activity-bridge.yml)
│   ↓
│   Notify Live Activity start/ensure (fail-open)
│
├── workflow steps
│   ↓
│   inserted Live Activity refresh steps
│   ↓
│   immediate direct Notify update
│
└── workflow completed
    ↓
    workflow_run bridge
    ↓
    Notify Live Activity end (authoritative GitHub conclusion: Success / Failure / Cancelled)
```

- **NO Cloudflare Worker**
- **NO Durable Object**
- **NO External Server**
- **NO Account-wide 24/7 Polling Monitor**
- **NO 15-second Polling or 2-minute Repository Scans**
- **100% Event-Driven GitHub Actions Executions**

---

## Phase A: Central Repository Implementation (COMPLETED)

All requirements for Phase A have been implemented and verified in `davidpovarsky/github-automation`:

1. **`live-refresh/action.yml` & `live-refresh/index.js`**:
   - Accepts lifecycle events: `start`, `refresh`, `final`.
   - Reads inputs: `device_id`, `token`, `github_token`, `source_repository`, `source_run_id`, `source_run_attempt`, `source_branch`.
   - Uses Notify device listing for per-run state discovery via exact canonical run URL (`https://github.com/<owner>/<repo>/actions/runs/<run_id>`).
   - Self-healing concurrency: deterministic winner selection and duplicate cleanup without a central mutex.
   - Authoritative `config.json` enforcement (fail-closed on start/refresh if config is unavailable; cleanup allowed on completion).
   - Fast timeout (1800ms) with full fail-open behavior (builds never fail on Notify issues).
   - Automatically masks tokens in GitHub logs.

2. **Step Selection & Display**:
   - Ignores internal instrumentation steps (`Live Activity ·`).
   - Dynamically selects the next real queued or in-progress step during refresh step execution.
   - Formats compact metrics (`Branch`, `Job`, `Step`, `Done`) with strict 16-character truncation.
   - Links directly to run via `#<run_number> ↗` button.

3. **`scripts/instrument-workflows.js`**:
   - Inserts fail-open refresh steps before every meaningful step with secrets bindings:
     ```yaml
     - name: Live Activity · refresh
       uses: davidpovarsky/github-automation/live-refresh@main
       continue-on-error: true
       with:
         event: refresh
         device_id: ${{ secrets.NOTIFY_DEVICE_ID }}
         token: ${{ secrets.NOTIFY_DEVICE_TOKEN }}
         github_token: ${{ github.token }}
     ```
   - Omits unnecessary `Live Activity · final` steps (replaced by `workflow_run: completed` bridge).
   - Preserves existing permissions and adds `actions: read` where required.
   - Guaranteed idempotency.

4. **Lifecycle Bridge (`.github/workflows/live-activity-bridge.yml`)**:
   - Triggers on `requested`, `in_progress`, and `completed`.
   - Protected against recursive self-dispatch via workflow pattern exclusion and condition checks.
   - Requires zero checkout overhead.

5. **Behavioral Test Suite**:
   - 70 out of 70 tests passing across `test/direct-notify.test.js` and `test/migration.test.js`.
   - Full code check passing with `node --check`.

6. **Cloudflare Path Retirement**:
   - Marked `.github/workflows/deploy-live-activity-worker.yml` as deprecated.
   - Removed dry-run deploy steps from test workflows.

---

## Gate 1: Secret Availability Gate (CURRENT STATUS: STOPPED AT GATE)

In strict accordance with the migration instructions:

> **IMPORTANT: SECRET AVAILABILITY GATE**
> GitHub does not allow retrieving the plaintext value of an existing Actions secret.
> Therefore:
> If `NOTIFY_DEVICE_ID` and `NOTIFY_DEVICE_TOKEN` are NOT already available through your secure runtime/environment/secret store:
> **STOP BEFORE MODIFYING ANY SOURCE REPOSITORY.**
> Ask the user to provide them through the agent's SECURE SECRET / ENVIRONMENT mechanism.
> DO NOT ask the user to paste them into chat.
> DO NOT print them.
> DO NOT log them.
> DO NOT commit them.

As these plaintext values are not currently present in the execution environment, all source repositories remain unmodified until credentials are provided.

---

## Next Steps (Upon Credential Availability)

Once `NOTIFY_DEVICE_ID` and `NOTIFY_DEVICE_TOKEN` are set in the environment:

1. **Phase B (Canary)**:
   - Select 1 low-risk public repository (e.g. `davidpovarsky/apple-clone` or a test repo).
   - Set repository secrets `NOTIFY_DEVICE_ID` and `NOTIFY_DEVICE_TOKEN`.
   - Install `.github/workflows/live-activity-bridge.yml`.
   - Instrument 1 canary workflow.
   - Dispatch and verify Live Activity start, refresh, and final completion.
2. **Phase C (Mass Rollout)**:
   - Securely set `NOTIFY_DEVICE_ID` and `NOTIFY_DEVICE_TOKEN` on all 92 non-archived repositories.
   - Deploy `live-activity-bridge.yml` to the default branch of every repository.
   - Instrument all workflow files across branches.
   - Disable the legacy continuous monitor (`account-monitor.yml`) and cancel any active monitor run.

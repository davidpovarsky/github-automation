# github-automation

Central reusable GitHub automation for sending rich **Notify! Live Activities** from GitHub Actions.

This repository is intended to be used from many repositories at once without duplicating Notify! API logic.

## What this action does

The root action supports:

- `start` — create a new Live Activity and return its `activity_id`
- `update` — update that exact Live Activity in place
- `end` — finish it cleanly
- rich JSON-body features including progress, countdown, segmented steps, metrics and a button
- concurrent workflow runs by using a unique Notify! `activityId` per run

Secrets are never stored in this repository. Calling repositories pass `NOTIFY_DEVICE_ID` and `NOTIFY_DEVICE_TOKEN` as GitHub Actions secrets.

## Basic usage

```yaml
- name: Start Live Activity
  id: notify
  uses: davidpovarsky/github-automation@main
  with:
    action: start
    device_id: ${{ secrets.NOTIFY_DEVICE_ID }}
    token: ${{ secrets.NOTIFY_DEVICE_TOKEN }}
    title: "${{ github.event.repository.name }}"
    body: "Build started"
    symbol: "hammer.fill"
    steps: "4"
    step: "0"
    metrics_json: |
      [
        {"label":"Branch","value":"${{ github.ref_name }}"},
        {"label":"Stage","value":"Build"}
      ]

- name: Build
  run: echo "build here"

- name: Update Live Activity
  uses: davidpovarsky/github-automation@main
  with:
    action: update
    device_id: ${{ secrets.NOTIFY_DEVICE_ID }}
    token: ${{ secrets.NOTIFY_DEVICE_TOKEN }}
    activity_id: ${{ steps.notify.outputs.activity_id }}
    status: "Testing"
    step: "1"
    metrics_json: |
      [
        {"label":"Branch","value":"${{ github.ref_name }}"},
        {"label":"Stage","value":"Tests"}
      ]

- name: End Live Activity
  if: always()
  uses: davidpovarsky/github-automation@main
  with:
    action: end
    device_id: ${{ secrets.NOTIFY_DEVICE_ID }}
    token: ${{ secrets.NOTIFY_DEVICE_TOKEN }}
    activity_id: ${{ steps.notify.outputs.activity_id }}
    status: "${{ job.status }}"
    progress: "100"
    keep_for: "30"
```

## Inputs

Core:

- `action`: `start`, `update`, or `end`
- `device_id`: Notify! device ID
- `token`: Notify! device token
- `activity_id`: required for `update` and `end`
- `new_activity`: defaults to `true` on start, allowing concurrent workflow runs

Content:

- `title`
- `body`
- `symbol`
- `tint`
- `progress`
- `ends_in`
- `trailing`
- `status`
- `steps`
- `step`
- `metrics_json`: JSON array of Notify! metrics
- `button_json`: JSON object for a Notify! button
- `keep_for`: seconds to leave the final Live Activity visible after ending

## Outputs

- `activity_id`
- `expires_at`
- `state`
- `response_json`

## Security

Do not commit Notify! credentials. Store them as GitHub Actions secrets in each calling repository.

The action masks the token in logs and never includes it in outputs.

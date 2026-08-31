# Phase 2: autonomous content manager

## Purpose

Build a local, persistent, Sandbox-first content manager for تقنية تفيدك. Telegram is the sole control plane; the browser dashboard is read only.

## Non-negotiable requirements

1. Approval is tied to content ID, current revision, artifact SHA-256 and posting-settings SHA-256.
2. Only an authorized Telegram user and chat may create an approval or revision request.
3. The scheduler cannot publish. Publishing needs a durable, approved exact-revision intent.
4. Any changed artifact or settings invalidates approval and creates a new revision.
5. TikTok Production is hard-denied while the app is under review; Sandbox is the default environment.
6. The iCloud archive only contains one approved MP4 per human-readable topic folder.

## User stories

- A creator receives a ready video in Telegram with Approve, Revise, Reject and Skip controls.
- A creator can request a natural-language revision and receive a new revision without the old approval carrying over.
- The daily scheduler researches and scores candidate ideas but cannot post content.
- The creator can inspect content history, analytics and learning insights from a private read-only dashboard.
- The service recovers jobs and never duplicates a TikTok post after restart.

## Acceptance criteria

- Unauthorized/replayed/old-revision Telegram approvals do not create a publish intent.
- A scheduled run never calls the TikTok publisher for an unapproved item.
- Archive input is verified by hash and ffprobe, and archive folders have one MP4 only.
- Dashboard rejects all state-changing HTTP requests.
- Local service survives restart with SQLite workflow state intact.

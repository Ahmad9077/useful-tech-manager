# Useful Tech Manager Constitution

## Core Principles

### I. Explicit creator control
No content may be published unless an authenticated Telegram action approves the exact `content_id`, revision, immutable artifact hash, and posting-settings hash. A render, restart, scheduler run, timeout, or inferred intent is never approval.

### II. Sandbox-first and production isolation
Development and tests use TikTok Sandbox only. Production is denied by default and may only be enabled with separate credentials and a deliberate local configuration change after TikTok approval. Submitted Production portal settings are never changed by this runtime.

### III. Durable, auditable state
Workflow state, approvals, jobs, delivery attempts, archive records, and analytics snapshots live in local SQLite transactions. Every external action is idempotent and resumable after restart.

### IV. Secure private operation
Secrets never enter Git, logs, browser recordings, launchd plists, or public pages. The dashboard is loopback-only and API-read-only. Telegram actions require both the configured user ID and chat ID.

### V. Honest content and media handling
Facts require recorded reputable sources. Product interaction is represented honestly. Working assets remain outside the iCloud final archive; an archive topic directory contains exactly one approved MP4.

### VI. Testable small components
Domain rules, persistence, adapters, and HTTP presentation remain separate and have focused automated tests. A failed or unavailable integration fails closed and leaves durable state for recovery.

## Constraints

- Arabic consumer content uses the established تقنية تفيدك visual system and natural Saudi Arabic direction.
- TikTok comments are not scraped or simulated; comment-text ingestion remains disabled until a legitimate authorized API exists.
- No OpenClaw, public TikTok publishing, paid service, or unrelated-project changes are permitted during Phase 2.

## Governance

This constitution governs Phase 2 implementation. Changes require a corresponding specification and test update. Security invariants are release blockers.

**Version**: 1.0.0 | **Ratified**: 2026-08-31 | **Last Amended**: 2026-08-31

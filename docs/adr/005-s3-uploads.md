# ADR-005 — S3 instead of local persistent uploads

- Status: accepted (timing-gated: Wave 7, with Compose volume retained for dev)
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §6.2

## Context

Avatars are validated in memory (container check → Sharp decode → WebP normalize) then written
to a local volume. Local disk cannot be source of truth past 1 replica (write/read pod skew).

## Problem

Where do avatars live once the backend scales: object storage or shared filesystem?

## Options considered

1. **S3 private bucket** (SSE-KMS, versioning, Block Public Access) + backend-issued presigned
   GETs after auth check. Validation pipeline untouched; only the sink changes.
2. **EFS/shared PVC** — POSIX familiarity, but cost + throughput complexity + still-a-volume
   semantics for what is naturally immutable content-addressed blobs.
3. **Database bytea** — bloats Postgres, fights PITR/backup sizes; rejected.

## Decision

Option 1. Keys `avatars/user{id}-{uuid}.webp`, immutable (`wx`-equivalent via
`If-None-Match: *`). Reads preserve the authenticated-only contract via short-lived presigned
URLs. CloudFront + OAC deferred to a traffic trigger.

## Consequences

- Positive: backend becomes stateless re: files; multi-AZ durability; versioning gives ~0 RPO.
- Negative: small SDK + presigned-URL code path to test; GET latency slightly higher than disk
  (acceptable for avatars; CloudFront later if needed).

## Migration implications

Zero-downtime: dual-write (local+S3, read local) → backfill Job with checksum compare →
flip read flag to S3 → monitor 404s → drop local write next release. Flag `USE_S3_UPLOADS`, OFF default.

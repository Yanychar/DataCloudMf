# Database Schema

This document describes the MySQL schema currently defined in [prisma/schema.prisma](/home/sevastia/MedfinDataCloud/prisma/schema.prisma:1).

## Purpose

The current Phase 1 database is a raw centralized repository for data fetched from Acute. It is intentionally minimal and focused on:

- storing raw source payloads
- tracking per-entity sync state
- tracking sync execution history

It is not yet a final analytical warehouse schema.

## Enums

### SyncMode

- `full`
- `incremental`

### SyncRunStatus

- `success`
- `failed`

## Tables

### RepositoryRecord

Stores the latest raw record payload for a given source entity and source identifier.

Columns:

- `id`
  - type: `String`
  - primary key
  - generated with `cuid()`
- `entityType`
  - type: `String`
  - source entity key such as `client`, `organisation`, `invoice`, `invoiceEvent`
- `externalId`
  - type: `String`
  - source identifier used by the ingestion config
- `payload`
  - type: `Json`
  - raw source payload from Acute
- `sourceUpdatedAt`
  - type: `DateTime?`
  - timestamp from the source system when available
- `checksum`
  - type: `String?`
  - hash of the payload for change detection or debugging
- `createdAt`
  - type: `DateTime`
  - default: `now()`
- `updatedAt`
  - type: `DateTime`
  - auto-updated by Prisma

Constraints and indexes:

- unique key on `entityType + externalId`
- index on `entityType + sourceUpdatedAt`

Behavior:

- each source entity record is upserted by `entityType + externalId`
- the table stores the latest known version of the payload, not historical versions

### EntitySyncState

Stores the latest synchronization state for each configured entity.

Columns:

- `entityKey`
  - type: `String`
  - primary key
- `lastRunStartedAt`
  - type: `DateTime?`
- `lastRunCompletedAt`
  - type: `DateTime?`
- `lastSuccessfulSyncAt`
  - type: `DateTime?`
- `lastSyncMode`
  - type: `SyncMode?`
- `createdAt`
  - type: `DateTime`
  - default: `now()`
- `updatedAt`
  - type: `DateTime`
  - auto-updated by Prisma

Behavior:

- one row per configured entity such as `client`, `invoice`, or `personnel`
- used to decide incremental sync start points where the Acute API supports it

### SyncRun

Stores execution history for synchronization jobs.

Columns:

- `id`
  - type: `String`
  - primary key
  - generated with `cuid()`
- `entityKey`
  - type: `String`
  - entity that was synced
- `status`
  - type: `SyncRunStatus`
- `mode`
  - type: `SyncMode`
- `fetchedCount`
  - type: `Int`
  - default: `0`
- `upsertedCount`
  - type: `Int`
  - default: `0`
- `startedAt`
  - type: `DateTime`
- `finishedAt`
  - type: `DateTime?`
- `message`
  - type: `String?`
  - stored as `TEXT`
- `createdAt`
  - type: `DateTime`
  - default: `now()`

Constraints and indexes:

- index on `entityKey + startedAt`

Behavior:

- one row per sync execution
- stores outcome, counters, and failure message if a sync fails

## Logical relationships

There are no foreign keys in the current Phase 1 schema.

The relationships are logical:

- `EntitySyncState.entityKey` corresponds to configured entity keys in `config/entities.config.json`
- `SyncRun.entityKey` corresponds to configured entity keys in `config/entities.config.json`
- `RepositoryRecord.entityType` corresponds to configured entity keys in `config/entities.config.json`

This is intentional because the current database is a raw ingestion repository, not yet a relational business model.

## Example entity keys

Based on the current Phase 1 config:

- `client`
- `organisation`
- `employer`
- `invoice`
- `invoiceEvent`
- `personnel`

## Current design tradeoffs

- Simple and flexible for raw ingestion
- Easy to add new source entities without schema redesign
- Raw JSON preserves source fidelity
- Not optimized yet for reporting, dimensional modeling, or full history tracking

## Likely future evolution

Later phases may add:

- source-specific staging tables
- historical versioning
- curated warehouse tables
- explicit business relationships and foreign keys
- transformed analytical marts

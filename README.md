# Medfin Data Cloud

Minimal NestJS service for pulling data from Acute into a centralized MySQL repository.

## Stack

- NestJS
- Prisma
- MySQL
- Swagger
- Docker / Docker Compose
- WSL development workflow

## What this first phase includes

- Config-driven Acute entity synchronization
- Separate schedule and update mode per entity
- Centralized repository table storing raw source payloads
- Manual API endpoints for testing Acute requests
- Manual API endpoint for triggering syncs
- Swagger UI for local exploration

## Phase 1 scope

The current in-scope Acute entities are:

- Client
- Organisation
- Employer
- Invoice
- InvoiceEvent
- Personnel

Important business rules already reflected in the scaffold:

- `Client.client` is the source identifier for Client, for example `/clients/123`
- `Employer` is the source bridge between Client and Organisation
- `InvoiceEvent` is the preferred name and is sourced from `Invoice.events[]`
- `EmployerOrg` is explicitly out of scope

Detailed source notes live in [docs/acute_phase1_data_model.md](/home/sevastia/MedfinDataCloud/docs/acute_phase1_data_model.md:1).

Confirmed Acute list endpoints from the current OpenAPI spec:

- `/clients`
- `/organisations`
- `/employers`
- `/invoices`
- `/personnel`

## Environment

Copy `.env.example` to `.env` and update:

- `DATABASE_URL`
- `ACUTE_BASE_URL`
- `ACUTE_API_KEY`
- `DATA_SYNC_ENTITY_CONFIG_PATH`

`config/entities.config.json` is the key project config. Each entity can define:

- `key`
- `label`
- `endpoint`
- `cron`
- `mode` as `full` or `incremental`
- `sourceUpdatedAtField`
- `incrementalQueryParam`
- `externalIdField`
- `compositeExternalIdFields`
- `recordPath`
- `recordContextParentFields`
- `enabled`
- `pageSize`

The current config is preloaded with the six in-scope Acute entities from Phase 1.

For local IDE usage:

- `.env` is prepared for running the app from WSL or PhpStorm against MySQL on `127.0.0.1:3306`
- `.env.docker` is prepared for Docker Compose where the DB host is `mysql`

Important sync-policy note:

- `Invoice` and `InvoiceEvent` can use incremental sync through `modifiedAfter`
- The current spec does not expose the same list-level modified-after filter for `Client`, `Organisation`, `Employer`, or `Personnel`, so they are currently configured as `full`
- `InvoiceEvent` extraction sends `showEvents=true` to the invoice endpoint

## Run in Docker

```bash
docker compose up --build
```

Swagger will be available at `http://localhost:3000/docs`.

## Run in WSL without Docker

```bash
npm install
npm run db:up
npx prisma generate
npx prisma db push
npm run start:dev
```

## PhpStorm

Shared run configurations are included in `.run/`, and the IDE setup guide is in [docs/phpstorm_setup.md](/home/sevastia/MedfinDataCloud/docs/phpstorm_setup.md:1).

## API endpoints

- `GET /health`
- `GET /docs`
- `GET /acute-test/ping`
- `POST /acute-test/request`
- `POST /acute-test/entity/:entityKey/fetch`
- `GET /ingestion/entities`
- `POST /ingestion/sync/:entityKey`

## Centralized repository model

`RepositoryRecord` stores raw data from Acute:

- entity type
- external id
- raw JSON payload
- source updated timestamp
- checksum

For nested entities like `InvoiceEvent`, the payload may also include `_parentContext` values copied from the parent invoice so the raw repository keeps enough source context for later modeling.

`EntitySyncState` stores the last successful sync timestamp per entity.

`SyncRun` stores sync execution history.

Database schema documentation:

- [docs/database_schema.md](/home/sevastia/MedfinDataCloud/docs/database_schema.md:1)
- [docs/database_schema_erd.mmd](/home/sevastia/MedfinDataCloud/docs/database_schema_erd.mmd:1)

Additional modeling documentation:

- [docs/acute_source_to_repository_mapping.md](/home/sevastia/MedfinDataCloud/docs/acute_source_to_repository_mapping.md:1)
- [docs/phase2_target_warehouse.md](/home/sevastia/MedfinDataCloud/docs/phase2_target_warehouse.md:1)
- [docs/phase2_target_warehouse_erd.mmd](/home/sevastia/MedfinDataCloud/docs/phase2_target_warehouse_erd.mmd:1)

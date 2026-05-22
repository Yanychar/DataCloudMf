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

- `/clientsList`
- `/organisations`
- `/employers`
- `/invoices`
- `/personnel`

## Environment

Copy `.env.example` to `.env` and update:

- `DATABASE_URL`
- `ACUTE_STAGE_BASE_URL`
- `ACUTE_STAGE_LOGIN`
- `ACUTE_STAGE_PASSWORD`
- `DATA_SYNC_ENTITY_CONFIG_PATH`
- `DATA_SYNC_IMPORTED_FIELDS_CONFIG_PATH`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_REPORT_MODEL`
- `OPENAI_TIMEOUT_MS`

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

The current config is preloaded with the six in-scope Acute entities from Phase 1.

Imported field subsets are configured separately in [config/imported-fields.config.json](/home/sevastia/MedfinDataCloud/config/imported-fields.config.json:1). This keeps scheduling/sync behavior separate from source-field selection and AI metadata.

For local IDE usage:

- `.env` is prepared for running the app from WSL or WebStorm against MySQL on `127.0.0.1:3310`
- `.env.docker` is prepared for Docker Compose where the DB host is `mysql`

Important sync-policy note:

- Raw Acute ingestion is controlled by [config/entities.config.json](/home/sevastia/MedfinDataCloud/config/entities.config.json:1)
- Staging into `stg_*` tables is controlled by [config/imported-fields.config.json](/home/sevastia/MedfinDataCloud/config/imported-fields.config.json:1)
- Cron now runs the raw Acute-to-`RepositoryRecord` flow only
- Staging is a separate run that reads pending/changed `RepositoryRecord` rows and can be rerun without calling Acute again
- `InvoiceEvent` is sourced from `Invoice.events[]`, so raw invoice sync also creates raw `invoiceEvent` repository rows

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

## WebStorm

Shared run configurations are included in `.run/`, and the IDE setup guide is in [docs/webstorm_setup.md](/home/sevastia/MedfinDataCloud/docs/webstorm_setup.md:1).

## API endpoints

- `GET /health`
- `GET /docs`
- `GET /acute-test/ping`
- `POST /acute-test/request`
- `POST /acute-test/entity/:entityKey/fetch`
- `GET /ingestion/entities`
- `POST /ingestion/sync/:entityKey`
- `POST /ingestion/raw/:entityKey`
- `POST /ingestion/stage/:entityKey`

## Centralized repository model

`RepositoryRecord` stores raw data from Acute:

- entity type
- external id
- raw JSON payload
- source updated timestamp
- checksum
- staging-needed flag
- last staged timestamp / checksum
- latest stage error, if staging failed

For entities that define imported fields in [config/imported-fields.config.json](/home/sevastia/MedfinDataCloud/config/imported-fields.config.json:1), the repository stores only the configured subset of source fields. This is the current privacy-control mechanism and is also intended to become reusable AI metadata later.

Staging tables are populated in a separate run from `RepositoryRecord`. This means:

- Acute fetch failures do not directly corrupt staging writes
- staging can be retried independently
- changed raw rows can be restaged later without another Acute call

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

Testing helpers:

- [docs/first_client_test.md](/home/sevastia/MedfinDataCloud/docs/first_client_test.md:1)
- [requests/first_client_test.http](/home/sevastia/MedfinDataCloud/requests/first_client_test.http:1)
- [requests/client_sync.http](/home/sevastia/MedfinDataCloud/requests/client_sync.http:1)
- [requests/client_admin.http](/home/sevastia/MedfinDataCloud/requests/client_admin.http:1)
- [requests/client_reporting_admin.http](/home/sevastia/MedfinDataCloud/requests/client_reporting_admin.http:1)

## Admin UI

An admin-only browser UI is served directly from the Nest app root:

- `http://localhost:3000/`

Current scope:

- sync overview for `Client`
- client repository browsing and count preview
- Stage 1 `Client Report Lab`
- recent report execution history

Direct-AI Stage 1 reporting:

- when `OPENAI_API_KEY` is configured, `POST /admin/reports/client/run` sends sanitized filtered Client rows plus imported-field metadata to OpenAI and expects structured JSON back
- when `OPENAI_API_KEY` is not configured, the same endpoint returns the local fallback report result

Current `Client` admin filters are business-oriented:

- `birthDateFrom`
- `birthDateTo`
- `ageFrom`
- `ageTo`
- `gender`
- `clientType`
- `city`

Current `Client` admin/reporting endpoints:

- `GET /admin/clients`
- `GET /admin/clients/count`
- `GET /admin/clients/metadata`
- `GET /admin/clients/sync-overview`
- `POST /admin/reports/client/preview`
- `POST /admin/reports/client/run`
- `GET /admin/reports/client/executions`
- `GET /admin/reports/client/executions/:id`

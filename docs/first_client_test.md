# First Client Test

This is the recommended first live test for the project.

The goal is to prove, in increasing order:

1. the service is running locally
2. Acute Basic authentication works
3. the `client` entity can be read from Acute
4. the `client` entity can be synced into the centralized repository

## Why start with Client

`Client` is the simplest first entity to test because:

- it uses a straightforward list endpoint: `/clientsList`
- it does not require nested extraction
- it does not require special parameters such as `showEvents=true`
- its identifier is already well understood: `Client.client`

That makes it a better first connectivity test than `InvoiceEvent`.

## Prerequisites

Check the local environment file [`.env`](/home/sevastia/MedfinDataCloud/.env:1):

- `ACUTE_STAGE_BASE_URL` must be set
- `ACUTE_STAGE_LOGIN` must be set
- `ACUTE_STAGE_PASSWORD` must be set

For API-only testing, MySQL is not required.

For end-to-end sync testing, MySQL must be running.

## Start the app

From the project root:

```bash
npm run start:dev
```

The local API should be available at:

- `http://localhost:3000`

Swagger UI:

- `http://localhost:3000/docs`

## Test sequence

### 1. Check service health

Request:

- `GET /health`

Expected result:

- HTTP `200`
- JSON with `"status": "ok"`

### 2. Check Acute configuration readiness

Request:

- `GET /acute-test/ping`

Expected result:

- HTTP `200`
- `"ok": true`
- correct `baseUrl`

If `ok` is `false`, the Acute credentials or base URL are not fully configured.

### 3. Optional dry run for the raw Client request

Request:

- `POST /acute-test/request?dryRun=true`

Body:

```json
{
  "path": "/clientsList"
}
```

Expected result:

- HTTP `200`
- JSON showing the exact URL, params, and auth mode that would be used

This is the safest way to inspect the outgoing request before hitting Acute.

### 4. Send a raw request to Acute

Request:

- `POST /acute-test/request`

Body:

```json
{
  "path": "/clientsList"
}
```

Expected result:

- HTTP `200`
- JSON response from Acute with one or more client records, or at least a valid response shape from the endpoint

This confirms:

- Basic auth works
- the base URL is correct
- the `clients` endpoint is reachable

If the GET variant times out, you can also test the POST variant with a longer timeout:

```json
{
  "method": "POST",
  "path": "/clientsList",
  "body": {},
  "timeoutMs": 60000
}
```

### 5. Optional dry run for the configured Client fetch

Request:

- `POST /acute-test/entity/client/fetch?dryRun=true`

Expected result:

- HTTP `200`
- JSON showing the exact request generated from entity configuration

### 6. Test the configured entity fetch for Client

Request:

- `POST /acute-test/entity/client/fetch`

Expected result:

- HTTP `200`
- response shape like:

```json
{
  "records": [
    {}
  ],
  "requestedAt": "..."
}
```

This confirms:

- the `client` config in `config/entities.config.json` is valid
- the code path for configured entity reads is working
- the `Client.client` identifier can be extracted later during sync

### 7. Optional end-to-end sync into repository

If MySQL is running, request:

- `POST /ingestion/sync/client`

Expected result:

- HTTP `200`
- response containing:
  - `entityKey: "client"`
  - `fetchedCount`
  - `upsertedCount`

This confirms:

- Acute read works
- repository upsert works
- sync state and sync run tracking work

## If step 5 is used, verify database contents

You should see rows created for:

- `RepositoryRecord`
- `EntitySyncState`
- `SyncRun`

The `RepositoryRecord` rows for this test should have:

- `entityType = "client"`
- `externalId` populated from `Client.client`

## Suggested interpretation of failures

If step 3 fails:

- likely auth, base URL, or Acute connectivity issue

If step 4 fails:

- likely entity config or response normalization issue

If step 5 fails:

- likely MySQL, Prisma, or repository write issue

## Recommended next test after Client

After `Client` works, the next best test is:

- `Invoice`

because it exercises the incremental sync path through `modifiedAfter`.

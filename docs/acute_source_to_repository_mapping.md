# Acute Source to Repository Mapping

This document maps the current in-scope Acute source entities into the Phase 1 centralized raw repository.

It describes:

- which Acute endpoint is used
- how the source identifier is chosen
- how records are stored in `RepositoryRecord`
- what sync policy is currently configured
- important source semantics and join notes

This is a Phase 1 source-ingestion mapping, not a final warehouse mapping.

## Repository target

All source entities currently land in the same raw repository table:

- [RepositoryRecord](/home/sevastia/MedfinDataCloud/prisma/schema.prisma:16)

Common repository fields:

- `entityType`
  - logical entity key from config
- `externalId`
  - selected source identifier
- `payload`
  - raw Acute JSON object
- `sourceUpdatedAt`
  - best available source timestamp when present
- `checksum`
  - hash of payload

## Entity mappings

### Client

Source:

- endpoint: `/clients`
- source model: `Client`

Repository mapping:

- `entityType`: `client`
- `externalId`: `Client.client`
- `sourceUpdatedAt`: `Client.latestSaveDate`
- `payload`: full `Client` object

Sync policy:

- current mode: `full`
- reason: the current list endpoint does not show a modified-after parameter in the inspected spec

Important source notes:

- `Client.client` is a URI such as `/clients/123`
- there is no native `clientId` field in the `Client` entity
- `Employer.clientId` refers to the numeric id portion embedded in this URI

### Organisation

Source:

- endpoint: `/organisations`
- source model: `Organisation`

Repository mapping:

- `entityType`: `organisation`
- `externalId`: `Organisation.orgId`
- `sourceUpdatedAt`: `Organisation.latestSaveDate`
- `payload`: full `Organisation` object

Sync policy:

- current mode: `full`
- reason: the current list endpoint does not show a modified-after parameter in the inspected spec

Important source notes:

- company master entity for TTH organisation clients

### Employer

Source:

- endpoint: `/employers`
- source model: `Employer`

Repository mapping:

- `entityType`: `employer`
- `externalId`: `Employer.employer`
- `sourceUpdatedAt`: not currently mapped
- `payload`: full `Employer` object

Sync policy:

- current mode: `full`
- reason: the current list endpoint does not show a modified-after parameter in the inspected spec

Important source notes:

- source bridge between person and company
- `Employer.clientId` corresponds to the numeric id embedded in `Client.client`
- `Employer.orgId` corresponds directly to `Organisation.orgId`

Important source fields:

- `clientId`
- `orgId`
- `startDate`
- `endDate`
- `mainEmployer`
- `department`
- `profDescr`

### Invoice

Source:

- endpoint: `/invoices`
- source model: `Invoice`

Repository mapping:

- `entityType`: `invoice`
- `externalId`: `Invoice.invoiceId`
- `sourceUpdatedAt`: `Invoice.modifiedDate`
- `payload`: full `Invoice` object

Sync policy:

- current mode: `incremental`
- incremental parameter: `modifiedAfter`
- static request parameters:
  - `dateType=invoiceDate`

Important source notes:

- represents MF-issued outbound sales invoices
- payer may be a person through `payerClientId`
- payer may be an organisation through `payerOrgId`
- issuer context is inferred through fields such as `legalUnit`, `unitId`, and tenant context

### InvoiceEvent

Source:

- endpoint: `/invoices`
- source model: `Invoice.events[]`
- event item schema in Acute spec: `EventPayer`

Repository mapping:

- `entityType`: `invoiceEvent`
- `externalId`: `EventPayer.eventPayerId`
- `sourceUpdatedAt`: `EventPayer.created`
- `payload`: raw `EventPayer` item plus `_parentContext`

Current parent context copied from invoice:

- `invoiceNo`
- `payerClientId`
- `payerOrgId`
- `personnelId`
- `unitId`
- `legalUnit`

Sync policy:

- current mode: `incremental`
- incremental parameter: `modifiedAfter`
- static request parameters:
  - `showEvents=true`
  - `dateType=invoiceDate`

Important source notes:

- preferred business name is `InvoiceEvent`
- represents billed service lines or billed visit details
- sourced from `Invoice.events[]`
- analytically links invoice, person, company, payer, and professional

### Personnel

Source:

- endpoint: `/personnel`
- source model: `Personnel`

Repository mapping:

- `entityType`: `personnel`
- `externalId`: `Personnel.personnelId`
- `sourceUpdatedAt`: not currently mapped
- `payload`: full `Personnel` object

Sync policy:

- current mode: `full`
- reason: the current list endpoint does not show a modified-after parameter in the inspected spec

Important source notes:

- represents MF staff and professionals
- not patients
- not employer employees

## Current gaps and open points

- `Client`, `Organisation`, `Employer`, and `Personnel` currently use full sync because no list-level modified-after filter was confirmed
- invoice historical-load strategy still needs an explicit decision because the endpoint defaults date range behavior when `startDate` and `endDate` are omitted
- Phase 1 stores the latest raw version only, not a history of changes
- business-curated and analytical target tables are not implemented yet

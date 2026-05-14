# Acute Phase 1 Data Model

## Scope

Phase 1 focuses on the Data Foundation layer for the `Data Cloud` project. The first source system is `Acute`.

In-scope source entities:

- Client
- Organisation
- Employer
- Invoice
- InvoiceEvent
- Personnel

Explicitly out of scope:

- EmployerOrg

## Business context

MF is a medical organization using Acute for patient visits, billing, invoicing, and related processes.

MF serves:

- private clients
- TTH organisation clients, meaning companies buying occupational health services from MF
- TTH clients, meaning employees of those companies

## Source entity notes

### Client

- Central person entity in Acute
- Can represent a private client, a TTH client or employee, and sometimes a payer person
- Source identifier is the `client` URI, for example `/clients/123`
- There is no native `clientId` field in Client

### Organisation

- Company master entity
- Used for TTH organisation clients
- Key field is `orgId`

### Employer

- Bridge entity between person and company
- Links `Employer.clientId` to the numeric id embedded in `Client.client`
- Links `Employer.orgId` directly to `Organisation.orgId`
- Important source fields:
  - `clientId`
  - `orgId`
  - `startDate`
  - `endDate`
  - `mainEmployer`
  - `department`
  - `profDescr`

### Invoice

- MF-issued outbound sales invoice
- Payer can be a person via `payerClientId`
- Payer can be an organisation via `payerOrgId`
- MF issuer context is represented indirectly by fields such as `legalUnit`, `unitId`, and the Acute tenant context

### InvoiceEvent

- Preferred name replacing `EventPayer`
- Sourced from `Invoice.events[]`
- Represents billed service lines or billed visit details
- Important analytical link between invoice, person, company, payer, and professional

### Personnel

- MF staff, doctors, nurses, and other professionals
- Not patients and not employer employees

## Source-level joins

- `Employer.clientId` refers to the id part of `Client.client`
- `Employer.orgId` joins directly to `Organisation.orgId`
- `Invoice.events[]` is the source container for `InvoiceEvent`

## Phase 1 repository rules

- Store raw source payloads in the centralized repository
- Keep entity-specific schedules in configuration
- Keep entity-specific update policy in configuration
- Focus on source-system descriptions before warehouse-derived fields
- Do not model or document `EmployerOrg`

## Current implementation notes

- Entity sync configuration lives in `config/entities.config.json`
- `InvoiceEvent` currently reads from the invoice endpoint and extracts `events[]`
- Confirmed list endpoints from the Acute spec:
  - `/clientsList`
  - `/organisations`
  - `/employers`
  - `/invoices`
  - `/personnel`
- `Invoice.events[]` contains `EventPayer` items, which are modeled in this project as `InvoiceEvent`
- The invoice endpoint exposes `modifiedAfter` and `showEvents`
- The current spec does not show an equivalent modified-after list filter for Client, Organisation, Employer, or Personnel
- Invoice date filtering defaults to the current month when `startDate` and `endDate` are omitted, so historical load strategy should be planned explicitly

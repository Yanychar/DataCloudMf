# Phase 2 Target Warehouse Draft

This document outlines a possible Phase 2 warehouse shape that can sit on top of the Phase 1 raw repository.

It is a target draft, not an implemented schema.

## Intent

Phase 1 stores raw source payloads from Acute in a flexible ingestion repository.

Phase 2 would introduce curated business-facing warehouse structures for:

- client analysis
- employer and organisation relationships
- invoice analysis
- billed service line analysis
- personnel analysis

## Proposed core structures

### Dimensions

- `DimClient`
  - unified person dimension based on Acute `Client`
- `DimOrganisation`
  - organisation and TTH company dimension based on Acute `Organisation`
- `DimPersonnel`
  - MF professional dimension based on Acute `Personnel`
- `DimPayer`
  - normalized payer dimension for either person or organisation payer
- `DimUnit`
  - billing or operational unit dimension derived from invoice and event context

### Bridge

- `BridgeEmployment`
  - resolved employment relationship between client and organisation from Acute `Employer`

### Facts

- `FactInvoice`
  - one row per outbound MF invoice
- `FactInvoiceEvent`
  - one row per billed service line from `Invoice.events[]`

## Main business relationships

- A client can have zero or many employment relationships through `BridgeEmployment`
- An organisation can have zero or many related employment relationships
- An invoice belongs to one payer
- An invoice can contain many invoice events
- An invoice event can reference a client, organisation, payer, personnel member, and unit

## Modeling notes

### Client

- Preserve the original `Client.client` URI
- Also derive the numeric client id part for joins to `Employer.clientId`

### Organisation

- `orgId` remains the core business key from source

### Employer

- Use as the relationship source between person and organisation
- Preserve effective dates and `mainEmployer`

### Invoice

- Treat as outbound sales invoice from MF
- Separate payer from recipient-friendly display fields

### InvoiceEvent

- Treat as the most important analytical grain for billing analysis
- One billed event line should become one fact row

### Payer

- Because payers may be clients or organisations, a normalized payer dimension is likely cleaner than duplicating payer columns across facts

## Grain guidance

- `FactInvoice`
  - grain: one row per Acute invoice
- `FactInvoiceEvent`
  - grain: one row per Acute billed event line
- `BridgeEmployment`
  - grain: one row per employment relationship period

## Suggested next steps

- confirm the desired analytical questions and reporting use cases
- define curated column lists for each target dimension and fact
- decide whether historical snapshots are required
- define surrogate key strategy
- define transformation rules from raw repository payloads into curated warehouse tables

# Service catalogue and prices (Administration → Price list)

## Purpose
The list of things the hospital charges for (consultations, beds, procedures, nursing, injections and dressings, investigations) and what each costs. Charges and invoices are built from it. Each facility has its own catalogue. Needs `ADMIN_MASTERS` to change; everyone who is signed in can read the active services (a doctor or cashier picks from it).

## What a service has
Code (unique in the facility, capital letters, digits, `-` and `_`, up to 24, never changed), name, category, price, tax % (0 to 100), and an optional SAC/HSN code (4 to 8 digits, used on the GST invoice). Prices and tax are exact decimals with two places, never floating point.

## On the screen
- **Add a service**: code, name, category, price, tax % and optional SAC/HSN. A used code gives a plain message ("A service with this code already exists. Choose another code, or switch the old one back on.").
- **Price list**: search by name or code, filter by category, tick "Show switched-off services", and page through (50 a page, with the total shown). Each row has **Edit** and **Switch off** (or **Switch on**).
- **Edit** changes the name, category, price, tax % and SAC/HSN in the row; only what actually changed is sent. The code does not change.
- **Switch off** is the "delete". A service is **never deleted**: old invoices keep the name, price and tax they were issued with, and a switched-off service just stops being offered on new invoices and charges (it is refused if sent anyway). It can be switched on again.

## Rules
- A price or tax change applies to **new** invoices only. An invoice, even a draft, keeps the price it was created with; only invoices made afterwards use the new price (docs/gst-and-rounding.md).
- Every change is audited: `SERVICE_CREATED`, `SERVICE_UPDATED`, and `SERVICE_PRICE_CHANGED` with the old and new price and tax.
- Another facility's or hospital's services are "not found".

## API
`GET /services` (`q`, `category`, `includeInactive`, `page`, `pageSize` up to 200), `POST /services`, `PATCH /services/:id`. There is no `DELETE`.

## Known limitations
Prices cannot be dated in advance (a change is immediate), there are no price lists per payer or package prices, and a new facility starts with an empty catalogue (nothing is copied from another facility). The pickers on the billing screens load only the first 100 active services, so a catalogue larger than that is not fully offered there (to do: search-as-you-type in those pickers).

Tests: `modules/billing/billing.spec.ts` (catalogue operations, audit, permissions), `common/tenant-sweep.spec.ts`.

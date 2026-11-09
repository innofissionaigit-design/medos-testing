# Stock locations and transfers

## Purpose

A hospital keeps medicines in more than one place: the pharmacy counter, a ward store, the operation theatre, an emergency box. This module lets the pharmacy keep those places, move stock between them, and always know where each batch is.

## The model

| Place | What it is |
| --- | --- |
| **Main store** | The pharmacy's own stock. It is the stock the pharmacy counter sells from. It is the existing `StockBalance` and `StockLedger`, unchanged: selling, first-expiry-first-out, purchases, returns, adjustments and every stock report work exactly as before. |
| **Location** (`StockLocation`) | A further place in the facility with its own stock (`StockLocationBalance`) and its own history (`StockLocationLedger`). Created by the pharmacy; never deleted. |

A **transfer** (`StockTransfer`, number `TRF-2026-000001`) takes stock out of one place and puts the same stock into another. A place is a location or the main store, never the same place twice. There are two ways to send:

* **Immediately** (the default): both sides are written in **one transaction**, or neither is. A mistake is put right with a transfer the other way.
* **In two steps** ("Send in two steps"): the stock **leaves the sender now** and sits **on the way**, counted in neither place. The other place confirms it **arrived** (the stock then counts there) or it is **sent back** (it returns to where it left, with a reason). A transfer on the way can be closed once, whichever happens first; two people pressing at once close it exactly once. A location cannot be made inactive while a transfer to or from it is on the way.

Stock held in a location is **not sold at the pharmacy counter** and is not in the main store's stock, low-stock or near-expiry reports. It is kept in the location's own view until it is moved back.

## Screens

Pharmacy → **Locations and transfers**:

* **Locations**: add a location, see the units and batches each holds and how many transfers are on their way to it, view what it holds batch by batch, stop using it or use it again.
* **Move stock**: choose where from and where to, find the medicine (or filter what the location holds), type how many of each batch, give a reason, **Move stock**. A retry is safe (the screen sends one key per move).
* **On the way**: transfers sent in two steps and not yet confirmed, with **Arrived** and **Send back…**.
* **Recent transfers**: number, time, from and to, units, items, reason, who, and whether it is on the way or was sent back.

Nurses see the ward store in the **Nursing** tab of an admission (see below).

## Rules

* Quantities are whole numbers from 1; a transfer carries 1 to 50 batches, each listed once.
* Cannot move more than the place holds (`INSUFFICIENT_STOCK`, nothing moves, no partial transfers).
* Stock that is **blocked** (recalled) or **expired** cannot be sent **into a location**. It can always be brought **back to the main store** so that it can be written off.
* A location that is not in use takes no stock. A location that still holds stock cannot be made inactive (`LOCATION_HAS_STOCK`); move the stock out first.
* Location names are unique in a facility whatever the capitals; the code is made from the name when left out.
* Everything is scoped to the signed-in hospital and facility; another hospital's batches and locations answer 404.

## Ward stores used by nurses

In the Nursing tab of an admission (Admissions → the patient → Nursing and medication), a nurse sees the ward stores and what they hold, confirms stock that was sent to the ward (**It has arrived**), and **takes a medicine for the patient**. Taking a medicine draws it from the store, writes it to the store's ledger (`StockLocationIssue`, linked to the ledger line) and adds a **medicine charge to the admission** at the batch's selling price (medicine prices include GST), in one step. It is refused (and nothing changes) when the store does not hold enough, the batch is blocked or expired, the store is not in use, the patient is not admitted, or the final bill has already been issued. A retry with the same key draws once, and simultaneous draws can never take more than the store holds. The medicine appears on the final bill.

## Reports

The pharmacy stock reports now count the locations too: **Current pharmacy stock** shows each medicine's main-store quantity, the quantity in locations and the total (and values at purchase price for both); **Low stock** lists medicines at or below their reorder level in the main store (the counter's stock) with the locations' stock shown beside it; **Near-expiry stock** lists a batch once for every place that holds it, with the place named.

## Permissions

| Action | Permission |
| --- | --- |
| See locations, a location's stock, the transfer history | `PHARMACY_READ` |
| Create, rename, stop or restart using a location | `PHARMACY_MASTERS` |
| Move stock | `PHARMACY_ADJUST_STOCK` (moving changes where stock is, so it uses the stock-adjustment permission) |
| Confirm or send back a two-step transfer | `PHARMACY_ADJUST_STOCK` or `NURSING_MEDICATION_ADMINISTER` |
| See ward stores and the transfers waiting for the ward | `NURSING_READ` |
| Take a medicine from a ward store for an admitted patient | `NURSING_MEDICATION_ADMINISTER` or `PHARMACY_DISPENSE` |

## API

* `GET /api/v1/pharmacy/locations`, `POST /api/v1/pharmacy/locations`, `PUT /api/v1/pharmacy/locations/:id` (`{ name?, status? }`)
* `GET /api/v1/pharmacy/locations/:id/stock`
* `POST /api/v1/pharmacy/transfers` (header `Idempotency-Key` required; body `{ fromLocationId, toLocationId, reason, items: [{ batchId, quantity }] }`; an empty `fromLocationId` or `toLocationId` means the main store)
* `POST /api/v1/pharmacy/transfers/:id/receive` (`{ note? }`) and `POST /api/v1/pharmacy/transfers/:id/send-back` (`{ reason }`), both with an `Idempotency-Key`; the transfer body also takes `twoStep: true`
* `GET /api/v1/pharmacy/transfers?locationId&status&page&pageSize`
* `GET /api/v1/nursing/ward-stores`, `GET /api/v1/nursing/ward-stores/:id/stock`, `GET /api/v1/nursing/ward-stores/incoming`
* `POST /api/v1/admissions/:id/ward-store-issues` (`{ locationId, batchId, quantity, remarks? }`, with an `Idempotency-Key`), `GET /api/v1/admissions/:id/ward-store-issues`

## Ledgers, audit and integrity

* The main store side writes a `StockLedger` line of type `TRANSFER` (direction OUT or IN, the batch, the quantity, the user, the time, a reference to the transfer and the reason). The location side writes a `StockLocationLedger` line with the same facts. Either balance can be rebuilt from its ledger.
* The database refuses: a negative balance, a balance that differs from its ledger at commit, a transfer between the same place or with no place, a transfer or ledger line that is edited or deleted, and any location, batch or transfer from another hospital or facility.
* Audit events: `STOCK_LOCATION_CREATED`, `STOCK_LOCATION_UPDATED`, `STOCK_TRANSFERRED` and, for two steps, `STOCK_TRANSFER_SENT`, `STOCK_TRANSFER_RECEIVED`, `STOCK_TRANSFER_CANCELLED` (transfer number, places, batches, units, reason), and `WARD_STORE_ISSUED`.
* A transfer is never deleted or rewritten; the one change the database allows is closing a transfer that is on the way (received or sent back). A location ledger line is caused by exactly one thing, a transfer or an issue to a patient.
* Transfers lock the stock rows in one fixed order (main store rows, then location rows, each by id), so two transfers in opposite directions can never deadlock, and two transfers of the same stock can never move more than there is.

## Known limitations

* A two-step transfer is received or sent back as a whole; receiving only part of it is in `docs/backlog.md`.
* A nurse's medication administration record is not linked to the ward store batch that was used; the draw from the store is its own record.
* Medicines are still dispensed at the pharmacy counter from the main store; the counter does not sell from a location.
* One transfer moves stock within one facility; moving stock between facilities is not supported.

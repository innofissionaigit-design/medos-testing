# Payroll

## Purpose
Monthly salary for the hospital's employees: pay structures, a monthly run that makes one payslip per employee, approval by a second person, payment, and payslips the employee can print. Doctor commission and fixed fees are separate (docs/doctor-payouts.md). Full HR (leave, attendance, recruitment, appraisals) is not part of this module.

## Entities
- **Employee**: code (`EMP-0001`), name, designation, department, joining and last day, optional link to a user (so they can see their own payslips), bank account, IFSC, PAN, UAN, ESI number. Bank account and PAN are shown masked. Never deleted; made inactive instead.
- **Salary structure**: basic, house rent allowance, other allowance, and whether provident fund, ESI and professional tax apply, from a date. Append-only: a raise is a new structure from a later date. A payslip uses the latest structure that started on or before the month's last day.
- **Payroll run**: one per facility per month. States `DRAFT → APPROVED → PAID`; a draft can be `CANCELLED` (with a reason), which frees the month.
- **Payslip**: one per employee per run, with every figure calculated by the server.

## Workflow
1. The payroll officer adds employees and sets their pay.
2. At month end, the officer starts the month's payroll. Every active employee who was employed in the month and has a salary structure gets a payslip; anyone without one is listed as left out. Joining or leaving mid-month is counted as days of loss of pay automatically.
3. On each draft payslip the officer enters days of loss of pay (half days allowed), bonus, income tax (TDS) and other deductions. Provident fund, ESI and professional tax are recalculated each time.
4. A different person with `PAYROLL_APPROVE` (the administrator) approves. This fixes every figure and the run's totals. The person who prepared the run cannot approve it (checked in the service and again in the database).
5. The approver marks the run paid with the date and the bank batch reference.
6. Employees see their own payslips on My account once the run is approved, and can print them.

## Calculation (defaults, to be confirmed by the hospital's accountant)
Each pay component is scaled by days worked ÷ days in the month, rounded to the paisa. Provident fund: 12% of basic up to a ₹15,000 ceiling (employee and employer), rounded to the rupee. ESI: employee 0.75% and employer 3.25% of gross when gross is ₹21,000 or less, rounded up to the rupee. Professional tax: West Bengal slabs by monthly gross (up to ₹10,000 nil, ₹110, ₹130, ₹150, then ₹200). TDS is entered by hand. The rates are constants in `payroll.domain.ts` so a change in law is a one-line change.

## Permissions
`PAYROLL_READ` (see employees, runs, payslips), `PAYROLL_MANAGE` (employees, pay, drafts, cancel), `PAYROLL_APPROVE` (approve, mark paid). Roles: `PAYROLL_OFFICER` has read and manage; `ADMINISTRATOR` has read and approve. Own payslips need no permission.

## Audit events
`PAYROLL_EMPLOYEE_ADDED/UPDATED`, `PAYROLL_STRUCTURE_SET`, `PAYROLL_RUN_CREATED`, `PAYROLL_SLIP_ADJUSTED`, `PAYROLL_RUN_APPROVED`, `PAYROLL_RUN_PAID`, `PAYROLL_RUN_CANCELLED`, `DOCUMENT_PRINTED`.

## Database rules
Employees, structures and runs are never deleted; structures cannot be edited. A payslip must add up (gross, deductions, net) and use a structure of the same employee. After approval neither the run's figures nor its payslips can change; a paid or cancelled run is frozen. A run can only be paid after approval, and not approved by its preparer. One live run per facility and month.

## API
`GET/POST /payroll/employees`, `PATCH /payroll/employees/:id`, `GET/POST /payroll/employees/:id/structures`, `GET/POST /payroll/runs`, `GET /payroll/runs/:id`, `PUT /payroll/runs/:id/payslips/:slipId`, `POST /payroll/runs/:id/approve|pay|cancel`, `GET /payroll/my-payslips`, `GET /print/payslips/:id`.

## Known limitations
No attendance or leave tracking (days of loss of pay are typed in); no arrears, advances or loan recovery schedules; no Form 16 or TDS computation; no PF/ESI challan or bank file generation; no multiple salary heads beyond basic, HRA and one other allowance; one currency (INR). See `docs/backlog.md`.

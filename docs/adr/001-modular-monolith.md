# ADR-001: Modular monolith

**Status:** Accepted (Stage 0; decided in CLAUDE.md §2)

## Context
MedOS targets 10–150 bed hospitals with small engineering capacity per deployment. Clinical and financial workflows (consultation → invoice → payment → dispense; admission → bed → charges → discharge) need atomic multi-module transactions. Operational simplicity and debuggability matter more than independent scaling.

## Decision
One deployable NestJS API with strictly separated modules under `apps/api/src/modules/*`, and one Next.js web app, in a pnpm/Turborepo monorepo. Modules communicate through exported service interfaces, not by reaching into each other's tables or repositories. A single PostgreSQL database holds all data. No microservices, no Kafka, no Kubernetes.

## Alternatives considered
- **Microservices:** distributed transactions for billing/pharmacy/bed workflows, much higher ops cost; rejected.
- **Single un-modularised app:** faster initially, but erodes boundaries and tenant/permission discipline; rejected.
- **Serverless functions:** poor fit for transactional workflows and connection management.

## Consequences
+ Real ACID transactions across modules (e.g. dispense + stock + receipt + audit).
+ Simple deploy, local dev and debugging.
− Discipline needed to keep module boundaries (enforced by lint rules/import boundaries in Stage 1).
− Horizontal scaling is by replicating the whole API; acceptable for target size. A module can be extracted later if proven necessary (new ADR).

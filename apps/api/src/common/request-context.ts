import type { Permission } from "@medos/shared";

/**
 * Authoritative, server-derived request context. Built by AuthGuard from the verified
 * token plus a fresh database lookup; never from request body/query/headers.
 */
/**
 * What clinical data the caller may see (docs/data-access.md), worked out by AuthGuard from the session:
 *  - ALL: the organisation administrator (DATA_SCOPE_ALL), and staff who are neither a doctor nor assigned to a department.
 *  - DOCTOR: a doctor sees only their own patients, visits, records and reports.
 *  - DEPARTMENT: staff assigned to departments see only the data of those departments.
 */
export type DataScope =
  | { readonly kind: "ALL" }
  | { readonly kind: "DOCTOR"; readonly practitionerIds: readonly string[] }
  | { readonly kind: "DEPARTMENT"; readonly departmentIds: readonly string[] };

export interface RequestContext {
  readonly tenantId: string;
  readonly facilityId: string;
  readonly userId: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly requestId: string;
  readonly dataScope: DataScope;
  /** Set when the caller is an API client (an outside system or bot) rather than a signed-in person. Such callers only see what they created. */
  readonly apiClientId?: string;
}

export interface AuthedRequest {
  ctx?: RequestContext;
  requestId?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  method: string;
}

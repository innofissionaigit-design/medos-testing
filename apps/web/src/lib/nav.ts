/** Navigation is derived from permissions and facility feature flags (never from role names); role only influences order. */

export interface NavItem { href: string; label: string; anyOf?: string[]; feature?: "PHARMACY_ENABLED" | "IPD_ENABLED" | "NURSING_ENABLED" }

/** REPORT_READ opens every report; each REPORT_<AREA> opens that area's reports (the API enforces the same rule). */
export const REPORT_PERMISSIONS = ["REPORT_READ", "REPORT_OPD", "REPORT_FINANCE", "REPORT_IPD", "REPORT_PHARMACY", "REPORT_MY_PRACTICE"];

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/patients", label: "Patients", anyOf: ["PATIENT_READ"] },
  { href: "/appointments", label: "Appointments", anyOf: ["APPOINTMENT_READ"] },
  { href: "/queue", label: "OPD queue", anyOf: ["QUEUE_READ"] },
  { href: "/billing", label: "Billing", anyOf: ["INVOICE_READ"] },
  { href: "/pharmacy", label: "Pharmacy", anyOf: ["PHARMACY_READ"], feature: "PHARMACY_ENABLED" },
  { href: "/procurement", label: "Procurement", anyOf: ["STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ", "STOCK_CONSUME", "STOCK_COUNT", "STOCK_COUNT_APPROVE", "SUPPLIER_PAY"], feature: "PHARMACY_ENABLED" },
  { href: "/teleconsult", label: "Video consultations", anyOf: ["TELE_READ"] },
  { href: "/payroll", label: "Payroll", anyOf: ["PAYROLL_READ"] },
  { href: "/claims", label: "Insurance claims", anyOf: ["CLAIM_MANAGE", "CLAIM_SETTLE", "CLAIM_MASTERS"] },
  // One module for the laboratory (pathology) and radiology branches; the page shows each person only the branch their role works in.
  { href: "/lis", label: "LIS", anyOf: ["LAB_COLLECT", "LAB_RESULT", "LAB_VERIFY", "LAB_MASTERS", "RAD_PERFORM", "RAD_REPORT"] },
  { href: "/ipd", label: "Admissions", anyOf: ["ADMISSION_READ"], feature: "IPD_ENABLED" },
  { href: "/nursing", label: "Nursing", anyOf: ["NURSING_READ"], feature: "NURSING_ENABLED" },
  { href: "/housekeeping", label: "Housekeeping", anyOf: ["BED_HOUSEKEEPING", "HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE"], feature: "IPD_ENABLED" },
  { href: "/aftercare", label: "After discharge", anyOf: ["AFTERCARE_MANAGE", "COMPLAINT_READ", "COMPLAINT_MANAGE"] },
  { href: "/post-discharge", label: "Post-discharge", anyOf: ["MRD_RECORD_COMPLETE", "CLAIM_READ", "REPORT_FINANCE", "MRD_RETENTION"], feature: "IPD_ENABLED" },
  { href: "/reports", label: "Reports", anyOf: REPORT_PERMISSIONS },
  { href: "/admin", label: "Administration", anyOf: ["ADMIN_USERS", "ADMIN_MASTERS", "ADMIN_SETTINGS"] },
  { href: "/audit", label: "Audit", anyOf: ["AUDIT_READ"] },
];

/** CLAUDE.md §24: what each role sees first. */
const ROLE_ORDER: Record<string, string[]> = {
  RECEPTIONIST: ["/dashboard", "/patients", "/appointments", "/queue", "/ipd", "/billing"],
  DOCTOR: ["/queue", "/patients", "/appointments", "/ipd", "/dashboard"],
  NURSE: ["/nursing", "/ipd", "/patients", "/dashboard"],
  RMO: ["/ipd", "/patients", "/nursing", "/dashboard"],
  OT_COORDINATOR: ["/ipd", "/patients", "/dashboard"],
  PATIENT_TRANSPORT: ["/ipd", "/dashboard"],
  HOUSEKEEPING: ["/housekeeping", "/dashboard"],
  CARE_COORDINATOR: ["/aftercare", "/patients", "/appointments", "/dashboard"],
  PATIENT_RELATIONS: ["/aftercare", "/patients", "/dashboard"],
  MEDICAL_RECORDS: ["/post-discharge", "/ipd", "/patients", "/dashboard"],
  PHARMACIST: ["/pharmacy", "/procurement", "/billing", "/patients", "/dashboard"],
  PROCUREMENT: ["/procurement", "/pharmacy", "/reports", "/dashboard"],
  PAYROLL_OFFICER: ["/payroll", "/patients", "/dashboard"],
  CLAIMS_OFFICER: ["/claims", "/ipd", "/billing", "/patients", "/dashboard"],
  LAB_TECHNICIAN: ["/lis", "/patients", "/dashboard"],
  PATHOLOGIST: ["/lis", "/patients", "/dashboard"],
  RADIOGRAPHER: ["/lis", "/patients", "/dashboard"],
  RADIOLOGIST: ["/lis", "/patients", "/dashboard"],
  CASHIER: ["/billing", "/dashboard", "/patients"],
  ADMINISTRATOR: ["/dashboard", "/reports", "/admin", "/audit"],
  MANAGER: ["/dashboard", "/reports", "/billing", "/audit"],
};

export function visibleNav(permissions: ReadonlySet<string>, features: Record<string, boolean>, roles: string[]): NavItem[] {
  const items = NAV.filter((n) => (!n.anyOf || n.anyOf.some((p) => permissions.has(p))) && (!n.feature || features[n.feature] !== false));
  const order = roles.flatMap((r) => ROLE_ORDER[r] ?? []);
  const rank = (href: string) => { const i = order.indexOf(href); return i === -1 ? 1000 + NAV.findIndex((n) => n.href === href) : i; };
  return [...items].sort((a, b) => rank(a.href) - rank(b.href));
}

/** Where to land after login. */
export const homeFor = (items: NavItem[]): string => items[0]?.href ?? "/dashboard";

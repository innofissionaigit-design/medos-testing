# LIS (Laboratory Information System)

One module in the menu, **LIS**, at `/lis`. It has two branches, each with its own screens, and each person sees only the branch their job needs.

| Branch | Address | Who works in it | Screens |
|---|---|---|---|
| Pathology (laboratory) | `/lis?branch=pathology` | Lab technician, pathologist | Work list, Critical results, Tests and ranges (only with `LAB_MASTERS`, the pathologist and administrator) |
| Radiology | `/lis?branch=radiology` | Radiographer, radiologist | Work list, Critical findings |

## Who sees what

The page follows permissions, never role names (the API enforces the same permissions; the page only decides what to show).

* Branch **Pathology** needs `LAB_READ`; **Radiology** needs `RAD_READ`.
* A person with one branch sees only that branch, with no switcher. Asking for the other branch in the address shows "You do not have access to this branch" and keeps them in their own.
* A person who may read both (a doctor, a manager, the administrator) gets a Pathology / Radiology switcher. They start in the branch they work in, otherwise Pathology.
* The **LIS** menu entry appears for people who work in a branch (`LAB_COLLECT`, `LAB_RESULT`, `LAB_VERIFY`, `LAB_MASTERS`, `RAD_PERFORM`, `RAD_REPORT`). Doctors and nurses reach results from the visit and admission pages as before.
* What each role can do inside a branch is unchanged: technician collects samples and enters results (`LAB_COLLECT`, `LAB_RESULT`); pathologist verifies, amends and maintains tests (`LAB_VERIFY`, `LAB_MASTERS`); radiographer performs scans (`RAD_PERFORM`); radiologist reports (`RAD_REPORT`). Permissions are listed in `packages/shared/src/permissions.ts`.

The old addresses `/lab` and `/radiology` still work: they open the matching branch.

Code: `apps/web/src/app/(app)/lis/page.tsx`, `apps/web/src/components/lis.tsx`, the branch rule in `apps/web/src/lib/lis-branches.ts` (unit-tested in `lib.test.ts`). The branch screens are the existing `components/lab.tsx` and `components/radiology.tsx`; the API (`/lab/*`, `/radiology/*`) is unchanged. Further detail: `lims.md`, `radiology.md`.

Known limitations: the demo roles above are separate logins; a person who does both pathology and radiology needs both sets of permissions through a custom role.

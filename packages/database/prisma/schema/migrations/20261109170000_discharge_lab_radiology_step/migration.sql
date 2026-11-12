-- Discharge: a new clearance stage for laboratory and radiology (docs/discharge-stages.md). It reconciles itself from the test orders,
-- the lab results and the radiology reports, and can be waived by a doctor with a reason like the other stages.
ALTER TYPE "ClearanceStep" ADD VALUE IF NOT EXISTS 'LAB_RADIOLOGY' BEFORE 'BILLING';

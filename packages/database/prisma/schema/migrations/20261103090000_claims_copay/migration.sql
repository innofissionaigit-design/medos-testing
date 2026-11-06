-- Claims co-pay (docs/claims.md): a policy can carry a co-pay percentage and a deductible; submitting a claim records the calculation it used.

-- AlterTable
ALTER TABLE "PatientPolicy" ADD COLUMN "copayPercent" DECIMAL(5,2),
ADD COLUMN "deductible" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "deductibleUsed" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Claim" ADD COLUMN "calculatedAmount" DECIMAL(14,2),
ADD COLUMN "patientShare" DECIMAL(14,2),
ADD COLUMN "copayPercentApplied" DECIMAL(5,2),
ADD COLUMN "deductibleApplied" DECIMAL(14,2),
ADD COLUMN "amountOverrideReason" TEXT;

ALTER TABLE "PatientPolicy" ADD CONSTRAINT policy_copay_values CHECK (
  ("copayPercent" IS NULL OR ("copayPercent" >= 0 AND "copayPercent" <= 100)) AND deductible >= 0 AND "deductibleUsed" >= 0
);
ALTER TABLE "Claim" ADD CONSTRAINT claim_copay_values CHECK (
  ("calculatedAmount" IS NULL OR "calculatedAmount" >= 0) AND ("patientShare" IS NULL OR "patientShare" >= 0)
  AND ("copayPercentApplied" IS NULL OR ("copayPercentApplied" >= 0 AND "copayPercentApplied" <= 100))
  AND ("deductibleApplied" IS NULL OR "deductibleApplied" >= 0)
  AND ("amountOverrideReason" IS NULL OR length(btrim("amountOverrideReason")) >= 10)
);

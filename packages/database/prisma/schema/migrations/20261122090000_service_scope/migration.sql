-- OPD and IPD services are kept apart (reception's OPD desk bills only outpatient services; the IPD desk only inpatient ones).
CREATE TYPE "ServiceScope" AS ENUM ('OPD', 'IPD', 'BOTH');
ALTER TABLE "Service" ADD COLUMN "availableFor" "ServiceScope" NOT NULL DEFAULT 'BOTH';
-- Surgery and other procedures, room and bed, and nursing charges are inpatient services. Everything else stays available at both desks until the hospital says otherwise.
UPDATE "Service" SET "availableFor" = 'IPD' WHERE "category" IN ('PROCEDURE', 'ROOM_BED', 'NURSING');

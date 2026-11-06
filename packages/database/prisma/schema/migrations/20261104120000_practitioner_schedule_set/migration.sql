-- A doctor whose weekly schedule was never set is bookable at any time (the old behaviour). Once an administrator has saved a schedule, the saved sessions are the
-- only bookable times, including when every session was removed (the doctor is then not bookable). This flag records "a schedule has been saved".

-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "scheduleSet" BOOLEAN NOT NULL DEFAULT false;

-- Doctors that already have, or once had, sessions count as having a schedule.
UPDATE "Practitioner" p SET "scheduleSet" = true WHERE EXISTS (SELECT 1 FROM "PractitionerSchedule" s WHERE s."practitionerId" = p.id);

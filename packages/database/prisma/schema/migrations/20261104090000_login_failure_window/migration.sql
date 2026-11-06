-- Sign-in lock-out (docs/authentication.md): wrong passwords count towards a lock only if they are close together in time, so the time of the last wrong try is kept.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastFailedLoginAt" TIMESTAMPTZ(3);

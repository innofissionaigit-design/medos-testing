-- Physical exit: the departure belongs to exactly one admission of one facility (needed for the one-to-one link from the admission).
-- CreateIndex
CREATE UNIQUE INDEX "AdmissionDeparture_tenantId_facilityId_admissionId_key" ON "AdmissionDeparture"("tenantId", "facilityId", "admissionId");

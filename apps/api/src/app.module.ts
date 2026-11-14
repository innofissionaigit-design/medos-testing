import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuditService } from "./common/audit.service";
import { AuthGuard } from "./common/auth.guard";
import { CONFIG, loadConfig, type AppConfig } from "./common/config";
import { AllExceptionsFilter } from "./common/http-pipeline";
import { IdempotencyService } from "./common/idempotency.service";
import { SecretsService } from "./common/secrets";
import { PrismaService } from "./common/prisma.service";
import { RateLimitGuard } from "./common/rate-limit.guard";
import { AppointmentsController } from "./modules/appointments/appointments.controller";
import { AppointmentsService } from "./modules/appointments/appointments.service";
import { EncountersController } from "./modules/encounters/encounters.controller";
import { FollowUpsController } from "./modules/follow-ups/follow-ups.controller";
import { FollowUpsService } from "./modules/follow-ups/follow-ups.service";
import { TestOrdersController } from "./modules/test-orders/test-orders.controller";
import { TestOrdersService } from "./modules/test-orders/test-orders.service";
import { CashierViewService } from "./modules/test-orders/cashier-view.service";
import { CashierCollectService } from "./modules/test-orders/cashier-collect.service";
import { createReminderProvider, REMINDER_PROVIDER } from "./modules/follow-ups/reminder.provider";
import { PaymentLinkWorker } from "./modules/appointments/payment-link.worker";
import { PaymentLinksService } from "./modules/appointments/payment-links.service";
import { createPaymentLinkProvider, PAYMENT_LINK_PROVIDER } from "./modules/appointments/payment-link.provider";
import { ReminderWorker } from "./modules/follow-ups/reminder.worker";
import { RemindersService } from "./modules/follow-ups/reminders.service";
import { EncountersService } from "./modules/encounters/encounters.service";
import { QueueController } from "./modules/queue/queue.controller";
import { QueueService } from "./modules/queue/queue.service";
import { VitalsController } from "./modules/vitals/vitals.controller";
import { VitalsService } from "./modules/vitals/vitals.service";
import { AllergiesController } from "./modules/clinical/allergies.controller";
import { AllergiesService } from "./modules/clinical/allergies.service";
import { ClinicianService } from "./modules/clinical/clinician.service";
import { ConsultationsController } from "./modules/clinical/consultations.controller";
import { ConsultationsService } from "./modules/clinical/consultations.service";
import { PrescriptionsController } from "./modules/prescriptions/prescriptions.controller";
import { PrescriptionsService } from "./modules/prescriptions/prescriptions.service";
import { BillingController } from "./modules/billing/billing.controller";
import { CatalogService } from "./modules/billing/catalog.service";
import { InvoicesService } from "./modules/billing/invoices.service";
import { LedgerService } from "./modules/billing/ledger.service";
import { PaymentsService } from "./modules/billing/payments.service";
import { ShiftsService } from "./modules/billing/shifts.service";
import { DispensingService } from "./modules/pharmacy/dispensing.service";
import { InventoryService } from "./modules/pharmacy/inventory.service";
import { MedicinesService } from "./modules/pharmacy/medicines.service";
import { MedicineMasterController } from "./modules/pharmacy/medicine-master.controller";
import { PharmacyController } from "./modules/pharmacy/pharmacy.controller";
import { StockLocationsController, WardStoresController } from "./modules/pharmacy/stock-locations.controller";
import { StockLocationsService } from "./modules/pharmacy/stock-locations.service";
import { StockService } from "./modules/pharmacy/stock.service";
import { AdmissionsService } from "./modules/ipd/admissions.service";
import { ChargesService } from "./modules/ipd/charges.service";
import { IpdController } from "./modules/ipd/ipd.controller";
import { BedTurnoverController } from "./modules/ipd/bed-turnover.controller";
import { AftercareJobsService, AftercareWorker } from "./modules/aftercare/aftercare-jobs.service";
import { FeedbackLinkService } from "./modules/aftercare/feedback-link.service";
import { AftercareController, PublicFeedbackController } from "./modules/aftercare/aftercare.controller";
import { AftercareService } from "./modules/aftercare/aftercare.service";
import { FeedbackService } from "./modules/aftercare/feedback.service";
import { ProcurementController } from "./modules/procurement/procurement.controller";
import { ProcurementService } from "./modules/procurement/procurement.service";
import { ProcurementExtrasController } from "./modules/procurement/procurement-extras.controller";
import { PayablesService } from "./modules/procurement/payables.service";
import { StockCountsService } from "./modules/procurement/stock-counts.service";
import { CostLedgerBackfillService } from "./modules/procurement/cost-ledger-backfill.service";
import { AftercareScriptsService } from "./modules/aftercare/aftercare-scripts.service";
import { CostLedgerService } from "./modules/procurement/cost-ledger.service";
import { StockRequestsService } from "./modules/procurement/stock-requests.service";
import { PostDischargeController } from "./modules/discharge/post-discharge.controller";
import { RecordRetentionController } from "./modules/discharge/record-retention.controller";
import { RecordRetentionService } from "./modules/discharge/record-retention.service";
import { HousekeepingController } from "./modules/housekeeping/housekeeping.controller";
import { HousekeepingService } from "./modules/housekeeping/housekeeping.service";
import { PostDischargeService } from "./modules/discharge/post-discharge.service";
import { BedTurnoverService } from "./modules/ipd/bed-turnover.service";
import { WardsService } from "./modules/ipd/wards.service";
import { MarService } from "./modules/nursing/mar.service";
import { NursingController } from "./modules/nursing/nursing.controller";
import { NursingService } from "./modules/nursing/nursing.service";
import { DischargeController } from "./modules/discharge/discharge.controller";
import { DischargeService } from "./modules/discharge/discharge.service";
import { DischargeFlowController } from "./modules/discharge-flow/discharge-flow.controller";
import { DischargeFlowService } from "./modules/discharge-flow/discharge-flow.service";
import { DischargeFlowJobsService, DischargeFlowWorker } from "./modules/discharge-flow/discharge-flow-jobs.service";
import { AdmissionTestsService } from "./modules/discharge/admission-tests.service";
import { ProceduresController } from "./modules/procedures/procedures.controller";
import { ProceduresService } from "./modules/procedures/procedures.service";
import { SummaryService } from "./modules/discharge/summary.service";
import { PrintController } from "./modules/print/print.controller";
import { PrintService } from "./modules/print/print.service";
import { ReportsController } from "./modules/reports/reports.controller";
import { ReportsService } from "./modules/reports/reports.service";
import { FilesController } from "./modules/documents/files.controller";
import { FilesService } from "./modules/documents/files.service";
import { ScanService } from "./modules/documents/scan.service";
import { StorageService } from "./modules/documents/storage.service";
import { SettingsController } from "./modules/settings/settings.controller";
import { SettingsService } from "./modules/settings/settings.service";
import { FeatureGuard } from "./common/feature.guard";
import { AuditController } from "./modules/audit/audit.controller";
import { AuthController } from "./modules/auth/auth.controller";
import { AuthService } from "./modules/auth/auth.service";
import { PasswordService } from "./modules/auth/password.service";
import { FacilitiesController } from "./modules/facilities/facilities.controller";
import { FacilitiesService } from "./modules/facilities/facilities.service";
import { HealthController } from "./modules/health/health.controller";
import { MastersController } from "./modules/masters/masters.controller";
import { MastersService } from "./modules/masters/masters.service";
import { PatientsController } from "./modules/patients/patients.controller";
import { PatientsService } from "./modules/patients/patients.service";
import { NumberingController } from "./modules/numbering/numbering.controller";
import { NumberingService } from "./modules/numbering/numbering.service";
import { TenantsController } from "./modules/tenants/tenants.controller";
import { TenantsService } from "./modules/tenants/tenants.service";
import { UsersController } from "./modules/users/users.controller";
import { UsersService } from "./modules/users/users.service";
import { AdvancesController } from "./modules/billing/advances.controller";
import { OCR_PROVIDER, createOcrProvider } from "./modules/prescriptions/ocr.provider";
import { ClaimExchangeService } from "./modules/claims/claim-exchange.service";
import { CLAIM_TRANSPORT, createClaimTransport } from "./modules/claims/claim-transport";
import { MESSAGE_PROVIDER, createMessageProvider } from "./modules/prescriptions/message.provider";
import { PrescriptionDeliveryService } from "./modules/prescriptions/prescription-delivery.service";
import { PrescriptionDeliveryController } from "./modules/prescriptions/prescription-delivery.controller";
import { WebhooksService } from "./modules/integrations/webhooks.service";
import { OutboundWorker } from "./modules/integrations/outbound.worker";
import { OcrConfigController } from "./modules/prescriptions/ocr-config.controller";
import { OcrConfigService } from "./modules/prescriptions/ocr-config.service";
import { PrescriptionShareController, PublicPrescriptionController } from "./modules/prescriptions/prescription-share.controller";
import { PrescriptionShareService } from "./modules/prescriptions/prescription-share.service";
import { RegistrationFeeService } from "./modules/patients/registration-fee.service";
import { ScansController } from "./modules/prescriptions/scans.controller";
import { ScansService } from "./modules/prescriptions/scans.service";
import { PrescriptionDraftService } from "./modules/prescriptions/prescription-draft.service";
import { TemplatesController } from "./modules/prescriptions/templates.controller";
import { TemplatesService } from "./modules/prescriptions/templates.service";
import { EarningsController, EarningsReportsController } from "./modules/earnings/earnings.controller";
import { EarningsService } from "./modules/earnings/earnings.service";
import { ShareLedgerService } from "./modules/earnings/share-ledger.service";
import { PayoutsService } from "./modules/earnings/payouts.service";
import { LabController } from "./modules/lab/lab.controller";
import { LabService } from "./modules/lab/lab.service";
import { RadiologyController } from "./modules/radiology/radiology.controller";
import { RadImagesController } from "./modules/radiology/rad-images.controller";
import { RadImagesService } from "./modules/radiology/rad-images.service";
import { RadiologyService } from "./modules/radiology/radiology.service";
import { ClaimsController } from "./modules/claims/claims.controller";
import { ClaimChecklistController } from "./modules/claims/claim-checklist.controller";
import { ClaimChecklistService } from "./modules/claims/claim-checklist.service";
import { ClaimDocumentsController } from "./modules/claims/claim-documents.controller";
import { ClaimDocumentsService } from "./modules/claims/claim-documents.service";
import { ClaimsService } from "./modules/claims/claims.service";
import { InsuranceMoneyController } from "./modules/claims/insurance-money.controller";
import { InsuranceMoneyService } from "./modules/claims/insurance-money.service";
import { PayrollController } from "./modules/payroll/payroll.controller";
import { PayrollService } from "./modules/payroll/payroll.service";
import { AttendanceController } from "./modules/payroll/attendance.controller";
import { AttendanceService } from "./modules/payroll/attendance.service";
import { PortalController, PortalAuthController, AppointmentRequestsController } from "./modules/portal/portal.controller";
import { PortalAuthService, PortalGuard, PortalService } from "./modules/portal/portal.service";
import { EmailController } from "./modules/email/email.controller";
import { EMAIL_PROVIDER, createEmailProvider } from "./modules/email/email.provider";
import { EmailService } from "./modules/email/email.service";
import { EmailWorker } from "./modules/email/email.worker";
import { NotificationsController } from "./modules/notifications/notifications.controller";
import { NotificationsService } from "./modules/notifications/notifications.service";
import { TelemedicineController } from "./modules/telemedicine/telemedicine.controller";
import { TelemedicineService } from "./modules/telemedicine/telemedicine.service";
import { AbdmController } from "./modules/abdm/abdm.controller";
import { AbdmService } from "./modules/abdm/abdm.service";
import { AiController } from "./modules/ai/ai.controller";
import { AiService } from "./modules/ai/ai.service";
import { BookingApiController } from "./modules/appointments/booking-api.controller";
import { BookingApiService } from "./modules/appointments/booking-api.service";
import { IntegrationsController } from "./modules/integrations/integrations.controller";
import { IntegrationsService } from "./modules/integrations/integrations.service";
import { StatementController } from "./modules/billing/statement.controller";
import { MissedBillingController } from "./modules/billing/missed-billing.controller";
import { MissedBillingService } from "./modules/billing/missed-billing.service";
import { StatementService } from "./modules/billing/statement.service";
import { AdvancesService } from "./modules/billing/advances.service";
import { MergeService } from "./modules/patients/merge.service";
import { PatientIdentifiersService } from "./modules/patients/patient-identifiers.service";
import { ImportsController } from "./modules/imports/imports.controller";
import { ImportsService } from "./modules/imports/imports.service";
import { PrivacyController } from "./modules/privacy/privacy.controller";
import { PrivacyService } from "./modules/privacy/privacy.service";

/** Single registry so a test can prove every route declares its access policy. */
export const CONTROLLERS = [
  HealthController, AuthController, TenantsController, FacilitiesController,
  UsersController, NumberingController, AuditController, MastersController, PatientsController,
  EncountersController, AppointmentsController, QueueController, VitalsController,
  AllergiesController, ConsultationsController, TestOrdersController, PrescriptionsController, BillingController, PharmacyController, StockLocationsController, WardStoresController, PrescriptionDeliveryController, EarningsReportsController, LabController, RadiologyController, RadImagesController,ClaimsController, InsuranceMoneyController, ClaimChecklistController, ClaimDocumentsController, PayrollController, AttendanceController, PortalAuthController, PortalController, AppointmentRequestsController, TelemedicineController, NotificationsController, EmailController, AbdmController, AiController, IpdController, BedTurnoverController, PostDischargeController, RecordRetentionController, HousekeepingController, ProcurementController, ProcurementExtrasController, AftercareController, PublicFeedbackController, NursingController, DischargeController, DischargeFlowController, ProceduresController, SettingsController, MedicineMasterController, PrintController, ReportsController, FilesController, FollowUpsController, PrivacyController, ImportsController, AdvancesController, StatementController, MissedBillingController, BookingApiController, IntegrationsController, EarningsController, ScansController, TemplatesController, OcrConfigController, PrescriptionShareController, PublicPrescriptionController,
];

@Module({
  controllers: CONTROLLERS,
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    PrismaService, AuditService, PasswordService,
    AuthService, TenantsService, FacilitiesService, UsersService, NumberingService, MastersService, PatientsService, IdempotencyService,
    EncountersService, AppointmentsService, QueueService, VitalsService,
    ClinicianService, AllergiesService, ConsultationsService, PrescriptionsService,
    CatalogService, InvoicesService, LedgerService, PaymentsService, ShiftsService,
    StockService, MedicinesService, InventoryService, StockLocationsService, DispensingService,
    WardsService, BedTurnoverService, PostDischargeService, RecordRetentionService, HousekeepingService, ProcurementService, CostLedgerService, CostLedgerBackfillService, AftercareScriptsService, AftercareService, FeedbackService, FeedbackLinkService, AftercareJobsService, AftercareWorker, PayablesService, StockCountsService, StockRequestsService, AdmissionsService, ChargesService, NursingService, MarService, SettingsService, DischargeService, DischargeFlowService, DischargeFlowJobsService, DischargeFlowWorker, AdmissionTestsService, ProceduresService, SummaryService, PrintService, ReportsService, FilesService, StorageService, ScanService,
    RemindersService, ReminderWorker, FollowUpsService, TestOrdersService, PrescriptionDraftService, CashierViewService, CashierCollectService, PrivacyService, ImportsService, MergeService, PatientIdentifiersService, AdvancesService, StatementService, MissedBillingService, BookingApiService, IntegrationsService, EarningsService, ShareLedgerService, PayoutsService, LabService, RadiologyService, RadImagesService,ClaimsService, InsuranceMoneyService, ClaimChecklistService, ClaimDocumentsService, PayrollService, AttendanceService, PortalAuthService, PortalService, PortalGuard, TelemedicineService, NotificationsService, EmailService, EmailWorker, AbdmService, AiService, ScansService, TemplatesService, OcrConfigService, SecretsService, PrescriptionShareService, RegistrationFeeService,
    { provide: OCR_PROVIDER, useFactory: (c: AppConfig) => createOcrProvider(c), inject: [CONFIG] },
    { provide: CLAIM_TRANSPORT, useFactory: (c: AppConfig) => createClaimTransport(c), inject: [CONFIG] },
    ClaimExchangeService,
    { provide: MESSAGE_PROVIDER, useFactory: (c: AppConfig) => createMessageProvider(c), inject: [CONFIG] },
    { provide: EMAIL_PROVIDER, useFactory: (c: AppConfig) => createEmailProvider(c), inject: [CONFIG] },
    WebhooksService, PrescriptionDeliveryService, OutboundWorker,
    { provide: REMINDER_PROVIDER, useFactory: (c: AppConfig) => createReminderProvider(c.REMINDER_PROVIDER), inject: [CONFIG] },
    { provide: PAYMENT_LINK_PROVIDER, useFactory: (c: AppConfig) => createPaymentLinkProvider(c.PAYMENT_LINK_PROVIDER), inject: [CONFIG] },
    PaymentLinksService, PaymentLinkWorker,
    // Order matters: rate limit first (cheap), then authentication + authorization.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [PrismaService, NumberingService, AuditService, PasswordService, TenantsService, IdempotencyService, EncountersService, AdmissionsService, ChargesService],
})
export class AppModule {}

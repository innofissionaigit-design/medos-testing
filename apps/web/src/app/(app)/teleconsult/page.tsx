"use client";
import { Gate } from "@/components/gate";
import { VideoConsults } from "@/components/telemedicine";
import { PageHeader } from "@/components/ui";

export default function TeleconsultPage() {
  return (
    <Gate anyOf={["TELE_READ"]}>
      <PageHeader title="Video consultations" />
      <VideoConsults />
    </Gate>
  );
}

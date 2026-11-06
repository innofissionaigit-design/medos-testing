import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PwaSupport } from "./pwa";

export const metadata: Metadata = {
  title: "My health records",
  description: "See your appointments, prescriptions, reports and bills, and ask for an appointment.",
  manifest: "/patient/manifest.webmanifest",
  icons: { icon: "/patient/icon-192.png", apple: "/patient/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "My health", statusBarStyle: "default" },
};
export const viewport: Viewport = { themeColor: "#0f766e", width: "device-width", initialScale: 1 };

/** The patient app (docs/patient-app.md): a page that can be installed on a phone's home screen. */
export default function PatientLayout({ children }: { children: ReactNode }) {
  return <>{children}<PwaSupport /></>;
}

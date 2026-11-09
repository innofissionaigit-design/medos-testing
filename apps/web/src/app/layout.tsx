import "./globals.css";
import type { ReactNode } from "react";
import { Providers } from "./providers";

export const metadata = { title: "MedOS", description: "Hospital management" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased"><Providers>{children}</Providers></body>
    </html>
  );
}

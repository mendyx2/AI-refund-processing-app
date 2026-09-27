import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Refund Processing",
  description: "AI-assisted refund request triage",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}

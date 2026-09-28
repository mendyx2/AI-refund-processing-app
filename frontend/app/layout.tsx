import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shopwell Help Center",
  description: "AI-assisted refund support",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={GeistSans.variable}>
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
        {/* Soft brand glow behind every page */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[480px] bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.14),transparent_65%)]"
        />
        {children}
      </body>
    </html>
  );
}

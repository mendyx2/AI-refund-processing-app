import type { Metadata } from "next";

import AdminDashboard from "./AdminDashboard";

export const metadata: Metadata = {
  title: "Refund requests · Admin",
  description: "Review refund decisions and their reasoning",
};

export default function AdminPage() {
  return <AdminDashboard />;
}

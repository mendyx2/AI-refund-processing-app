import type { Metadata } from "next";

import SupportChat from "./SupportChat";

export const metadata: Metadata = {
  title: "Refund support",
  description: "Request a refund for one of your orders",
};

export default function SupportPage() {
  return <SupportChat />;
}

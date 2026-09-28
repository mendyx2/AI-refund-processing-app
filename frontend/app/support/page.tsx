import type { Metadata } from "next";

import HelpCenter from "./HelpCenter";

export const metadata: Metadata = {
  title: "Help Center · Refunds",
  description: "Get help with a refund for one of your orders",
};

export default function SupportPage() {
  return <HelpCenter />;
}

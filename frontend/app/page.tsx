import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold tracking-tight">Hello</h1>
      <Link href="/support" className="text-indigo-600 underline">
        Go to refund support
      </Link>
    </main>
  );
}

import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold tracking-tight">Hello</h1>
      <nav className="flex gap-6">
        <Link href="/support" className="text-indigo-600 underline">
          Customer support
        </Link>
        <Link href="/admin" className="text-indigo-600 underline">
          Admin dashboard
        </Link>
      </nav>
    </main>
  );
}

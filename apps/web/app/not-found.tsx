import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="heading text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted">The page or record you asked for does not exist, or it was deleted.</p>
      <Link href="/" className="mt-6 inline-block text-ledger underline underline-offset-2">
        Go to the overview
      </Link>
    </div>
  );
}

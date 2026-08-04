import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Home() {
  const statuses = ["queued", "processing", "published", "failed"] as const;

  const counts = await Promise.all(
    statuses.map(async (s) => {
      const { count } = await supabaseAdmin
        .from("post_targets")
        .select("*", { count: "exact", head: true })
        .eq("status", s);
      return [s, count ?? 0] as const;
    })
  );

  return (
    <main>
      <h1>Social Publisher</h1>
      <p>Queue status</p>
      <ul>
        {counts.map(([status, n]) => (
          <li key={status}>
            {status}: <strong>{n}</strong>
          </li>
        ))}
      </ul>
    </main>
  );
}

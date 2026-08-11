import { loadQueueSnapshot } from "@/lib/queue-snapshot";

export const dynamic = "force-dynamic";

const codeBlock = {
  background: "#f4f4f5",
  color: "#18181b",
  padding: "0.75rem",
  borderRadius: "0.375rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
} as const;

export default async function Home() {
  const { counts, failures, accounts, error, missingEnv } = await loadQueueSnapshot();

  if (error === null) {
    const unhealthy = accounts.filter((a) => a.status !== "active" || !a.hasToken);

    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "42rem" }}>
        <h1>Social Publisher</h1>

        <h2>Queue status</h2>
        <ul>
          {counts.map(([status, n]) => (
            <li key={status}>
              {status}: <strong>{n}</strong>
            </li>
          ))}
        </ul>

        {failures.length > 0 && (
          <section>
            <h2>Recent failures</h2>
            <p>
              These stopped after exhausting their attempts. Fix the cause, then requeue
              them.
            </p>
            <ul>
              {failures.map((failure, index) => (
                <li key={index} style={{ marginBottom: "0.75rem" }}>
                  <strong>{failure.title}</strong> → {failure.handle} (
                  {failure.attempts} attempts)
                  <pre style={codeBlock}>{failure.error}</pre>
                </li>
              ))}
            </ul>
          </section>
        )}

        {unhealthy.length > 0 && (
          <section>
            <h2>Accounts not publishing</h2>
            <p>
              The claim skips these, so their posts wait in <code>queued</code> without
              ever appearing as failures.
            </p>
            <ul>
              {unhealthy.map((account) => (
                <li key={account.handle}>
                  {account.platform} <strong>{account.handle}</strong> — status{" "}
                  <code>{account.status}</code>
                  {account.hasToken ? "" : ", no token_secret_name set"}
                </li>
              ))}
            </ul>
          </section>
        )}

        <h2>Accounts</h2>
        <ul>
          {accounts.length === 0 ? (
            <li>None yet.</li>
          ) : (
            accounts.map((account) => (
              <li key={account.handle}>
                {account.platform} {account.handle} — {account.status}
              </li>
            ))
          )}
        </ul>
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "42rem" }}>
      <h1>Social Publisher</h1>
      <h2>Not reading the database</h2>

      {missingEnv.length > 0 ? (
        <>
          <p>
            {missingEnv.length === 1 ? "This variable is" : "These variables are"} not set on
            this deployment:
          </p>
          <ul>
            {missingEnv.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
          <p>
            Add {missingEnv.length === 1 ? "it" : "them"} in Vercel under Settings →
            Environment Variables, then <strong>redeploy</strong> — variables only take effect
            on a new build.
          </p>
        </>
      ) : (
        <p>
          Every required variable is set, so this is not a configuration gap. The database
          call itself failed:
        </p>
      )}

      <pre style={codeBlock}>{error}</pre>

      <p>
        Publishing does not depend on this page — it is only a queue dashboard. Check the
        scheduler itself with:
      </p>
      <pre style={codeBlock}>
        {'curl -H "Authorization: Bearer $CRON_SECRET" \\\n  <this-domain>/api/cron/publish'}
      </pre>
    </main>
  );
}

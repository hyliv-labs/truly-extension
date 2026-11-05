/** E9 shell. Real unlock / balance / trade progress land in later commits. */
export function App() {
  return (
    <main className="popup">
      <header>
        <h1>Truly</h1>
        <p className="tagline">One trade, one address.</p>
      </header>

      <section className="placeholder">
        {/* TODO(E9): unlock, approved + pending balance, New trade, progress. */}
        <p>Scaffold only — no trade flow wired up yet.</p>
      </section>

      <footer>
        {/* TODO(E2): live Anon-RPC read counter; must be visible in the demo. */}
        <span className="anon-rpc">Anon-RPC reads: —</span>
      </footer>
    </main>
  );
}

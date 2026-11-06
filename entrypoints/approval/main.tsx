import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApprovalRecord } from '@truly/lib/approvals';
import '../popup/style.css';

function Approval() {
  const [record, setRecord] = useState<ApprovalRecord | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const id = new URLSearchParams(window.location.search).get('id');

  useEffect(() => {
    if (!id) return setMissing(true);
    void chrome.runtime
      .sendMessage({ kind: 'getApproval', id })
      .then((response) => {
        if (response?.ok && response.value) setRecord(response.value);
        else setMissing(true);
      })
      .catch(() => setMissing(true));
  }, [id]);

  // The worker is torn down after ~30s idle, and with it the promise holding
  // the dapp's request. Reading a message takes longer than that, so poke the
  // worker periodically — any message resets its idle timer.
  useEffect(() => {
    const timer = setInterval(() => {
      void chrome.runtime.sendMessage({ kind: 'keepAlive' }).catch(() => {});
    }, 20_000);
    return () => clearInterval(timer);
  }, []);

  const answer = async (approved: boolean) => {
    setBusy(true);
    await chrome.runtime.sendMessage({ kind: 'settleApproval', id, approved });
    window.close();
  };

  if (missing) {
    return (
      <main className="popup">
        <h1>Truly</h1>
        <p className="error">This request has expired.</p>
      </main>
    );
  }

  if (!record) {
    return (
      <main className="popup">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="popup">
      <header>
        <h1>{approvalTitle(record.method)}</h1>
        <p className="tagline">{record.origin}</p>
      </header>

      <section className="panel">
        <label className="field-label">Signing as</label>
        <code className="address">{record.ownerAddress}</code>

        {record.message !== undefined && (
          <>
            <label className="field-label">Message</label>
            <pre className="message">{record.message}</pre>
          </>
        )}

        <div className="actions">
          <button className="secondary" disabled={busy} onClick={() => answer(false)}>
            Reject
          </button>
          <button disabled={busy} onClick={() => answer(true)}>
            Approve
          </button>
        </div>
      </section>
    </main>
  );
}

function approvalTitle(method: string): string {
  if (method === 'personal_sign') return 'Signature request';
  if (method.startsWith('eth_signTypedData')) return 'Typed data';
  if (method === 'eth_sendTransaction') return 'Transaction';
  return 'Connect';
}

const root = document.getElementById('root');
if (!root) throw new Error('approval root missing');

createRoot(root).render(
  <React.StrictMode>
    <Approval />
  </React.StrictMode>,
);

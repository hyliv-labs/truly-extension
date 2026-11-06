/**
 * An approval answer has to survive the worker that asked the question.
 *
 * The promise waiting on the prompt dies with the worker. What remains is the
 * session record. A second answer — the window closing after Approve — must
 * not overwrite the first, or a granted signature is stored as a rejection.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const approvals = await import('../src/lib/approvals.ts');

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const base = {
  requestId: 'req-1',
  approvalId: 'appr-1',
  origin: 'https://app.lighter.xyz',
  method: 'personal_sign',
  params: ['0x6869', '0x1111111111111111111111111111111111111111'] as unknown[],
  ownerAddress: '0x1111111111111111111111111111111111111111',
  ownerIndex: 0,
  message: 'hi',
  createdAt: Date.now(),
};

await approvals.putInFlight({ ...base, status: 'awaiting' });

const approved = await approvals.decideApproval('appr-1', true, 'User rejected the request.');
if (approved?.status !== 'approved') fail(`approve stored ${approved?.status}`);
else pass('approval stored as approved');

const second = await approvals.decideApproval('appr-1', false, 'User rejected the request.');
if (second?.status !== 'approved') fail('closing the window overwrote the approval');
else pass('a later rejection did not undo the approval');

await approvals.putInFlight({ ...base, requestId: 'req-2', approvalId: 'appr-2', status: 'awaiting' });
const rejected = await approvals.decideApproval('appr-2', false, 'User rejected the request.');
if (rejected?.status !== 'rejected' || rejected.error?.code !== 4001) {
  fail(`rejection stored ${rejected?.status}`);
} else pass('rejection stored with 4001');

const signed = {
  ...base,
  requestId: 'req-3',
  approvalId: 'appr-3',
  status: 'completed' as const,
  result: '0xsig',
  rawTx: '0x02abcd',
};
await approvals.putInFlight(signed);
const again = await approvals.getInFlight('req-3');
if (again?.result !== '0xsig' || again.rawTx !== '0x02abcd') fail('completed request lost its result');
else pass('completed request keeps the signature and the raw transaction');

await approvals.putInFlight({
  ...base,
  requestId: 'req-old',
  approvalId: 'appr-old',
  status: 'awaiting',
  createdAt: Date.now() - approvals.APPROVAL_TTL_MS - 1_000,
});
const expired = await approvals.pruneInFlight();
if (!expired.some((entry) => entry.requestId === 'req-old')) fail('stale prompt was kept');
else pass('a prompt past the time limit is dropped');
if (await approvals.getInFlight('req-old')) fail('expired prompt still readable');
else pass('expired prompt is gone');
if (!(await approvals.getInFlight('req-3'))) fail('prune removed a fresh completed request');
else pass('prune left a fresh completed request');

process.exitCode = failed ? 1 : 0;

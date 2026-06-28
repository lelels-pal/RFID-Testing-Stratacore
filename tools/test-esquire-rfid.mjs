/**
 * Esquire RFID deployment smoke tests (no live OCPP required).
 * Run: node tools/test-esquire-rfid.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { fileURLToPath } from 'node:url';

const backendRoot = fileURLToPath(new URL('../apps/backend/', import.meta.url));
const rfidUtilPath = join(backendRoot, 'src/utils/rfid-quota.util.ts');

function testRfidQuotaUtilSource() {
  const src = readFileSync(rfidUtilPath, 'utf8');
  assert.match(src, /RFID_STOP_BUFFER_KWH/);
  assert.match(src, /isRfidQuotaBlocked/);
  console.log('✓ rfid-quota.util.ts defines buffer helpers');
}

async function testBackendHealth(baseUrl) {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  console.log('✓ backend health OK');
}

async function testOperatorFlow(baseUrl) {
  const adminRes = await fetch(`${baseUrl}/api/v1/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin' }),
  });
  if (!adminRes.ok) {
    console.log('⚠ skip API flow tests — set ADMIN_PASSWORD and run backend');
    return;
  }
  const { accessToken } = await adminRes.json();
  const adminHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const testId = `TEST${randomUUID().slice(0, 6).toUpperCase()}`;
  const reg = await fetch(`${baseUrl}/api/v1/charging/rfid`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ rfidCardId: testId, cardholderName: 'Esquire Test', monthlyKwhLimit: 20, pin: '5678' }),
  });
  assert.ok(reg.ok, await reg.text());
  console.log('✓ admin registered RFID with PIN');

  const login = await fetch(`${baseUrl}/api/v1/auth/operator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: testId, pin: '5678' }),
  });
  const loginBody = await login.text();
  assert.ok(login.ok, loginBody);
  const { token, user } = JSON.parse(loginBody);
  assert.ok(user.balance <= 20);
  console.log('✓ operator login OK');

  const consume = await fetch(`${baseUrl}/api/v1/charging/rfid/${testId}`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ currentMonthKwhConsumed: 15 }),
  });
  assert.ok(consume.ok, await consume.text());
  console.log('✓ simulated 15 kWh consumed (5 kWh remaining)');

  const req = await fetch(`${baseUrl}/api/v1/operator/energy-requests`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kwhAmount: 10 }),
  });
  const reqBody = await req.text();
  assert.ok(req.ok, reqBody);
  const energyReq = JSON.parse(reqBody);
  console.log('✓ energy request created');

  const list = await fetch(`${baseUrl}/api/v1/admin/energy-requests`, { headers: adminHeaders });
  const all = JSON.parse(await list.text());
  const pending = all.find((r) => r.id === energyReq.id);
  assert.ok(pending);
  console.log('✓ admin lists energy requests');

  const approve = await fetch(`${baseUrl}/api/v1/admin/energy-requests/${energyReq.id}/approve`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  assert.ok(approve.ok, await approve.text());
  console.log('✓ admin approved energy request');

  const profile = await fetch(`${baseUrl}/api/v1/operator/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const prof = await profile.json();
  assert.equal(prof.base_balance_kwh, 20);
  assert.equal(prof.balance, 15);
  console.log('✓ remaining balance increased after approve (allowance unchanged)');

  await fetch(`${baseUrl}/api/v1/charging/rfid/${testId}`, { method: 'DELETE', headers: adminHeaders });
  console.log('✓ cleanup test RFID');
}

testRfidQuotaUtilSource();

const base = process.env.BACKEND_URL || 'http://localhost:4001';
testBackendHealth(base)
  .then(() => testOperatorFlow(base))
  .then(() => console.log('\nAll Esquire RFID smoke tests passed.'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

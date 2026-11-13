#!/usr/bin/env node
// Stands in for airi-cli. `mandate list` prints FAKE_AIRI_MANDATES. `mandate get-credential` writes a one-time
// credential for a listed mandate (FAKE_AIRI_CREDENTIAL=fail refuses, as an unapproved passkey would).
// `mandate result` succeeds unless FAKE_AIRI_RESULT=fail.
// Every call is appended to FAKE_AIRI_LOG.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (process.env.FAKE_AIRI_LOG) appendFileSync(process.env.FAKE_AIRI_LOG, JSON.stringify(args) + '\n');
const mandates = () => (process.env.FAKE_AIRI_MANDATES ? JSON.parse(readFileSync(process.env.FAKE_AIRI_MANDATES, 'utf8')) : []);

if (args[0] === 'mandate' && args[1] === 'list') {
  console.log(JSON.stringify({ hasMore: false, items: mandates(), page: 0, size: 50 }));
} else if (args[0] === 'mandate' && args[1] === 'get-credential') {
  if (process.env.FAKE_AIRI_CREDENTIAL === 'fail' || !mandates().some((m) => m.mandateId === flag('--mandate-id'))) {
    console.error('Timed out after 300s waiting for credential authorization.');
    process.exit(1);
  }
  const credential = { number: '4111111111111111', cvv: '000', expiryMonth: '12', expiryYear: '2030', cardHolderName: 'Test', protocolType: 'VIC', tokenType: 'DPAN' };
  writeFileSync(flag('--file'), JSON.stringify(credential), { mode: 0o600 });
} else if (args[0] === 'mandate' && args[1] === 'result') {
  if (process.env.FAKE_AIRI_RESULT === 'fail') {
    console.error('injected report failure');
    process.exit(1);
  }
  console.log('{"status":"ok"}');
} else {
  console.error(`fake airi-cli: unexpected ${args.join(' ')}`);
  process.exit(1);
}

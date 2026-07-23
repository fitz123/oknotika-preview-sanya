#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fetchTelegramDiscovery, TELEGRAM_ISSUER } from '../src/auth/conformance.js';
import { loadConfiguration } from '../src/auth/config.js';
import { createOidcService } from '../src/auth/oidc.js';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';

const config = loadConfiguration();
const db = openDatabase(config.databasePath);
const prompt = createInterface({ input: stdin, output: stdout, terminal: true });
try {
  const existing = db.prepare('SELECT id, issuer, subject, enabled FROM configured_editors').get();
  if (existing) throw new Error('An editor already exists; use the normal login or reviewed replacement procedure');
  const discovery = await fetchTelegramDiscovery({ signingAlgorithm: config.signingAlgorithm });
  const oidc = createOidcService(db, {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    discovery,
    allowedAlgorithm: config.signingAlgorithm,
  });
  const authorization = oidc.beginAuthorization();
  stdout.write('\nOpen this one-time URL in Sanya\'s browser:\n\n');
  stdout.write(`${authorization.authorizationUrl}\n\n`);
  stdout.write('After Telegram redirects, copy the complete callback URL from the browser address bar.\n');
  const callbackUrl = (await prompt.question('Callback URL: ')).trim();
  const claims = await oidc.finishIdentityVerification({
    callbackUrl,
    browserBinding: authorization.browserBinding,
  });
  if (claims.iss !== TELEGRAM_ISSUER || !/^\d{5,32}$/.test(claims.sub)) {
    throw new Error('Verified token contains an unsupported Telegram identity');
  }
  const fingerprint = createHash('sha256').update(`${claims.iss}\0${claims.sub}`).digest('hex').slice(0, 16);
  stdout.write(`\nVerified issuer: ${claims.iss}\nVerified subject: ${claims.sub}\nIdentity fingerprint: ${fingerprint}\n`);
  stdout.write('Confirm the identity with Sanya over the separate approved channel before continuing.\n');
  const confirmation = (await prompt.question(`Type ENROLL-${fingerprint} to enroll this identity: `)).trim();
  if (confirmation !== `ENROLL-${fingerprint}`) throw new Error('Enrollment cancelled: fingerprint confirmation did not match');
  const editorId = createContentService(db).configureEditor({ issuer: claims.iss, subject: claims.sub });
  stdout.write(`Editor ${editorId} enrolled; record only timestamp, approvers and fingerprint ${fingerprint}.\n`);
} finally {
  prompt.close();
  db.close();
}

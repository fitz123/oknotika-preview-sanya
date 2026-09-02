#!/usr/bin/env node
import { stdin } from 'node:process';
import {
  configureLocalCredentials,
  rollbackLocalCredentials,
} from '../src/auth/credential-setup.js';

if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  throw new Error('Local credential maintenance must run as root');
}

const options = parseArguments(process.argv.slice(2));
let result;
if (options.rollback) {
  result = await rollbackLocalCredentials({
    databasePath: options.database,
    credentialsRoot: options.credentialsRoot,
    backupsRoot: options.backupsRoot,
    snapshotName: options.rollback,
  });
} else {
  const input = await readInput();
  result = await configureLocalCredentials({
    databasePath: options.database,
    credentialsRoot: options.credentialsRoot,
    backupsRoot: options.backupsRoot,
    username: input[0],
    password: input[1],
    passwordConfirmation: input[2],
  });
}
process.stdout.write(`${JSON.stringify(result)}\n`);

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!value || !['--database', '--credentials-root', '--backups-root', '--rollback'].includes(name)) {
      throw new Error('Usage: configure-local-credentials.js --database PATH --credentials-root PATH --backups-root PATH [--rollback SNAPSHOT]');
    }
    const key = name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (result[key] !== undefined) throw new Error(`Duplicate option: ${name}`);
    result[key] = value;
  }
  for (const name of ['database', 'credentialsRoot', 'backupsRoot']) {
    if (!result[name]) throw new Error(`Missing required option: ${name}`);
  }
  return result;
}

async function readInput() {
  let value = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > 4096) throw new Error('Credential input is too large');
  }
  const records = value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
  if (records.length !== 3) throw new Error('Credential input must contain username and two password entries');
  return records;
}

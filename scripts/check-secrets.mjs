#!/usr/bin/env node
// Fails the build when something that looks like a real credential is committed.
// Runs in CI (security job) and can be run locally: `node scripts/check-secrets.mjs`.
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-(?:api|admin)\d{0,2}-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];
const FORBIDDEN_FILES = [/\.env$/, /\.jks$/, /\.keystore$/, /\.p12$/, /\.p8$/, /\.mobileprovision$/];

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const problems = [];
for (const file of files) {
  if (FORBIDDEN_FILES.some((re) => re.test(file)) && !file.endsWith('.env.example')) {
    problems.push(`${file}: forbidden file type committed`);
    continue;
  }
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > 2_000_000) continue; // skip large binaries
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // binary
  for (const { name, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) problems.push(`${file}: possible ${name} (${m[0].slice(0, 8)}…)`);
  }
}

if (problems.length) {
  console.error('Possible secrets found:\n' + problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`No secrets found in ${files.length} tracked files.`);

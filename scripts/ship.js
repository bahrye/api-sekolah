/**
 * Commit (jika ada perubahan) + push ke GitHub.
 * Deploy Cloudflare berjalan otomatis via .github/workflows/deploy-cloudflare.yml
 *
 * Usage: npm run ship -- "pesan commit"
 *        npm run ship:all -- "pesan"   → push + deploy CF lokal (tanpa menunggu Actions)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const msg = process.argv.slice(2).join(' ').trim() || 'chore: update';

function run(cmd) {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

function hasStagedChanges() {
  try {
    execSync('git diff --staged --quiet', { cwd: root, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

run('git add -A');

if (hasStagedChanges()) {
  run(`git commit -m ${JSON.stringify(msg)}`);
} else {
  console.log('Tidak ada perubahan untuk di-commit.');
}

const branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf8' }).trim() || 'main';
run(`git push origin ${branch}`);

console.log('');
console.log('✓ Terkirim ke GitHub. Deploy Cloudflare dimulai otomatis (tab Actions di repo).');
console.log('  Deploy CF langsung dari PC: npm run deploy:cf');
console.log('  Push + deploy CF lokal: npm run ship:all -- "pesan"');

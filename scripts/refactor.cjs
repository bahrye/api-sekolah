const fs = require('fs');
const path = require('path');

// __dirname is d:\api-sekolah\scripts
const ROOT = path.join(__dirname, '..');

const files = [
  'functions/lib/sync-meta.js',
  'functions/lib/sync-activity-log.js',
  'functions/lib/sync-sekolah.js',
  'functions/lib/sync-status.js',
  'cron-sync.js'
];

files.forEach(f => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    console.log(`File not found: ${p}`);
    return;
  }
  let content = fs.readFileSync(p, 'utf8');
  const original = content;

  // Replace imports
  content = content.replace(/\.\/pg-meta\.js/g, './db-meta.js');
  content = content.replace(/\.\/sekolah-pg\.js/g, './sekolah-db.js');
  content = content.replace(/\.\/neon\.js/g, './db.js');
  content = content.replace(/functions\/lib\/neon\.js/g, 'functions/lib/db.js'); // cron-sync.js
  content = content.replace(/\.\/status-sinkronisasi\.js/g, './status-sinkronisasi.js');

  // Replace types
  content = content.replace(/import\('@neondatabase\/serverless'\)\.NeonQueryFunction/g, "import('@cloudflare/workers-types').D1Database");

  // Replace variable names (sql -> db) in parameters and usage
  content = content.replace(/getSql/g, 'getDb');
  
  // This is a bit brute-force but works well for this codebase because `sql` is used consistently
  content = content.replace(/\(sql\)/g, '(db)');
  content = content.replace(/\(sql,/g, '(db,');
  content = content.replace(/, sql\)/g, ', db)');
  content = content.replace(/, sql,/g, ', db,');
  content = content.replace(/ sql /g, ' db ');
  content = content.replace(/ sql\./g, ' db.');
  content = content.replace(/ sql;/g, ' db;');
  
  // additional replacements for string literals or edge cases
  content = content.replace(/sql`/g, 'db.prepare(`');

  if (content !== original) {
    fs.writeFileSync(p, content);
    console.log(`Refactored: ${p}`);
  } else {
    console.log(`No changes needed for: ${p}`);
  }
});
console.log('Refactoring complete');

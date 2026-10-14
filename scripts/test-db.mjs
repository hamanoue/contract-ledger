// DB の検証を Node だけで実行する（PostgreSQL のインストール不要。PGlite = WASM 版 PostgreSQL）
//   npm run test:db                       … スタブ → マイグレーション → supabase/tests/*.sql
//   npm run test:db -- --seed <file.sql>  … 上記の後に初期データ SQL も流して検証する
// CI（.github/workflows/ci.yml）では本物の PostgreSQL + psql で同じファイルを実行している。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const seedIdx = process.argv.indexOf('--seed');
const seed = seedIdx > 0 ? process.argv[seedIdx + 1] : null;

// psql のメタコマンド（\set, \echo など）は PGlite では使えないので除く
const sqlOf = (file) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !l.trimStart().startsWith('\\')).join('\n');

const files = [
  join(root, 'supabase/tests/00_supabase_stub.sql'),
  ...readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => join(root, 'supabase/migrations', f)),
  ...readdirSync(join(root, 'supabase/tests')).filter((f) => f.endsWith('.sql') && !f.startsWith('00_')).sort().map((f) => join(root, 'supabase/tests', f)),
];

const db = new PGlite();
let failed = false;
for (const f of files) {
  try {
    await db.exec(sqlOf(f));
    console.log(`ok   ${f.slice(root.length)}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${f.slice(root.length)}\n     ${e.message}`);
    break;
  }
}
if (!failed && seed) {
  try {
    await db.exec('reset role;');
    await db.exec(sqlOf(seed));
    const { rows } = await db.query(`select
      (select count(*) from ct_contracts)::int as contracts,
      (select count(*) from ct_contract_allocations)::int as allocations,
      (select count(*) from ct_properties)::int as properties,
      (select count(*) from ct_vendors)::int as vendors`);
    console.log('ok   seed', rows[0]);
  } catch (e) {
    failed = true;
    console.error(`FAIL seed ${seed}\n     ${e.message}`);
  }
}
console.log(failed ? 'TESTS FAILED' : 'ALL TESTS PASSED');
process.exit(failed ? 1 : 0);

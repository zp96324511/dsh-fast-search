import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('.tmp/test.db');
const count = (m) => db.prepare('SELECT count(*) n FROM docs WHERE docs MATCH ?').get(m).n;
const probes = ['mmap', '"mmap_size"', 'node_sqlite', '"node_sqlite"', '"node sqlite"', '"c:\\\\data"', 'project', '"dsh-fast-search"'];
for (const m of probes) {
  try {
    console.log(m.padEnd(24), count(m));
  } catch (e) {
    console.log(m.padEnd(24), 'ERR', e.message);
  }
}
const row = db.prepare("SELECT text FROM docs WHERE text LIKE '%mmap_size%' LIMIT 1").get();
console.log('sample:', row?.text?.slice(0, 160));

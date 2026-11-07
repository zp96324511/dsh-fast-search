import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61 remove_diacritics 2')`);
db.exec(`INSERT INTO t(x) VALUES('中文搜索 插件 fast'), ('PowerShell 命令块')`);
console.log('match 搜索:', db.prepare('SELECT x, bm25(t) s FROM t WHERE t MATCH ?').all('搜索'));
console.log('match 插 :', db.prepare('SELECT x FROM t WHERE t MATCH ?').all('插'));
console.log('match 插件:', db.prepare('SELECT x FROM t WHERE t MATCH ?').all('插件'));
console.log('match fast:', db.prepare('SELECT x FROM t WHERE t MATCH ?').all('fast'));
console.log('snippet:', db.prepare(`SELECT snippet(t,0,'[',']','…',8) s FROM t WHERE t MATCH ?`).all('搜索'));

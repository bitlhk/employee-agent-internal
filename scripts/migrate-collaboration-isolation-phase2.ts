import mysql from 'mysql2/promise';
import 'dotenv/config';

const apply = process.argv.includes('--apply');
const databaseUrl = process.env.DATABASE_URL;

const seedSpaces = [
  { name: '示例协作空间 A', description: '岗位智能体平台示例协作空间 A', sortOrder: 10 },
  { name: '杭州示例企业', description: '杭州示例企业协作空间', sortOrder: 20 },
  { name: '示例试点组', description: '示例试点协作空间', sortOrder: 30 },
  { name: '行业试点组', description: '行业试点协作空间', sortOrder: 40 },
];

console.log(`[COLLAB-MIGRATE] Phase 2 collaboration isolation schema ${apply ? 'apply' : 'dry-run'}`);
console.log('---');
console.log('ALTER TABLE lx_coop_sessions ADD COLUMN space_id INT NULL AFTER creator_user_id (if missing)');
console.log('ALTER TABLE lx_coop_sessions ADD COLUMN deleted_at TIMESTAMP NULL AFTER closed_at (if missing)');
console.log('---');
console.log('CREATE INDEX idx_lx_coop_sessions_space_id ON lx_coop_sessions(space_id) (if missing)');
console.log('CREATE INDEX idx_lx_coop_sessions_deleted_at ON lx_coop_sessions(deleted_at) (if missing)');
console.log('---');
console.log('Seed initial collaboration spaces if missing:');
for (const space of seedSpaces) {
  console.log(`- ${space.name} (sort=${space.sortOrder})`);
}

if (!apply) {
  console.log('[COLLAB-MIGRATE] dry-run only. Re-run with --apply to execute.');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for --apply');
}

const conn = await mysql.createConnection(databaseUrl);
try {
  const [[dbRow]] = await conn.query<any[]>('SELECT DATABASE() AS db');
  const dbName = dbRow?.db;
  if (!dbName) throw new Error('Could not resolve current database');

  const [columnRows] = await conn.query<any[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'lx_coop_sessions' AND COLUMN_NAME = 'space_id'`,
    [dbName],
  );
  if (columnRows.length === 0) {
    await conn.query('ALTER TABLE lx_coop_sessions ADD COLUMN space_id INT NULL AFTER creator_user_id');
    console.log('[COLLAB-MIGRATE] added lx_coop_sessions.space_id');
  } else {
    console.log('[COLLAB-MIGRATE] lx_coop_sessions.space_id already exists');
  }

  const [deletedAtRows] = await conn.query<any[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'lx_coop_sessions' AND COLUMN_NAME = 'deleted_at'`,
    [dbName],
  );
  if (deletedAtRows.length === 0) {
    await conn.query('ALTER TABLE lx_coop_sessions ADD COLUMN deleted_at TIMESTAMP NULL AFTER closed_at');
    console.log('[COLLAB-MIGRATE] added lx_coop_sessions.deleted_at');
  } else {
    console.log('[COLLAB-MIGRATE] lx_coop_sessions.deleted_at already exists');
  }

  const [indexRows] = await conn.query<any[]>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'lx_coop_sessions' AND INDEX_NAME = 'idx_lx_coop_sessions_space_id'`,
    [dbName],
  );
  if (indexRows.length === 0) {
    await conn.query('CREATE INDEX idx_lx_coop_sessions_space_id ON lx_coop_sessions(space_id)');
    console.log('[COLLAB-MIGRATE] created idx_lx_coop_sessions_space_id');
  } else {
    console.log('[COLLAB-MIGRATE] idx_lx_coop_sessions_space_id already exists');
  }

  const [deletedAtIndexRows] = await conn.query<any[]>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'lx_coop_sessions' AND INDEX_NAME = 'idx_lx_coop_sessions_deleted_at'`,
    [dbName],
  );
  if (deletedAtIndexRows.length === 0) {
    await conn.query('CREATE INDEX idx_lx_coop_sessions_deleted_at ON lx_coop_sessions(deleted_at)');
    console.log('[COLLAB-MIGRATE] created idx_lx_coop_sessions_deleted_at');
  } else {
    console.log('[COLLAB-MIGRATE] idx_lx_coop_sessions_deleted_at already exists');
  }

  for (const space of seedSpaces) {
    const [existing] = await conn.query<any[]>('SELECT id FROM lx_collab_spaces WHERE name = ? LIMIT 1', [space.name]);
    if (existing.length > 0) {
      console.log(`[COLLAB-MIGRATE] space already exists: ${space.name} (#${existing[0].id})`);
      continue;
    }
    await conn.query(
      `INSERT INTO lx_collab_spaces (name, description, status, sort_order) VALUES (?, ?, 'active', ?)`,
      [space.name, space.description, space.sortOrder],
    );
    console.log(`[COLLAB-MIGRATE] seeded space: ${space.name}`);
  }

  console.log('[COLLAB-MIGRATE] applied successfully');
} finally {
  await conn.end();
}

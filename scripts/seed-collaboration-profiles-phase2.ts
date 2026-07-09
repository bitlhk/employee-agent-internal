import mysql from 'mysql2/promise';
import 'dotenv/config';

const apply = process.argv.includes('--apply');
const databaseUrl = process.env.DATABASE_URL;

const seedProfiles = [
  { userId: 2, realName: '示例用户A', organizationName: '示例组织', departmentName: '示例部门', spaceId: 1, status: 'active' },
  { userId: 6, realName: '示例用户B', organizationName: '示例组织', departmentName: '示例部门', spaceId: 1, status: 'active' },
  { userId: 7, realName: '示例用户C', organizationName: '示例组织', departmentName: '示例部门', spaceId: 1, status: 'active' },
  { userId: 105, realName: '示例用户D', organizationName: '示例机构', departmentName: '试点组', spaceId: 3, status: 'active' },
] as const;

console.log(`[COLLAB-SEED] Phase 2 collaboration profile seed ${apply ? 'apply' : 'dry-run'}`);
for (const profile of seedProfiles) {
  console.log(`- user ${profile.userId}: ${profile.realName} -> space ${profile.spaceId}, status=${profile.status}`);
}

if (!apply) {
  console.log('[COLLAB-SEED] dry-run only. Re-run with --apply to execute.');
  process.exit(0);
}

if (!databaseUrl) throw new Error('DATABASE_URL is required for --apply');

const conn = await mysql.createConnection(databaseUrl);
try {
  for (const p of seedProfiles) {
    await conn.query(
      `INSERT INTO lx_collab_user_profiles
        (user_id, real_name, organization_name, department_name, space_id, status, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        real_name = VALUES(real_name),
        organization_name = VALUES(organization_name),
        department_name = VALUES(department_name),
        space_id = VALUES(space_id),
        status = VALUES(status),
        updated_by = VALUES(updated_by)`,
      [p.userId, p.realName, p.organizationName, p.departmentName, p.spaceId, p.status, 2],
    );
    console.log(`[COLLAB-SEED] upserted user ${p.userId}: ${p.realName}`);
  }
  console.log('[COLLAB-SEED] applied successfully');
} finally {
  await conn.end();
}

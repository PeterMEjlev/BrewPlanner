import type { UserRole } from '@checklist/shared';
import { runMigrations } from '../db/index.js';
import { deleteUser, listUsers, upsertUser } from './users.js';

/**
 * Manage login accounts:
 *   npm run user -- <username> <password> [role]  create a user (or change an
 *                                                 existing user's password); role
 *                                                 is admin|guest, default admin
 *   npm run user -- delete <username>             remove a user
 *   npm run user -- list                          list all users with their role
 */
const args = process.argv.slice(2);
const [cmd, ...rest] = args;

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npm run user -- <username> <password> [admin|guest]  create or change password\n' +
      '  npm run user -- delete <username>                    remove a user\n' +
      '  npm run user -- list                                 list users and roles',
  );
  process.exit(1);
}

runMigrations();

if (cmd === 'list') {
  const users = listUsers();
  console.log(users.length ? users.map((u) => `${u.username} (${u.role})`).join('\n') : '(no users)');
} else if (cmd === 'delete') {
  const [username] = rest;
  if (!username) usage();
  console.log(
    deleteUser(username) ? `Deleted user "${username}".` : `No user named "${username}".`,
  );
} else {
  const [username, password, roleArg] = args;
  if (!username || !password) usage();
  if (roleArg && roleArg !== 'admin' && roleArg !== 'guest') {
    console.error(`Invalid role "${roleArg}" — use "admin" or "guest".`);
    process.exit(1);
  }
  const role: UserRole = roleArg === 'guest' ? 'guest' : 'admin';
  const user = upsertUser(username, password, role);
  console.log(`Saved user "${user.username}" (id ${user.id}, ${user.role}).`);
}

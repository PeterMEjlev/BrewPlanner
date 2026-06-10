import { runMigrations } from '../db/index.js';
import { deleteUser, listUsernames, upsertUser } from './users.js';

/**
 * Manage login accounts:
 *   npm run user -- <username> <password>   create a user, or change an existing
 *                                           user's password
 *   npm run user -- delete <username>       remove a user
 *   npm run user -- list                    list all usernames
 */
const args = process.argv.slice(2);
const [cmd, ...rest] = args;

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npm run user -- <username> <password>   create or change password\n' +
      '  npm run user -- delete <username>       remove a user\n' +
      '  npm run user -- list                    list usernames',
  );
  process.exit(1);
}

runMigrations();

if (cmd === 'list') {
  const names = listUsernames();
  console.log(names.length ? names.join('\n') : '(no users)');
} else if (cmd === 'delete') {
  const [username] = rest;
  if (!username) usage();
  console.log(
    deleteUser(username) ? `Deleted user "${username}".` : `No user named "${username}".`,
  );
} else {
  const [username, password] = args;
  if (!username || !password) usage();
  const user = upsertUser(username, password);
  console.log(`Saved user "${user.username}" (id ${user.id}).`);
}

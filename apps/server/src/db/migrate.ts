import { databasePath, runMigrations } from './index.js';

// Standalone migration runner: `npm run db:migrate`.
runMigrations();
console.log(`Migrations applied to ${databasePath}`);

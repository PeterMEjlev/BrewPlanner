import { defineConfig } from 'drizzle-kit';
/**
 * drizzle-kit reads this to generate SQL migrations from the TS schema.
 * The runtime database path is configured separately in src/db/index.ts;
 * the value here is only used by `drizzle-kit` introspection commands.
 */
export default defineConfig({
    dialect: 'sqlite',
    schema: './src/db/schema.ts',
    out: './drizzle',
    dbCredentials: {
        url: process.env.DATABASE_PATH ?? './data/checklist.sqlite',
    },
});
//# sourceMappingURL=drizzle.config.js.map
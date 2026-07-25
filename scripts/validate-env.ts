// This script is meant to be run pre-build to ensure environment variables are present and valid
import { config } from 'dotenv';

config({ path: ['.env.local', '.env'] });

// `src/env.ts` runs createEnv() at module load, so it must not be a STATIC import
// here: TypeScript hoists static imports above the config() call above, which made
// validation run against an empty process.env and fail with "Invalid environment
// variables" listing every required key — even when .env was complete. The dynamic
// import below is evaluated when main() runs, i.e. after dotenv has populated
// process.env. Do not convert it back to a top-level import.
async function main() {
    const { env } = await import('../src/env');

    // Accessing `env` forces the validation to run
    if (!env.DATABASE_URL) {
        throw new Error('DATABASE_URL is missing!'); // This should never hit due to Zod validation
    }
    console.log('Environment variables validated successfully.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

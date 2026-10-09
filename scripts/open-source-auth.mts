import { localSupabaseEnvironment } from "./local-supabase.mts";

const environment = localSupabaseEnvironment();
process.env.DATABASE_URL = environment.DB_URL;
process.env.SUPABASE_URL = environment.API_URL;
process.env.SUPABASE_ANON_KEY = environment.PUBLISHABLE_KEY;
process.env.PORT ??= "5175";

console.log(`Auth page: http://127.0.0.1:${process.env.PORT}/auth`);
if (environment.INBUCKET_URL) {
  console.log(`Local email inbox: ${environment.INBUCKET_URL}`);
}
await import("../projects/supabase/app/server.mts");

import { config } from "dotenv"
// Carga .env.local para tests que tocan Supabase/Postgres real.
config({ path: ".env.local" })

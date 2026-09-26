import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  API_PORT: z.coerce.number().int().positive().default(8080),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z.string().default(""),
  FOMOSCAN_API_KEY: z.string().optional(),
  FOMOSCAN_API_BASE: z.string().url().default("https://api.fomoscan.sh"),
  TRITON_GRPC_ENDPOINT: z.string().min(1),
  TRITON_GRPC_XTOKEN: z.string().optional(),
  SOLANA_RPC_URL: z.string().url(),
  JUPITER_API_BASE: z.string().url().default("https://api.jup.ag/swap/v1"),
  JUPITER_API_KEY: z.string().optional(),
  BOOTSTRAP_USERS_JSON: z.string().default("[]")
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const env = envSchema.parse(process.env);
  const allowedTelegramUserIds = new Set(
    env.ALLOWED_TELEGRAM_USER_IDS.split(",").map((v) => v.trim()).filter(Boolean),
  );

  const bootstrapUsers = z.array(z.object({
    telegramUserId: z.string().min(1),
    label: z.string().min(1),
    signerRef: z.string().regex(/^[A-Z0-9_]+$/),
    solanaAddress: z.string().min(32),
  })).parse(JSON.parse(env.BOOTSTRAP_USERS_JSON));

  return { ...env, allowedTelegramUserIds, bootstrapUsers };
}

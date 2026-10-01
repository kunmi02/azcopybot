import { z } from "zod";

const boolEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
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
  TOKEN_2022_FALLBACK_ENABLED: boolEnv.default(false),
  OKX_API_BASE: z.string().url().default("https://www.okx.com"),
  OKX_API_KEY: z.string().optional(),
  OKX_API_SECRET: z.string().optional(),
  OKX_API_PASSPHRASE: z.string().optional(),
  OKX_PROJECT_ID: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_API_BASE: z.string().url().default("https://api.helius.xyz/v0"),
  SOURCING_AUTO_DISCOVERY_ENABLED: boolEnv.default(true),
  SOURCING_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  SOURCING_SCAN_MAX_TOKENS: z.coerce.number().int().positive().default(3),
  SOURCING_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(10_000),
  SOURCING_MIN_VOLUME_H1_USD: z.coerce.number().nonnegative().default(5_000),
  SOURCING_MIN_TXNS_H1: z.coerce.number().int().nonnegative().default(25),
  SOURCING_MIN_AGE_MINUTES: z.coerce.number().int().nonnegative().default(5),
  SOURCING_MAX_AGE_HOURS: z.coerce.number().int().positive().default(48),
  SOURCING_MIN_PEAK_MULTIPLE: z.coerce.number().positive().default(2),
  BOOTSTRAP_USERS_JSON: z.string().default("[]"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const env = envSchema.parse(process.env);
  const allowedTelegramUserIds = new Set(
    env.ALLOWED_TELEGRAM_USER_IDS.split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );

  const bootstrapUsers = z
    .array(
      z.object({
        telegramUserId: z.string().min(1),
        label: z.string().min(1),
        signerRef: z.string().regex(/^[A-Z0-9_]+$/),
        solanaAddress: z.string().min(32),
      }),
    )
    .parse(JSON.parse(env.BOOTSTRAP_USERS_JSON));

  return { ...env, allowedTelegramUserIds, bootstrapUsers };
}

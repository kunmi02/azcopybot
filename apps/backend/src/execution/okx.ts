/**
 * Deliberately not wired into live execution yet.
 * The supplied production spec requires OKX as a fallback for Token-2022 routes,
 * but also says not to skip ahead to execution. Until this adapter is tested
 * against the account's current OKX API contract, the executor safely refuses
 * non-zero transfer-fee tokens instead of risking a dust-pool route.
 */
export class OkxRouter {
  isConfigured() {
    return Boolean(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE && process.env.OKX_PROJECT_ID);
  }
}

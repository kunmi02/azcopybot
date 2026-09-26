import type { FomoIdentity } from "../types.js";

/** A discovery source resolves a platform identity into blockchain identities. */
export interface IdentitySource<TInput = string, TIdentity = FomoIdentity> {
  resolve(input: TInput): Promise<TIdentity>;
}

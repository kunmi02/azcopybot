import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type {
  CopyConfig,
  EntryKind,
  FomoIdentity,
  TradeEvent,
} from "./types.js";

const { Pool } = pg;

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async close() {
    await this.pool.end();
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        telegram_user_id TEXT NOT NULL UNIQUE,
        telegram_chat_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        paused BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS login_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS traders (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT,
        handle TEXT,
        display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(source, external_id)
      );

      CREATE TABLE IF NOT EXISTS trader_wallets (
        id TEXT PRIMARY KEY,
        trader_id TEXT NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
        chain_family TEXT NOT NULL,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        provider TEXT NOT NULL,
        verified_at TIMESTAMPTZ,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(trader_id, chain, address)
      );

      CREATE INDEX IF NOT EXISTS trader_wallets_address_idx ON trader_wallets(address);

      CREATE TABLE IF NOT EXISTS copy_wallets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chain TEXT NOT NULL,
        public_address TEXT NOT NULL,
        signer_ref TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, chain)
      );

      CREATE TABLE IF NOT EXISTS copy_configs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trader_id TEXT NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
        trading_wallet_id TEXT REFERENCES copy_wallets(id) ON DELETE SET NULL,
        trade_amount_usd DOUBLE PRECISION NOT NULL DEFAULT 10,
        slippage_bps INTEGER NOT NULL DEFAULT 300,
        copy_new_entries BOOLEAN NOT NULL DEFAULT true,
        copy_topups BOOLEAN NOT NULL DEFAULT false,
        mirror_exits BOOLEAN NOT NULL DEFAULT true,
        take_profit_pct DOUBLE PRECISION DEFAULT 30,
        stop_loss_pct DOUBLE PRECISION DEFAULT 15,
        max_hold_seconds INTEGER DEFAULT 14400,
        dry_run BOOLEAN NOT NULL DEFAULT true,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, trader_id)
      );

      CREATE TABLE IF NOT EXISTS seen_trades (
        key TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS leader_positions (
        trader_id TEXT NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        is_open BOOLEAN NOT NULL DEFAULT true,
        first_seen_tx TEXT,
        last_seen_tx TEXT,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ,
        PRIMARY KEY (trader_id, chain, token)
      );

      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trader_id TEXT NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
        copy_config_id TEXT NOT NULL REFERENCES copy_configs(id) ON DELETE CASCADE,
        copy_wallet_id TEXT REFERENCES copy_wallets(id) ON DELETE SET NULL,
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        qty NUMERIC NOT NULL,
        cost_usd DOUBLE PRECISION NOT NULL,
        avg_entry_price DOUBLE PRECISION NOT NULL,
        highest_price DOUBLE PRECISION NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closing','closed','failed')),
        opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS positions_one_open_idx
        ON positions(user_id,trader_id,chain,token) WHERE status='open';
      CREATE INDEX IF NOT EXISTS positions_open_idx ON positions(status, chain, token);

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position_id TEXT REFERENCES positions(id) ON DELETE SET NULL,
        trader_id TEXT REFERENCES traders(id) ON DELETE SET NULL,
        source_tx_hash TEXT,
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy','sell')),
        reason TEXT NOT NULL,
        requested_usd DOUBLE PRECISION,
        actual_usd DOUBLE PRECISION,
        token_qty NUMERIC,
        execution_price DOUBLE PRECISION,
        tx_hash TEXT,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        confirmed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        trader_id TEXT REFERENCES traders(id) ON DELETE SET NULL,
        position_id TEXT REFERENCES positions(id) ON DELETE SET NULL,
        execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS activity_events_user_created_idx ON activity_events(user_id, created_at DESC);
    `);
    await this.pool.query(
      `ALTER TABLE copy_configs ALTER COLUMN mirror_exits SET DEFAULT true`,
    );
  }

  async upsertTelegramUser(input: {
    telegramUserId: string;
    chatId: string;
    displayName: string;
  }) {
    const existing = await this.pool.query(
      `SELECT id FROM users WHERE telegram_user_id=$1`,
      [input.telegramUserId],
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await this.pool.query(
      `
      INSERT INTO users(id, telegram_user_id, telegram_chat_id, display_name)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(telegram_user_id) DO UPDATE
      SET telegram_chat_id=EXCLUDED.telegram_chat_id, display_name=EXCLUDED.display_name
    `,
      [id, input.telegramUserId, input.chatId, input.displayName],
    );
    return this.getUserByTelegramId(input.telegramUserId);
  }

  async getUserByTelegramId(telegramUserId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM users WHERE telegram_user_id=$1`,
      [telegramUserId],
    );
    return rows[0] ?? null;
  }

  async getUserById(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE id=$1`, [
      id,
    ]);
    return rows[0] ?? null;
  }

  async setUserPaused(userId: string, paused: boolean) {
    await this.pool.query(`UPDATE users SET paused=$2 WHERE id=$1`, [
      userId,
      paused,
    ]);
  }

  async isUserPaused(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT paused FROM users WHERE id=$1`,
      [userId],
    );
    return Boolean(rows[0]?.paused);
  }

  static hashSecret(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  async createLoginCode(userId: string, code: string, expiresAt: Date) {
    const hash = Database.hashSecret(code);
    await this.pool.query(
      `DELETE FROM login_codes WHERE user_id=$1 OR expires_at < now()`,
      [userId],
    );
    const { rowCount } = await this.pool.query(
      `INSERT INTO login_codes(code_hash,user_id,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [hash, userId, expiresAt],
    );
    return rowCount === 1;
  }

  async consumeLoginCode(code: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const hash = Database.hashSecret(code);
      const { rows } = await client.query(
        `
        SELECT * FROM login_codes
        WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()
        FOR UPDATE
      `,
        [hash],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE login_codes SET used_at=now() WHERE code_hash=$1`,
        [hash],
      );
      await client.query("COMMIT");
      return rows[0].user_id as string;
    } finally {
      client.release();
    }
  }

  async createWebSession(userId: string, token: string, expiresAt: Date) {
    await this.pool.query(
      `
      INSERT INTO web_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)
    `,
      [Database.hashSecret(token), userId, expiresAt],
    );
  }

  async getSessionUser(token: string) {
    const { rows } = await this.pool.query(
      `
      SELECT u.* FROM web_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > now()
    `,
      [Database.hashSecret(token)],
    );
    return rows[0] ?? null;
  }

  async deleteSession(token: string) {
    await this.pool.query(`DELETE FROM web_sessions WHERE token_hash=$1`, [
      Database.hashSecret(token),
    ]);
  }

  async upsertFomoTrader(identity: FomoIdentity) {
    const existing = await this.pool.query(
      `SELECT id FROM traders WHERE source='fomo' AND external_id=$1`,
      [identity.id],
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await this.pool.query(
      `
      INSERT INTO traders(id,source,external_id,handle,display_name)
      VALUES($1,'fomo',$2,$3,$4)
      ON CONFLICT(source,external_id) DO UPDATE
      SET handle=EXCLUDED.handle, display_name=EXCLUDED.display_name
    `,
      [id, identity.id, identity.handle, identity.name || identity.handle],
    );

    if (identity.solanaAddress) {
      await this.upsertTraderWallet(
        id,
        "solana",
        "solana",
        identity.solanaAddress,
        "fomoscan",
      );
    }
    if (identity.evmAddress) {
      await this.upsertTraderWallet(
        id,
        "evm",
        "evm",
        identity.evmAddress.toLowerCase(),
        "fomoscan",
      );
    }
    return this.getTrader(id);
  }

  async upsertManualTrader(input: {
    label: string;
    chain: string;
    address: string;
  }) {
    const normalized =
      input.chain === "solana" ? input.address : input.address.toLowerCase();
    const externalId = `${input.chain}:${normalized}`;
    const existing = await this.pool.query(
      `SELECT id FROM traders WHERE source='wallet' AND external_id=$1`,
      [externalId],
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await this.pool.query(
      `
      INSERT INTO traders(id,source,external_id,display_name)
      VALUES($1,'wallet',$2,$3)
      ON CONFLICT(source,external_id) DO UPDATE SET display_name=EXCLUDED.display_name
    `,
      [id, externalId, input.label],
    );
    await this.upsertTraderWallet(
      id,
      input.chain === "solana" ? "solana" : "evm",
      input.chain,
      normalized,
      "manual",
    );
    return this.getTrader(id);
  }

  private async upsertTraderWallet(
    traderId: string,
    family: string,
    chain: string,
    address: string,
    provider: string,
  ) {
    const existing = await this.pool.query(
      `SELECT id FROM trader_wallets WHERE trader_id=$1 AND chain=$2 AND address=$3`,
      [traderId, chain, address],
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await this.pool.query(
      `
      INSERT INTO trader_wallets(id,trader_id,chain_family,chain,address,provider,verified_at)
      VALUES($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT(trader_id,chain,address) DO UPDATE
      SET enabled=true, provider=EXCLUDED.provider, verified_at=EXCLUDED.verified_at
    `,
      [id, traderId, family, chain, address, provider],
    );
  }

  async getFomoTraderByHandle(handle: string) {
    const clean = handle.replace(/^@/, "").toLowerCase();
    const { rows } = await this.pool.query(
      `
      SELECT t.*,
        MAX(CASE WHEN w.chain='solana' THEN w.address END) AS solana_address,
        MAX(CASE WHEN w.chain='evm' THEN w.address END) AS evm_address
      FROM traders t LEFT JOIN trader_wallets w ON w.trader_id=t.id AND w.enabled=true
      WHERE t.source='fomo' AND lower(t.handle)=$1
      GROUP BY t.id LIMIT 1
    `,
      [clean],
    );
    return rows[0] ?? null;
  }

  async getTrader(id: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM traders WHERE id=$1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async getTraderByWallet(address: string, chain = "solana") {
    const normalized = chain === "solana" ? address : address.toLowerCase();
    const { rows } = await this.pool.query(
      `
      SELECT t.* FROM traders t
      JOIN trader_wallets w ON w.trader_id=t.id
      WHERE w.address=$1 AND w.chain=$2 AND w.enabled=true
      LIMIT 1
    `,
      [normalized, chain],
    );
    return rows[0] ?? null;
  }

  async followTrader(userId: string, traderId: string) {
    const wallet = await this.getCopyWallet(userId, "solana");
    const existing = await this.pool.query(
      `SELECT id FROM copy_configs WHERE user_id=$1 AND trader_id=$2`,
      [userId, traderId],
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await this.pool.query(
      `
      INSERT INTO copy_configs(id,user_id,trader_id,trading_wallet_id,mirror_exits)
      VALUES($1,$2,$3,$4,true)
      ON CONFLICT(user_id,trader_id) DO UPDATE SET enabled=true
    `,
      [id, userId, traderId, wallet?.id ?? null],
    );
    return this.getCopyConfig(id);
  }

  async getCopyConfig(id: string): Promise<CopyConfig | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM copy_configs WHERE id=$1`,
      [id],
    );
    return rows[0] ? mapCopyConfig(rows[0]) : null;
  }

  async getCopyConfigForUserTrader(
    userId: string,
    traderId: string,
  ): Promise<CopyConfig | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM copy_configs WHERE user_id=$1 AND trader_id=$2`,
      [userId, traderId],
    );
    return rows[0] ? mapCopyConfig(rows[0]) : null;
  }

  async updateCopyConfig(
    userId: string,
    id: string,
    patch: Partial<{
      tradeAmountUsd: number;
      slippageBps: number;
      copyNewEntries: boolean;
      copyTopups: boolean;
      mirrorExits: boolean;
      takeProfitPct: number | null;
      stopLossPct: number | null;
      maxHoldSeconds: number | null;
      enabled: boolean;
      dryRun: boolean;
    }>,
  ) {
    const allowed: Record<string, string> = {
      tradeAmountUsd: "trade_amount_usd",
      slippageBps: "slippage_bps",
      copyNewEntries: "copy_new_entries",
      copyTopups: "copy_topups",
      mirrorExits: "mirror_exits",
      takeProfitPct: "take_profit_pct",
      stopLossPct: "stop_loss_pct",
      maxHoldSeconds: "max_hold_seconds",
      enabled: "enabled",
      dryRun: "dry_run",
    };
    const entries = Object.entries(patch).filter(([k]) => k in allowed);
    if (!entries.length) return this.getCopyConfig(id);
    const sets = entries.map(([k], i) => `${allowed[k]}=$${i + 3}`);
    await this.pool.query(
      `UPDATE copy_configs SET ${sets.join(",")} WHERE id=$1 AND user_id=$2`,
      [id, userId, ...entries.map(([, v]) => v)],
    );
    return this.getCopyConfig(id);
  }

  async setAllCopyConfigsMode(userId: string, dryRun: boolean) {
    const { rows } = await this.pool.query(
      `
      UPDATE copy_configs
      SET dry_run=$2
      WHERE user_id=$1 AND enabled=true
      RETURNING id
    `,
      [userId, dryRun],
    );
    return rows.length;
  }

  async unfollowCopyConfig(userId: string, id: string) {
    const { rows } = await this.pool.query(
      `
      UPDATE copy_configs c
      SET enabled=false, dry_run=true
      FROM traders t
      WHERE c.id=$1 AND c.user_id=$2 AND t.id=c.trader_id
      RETURNING c.id, c.trader_id, t.handle, t.display_name
    `,
      [id, userId],
    );
    return rows[0] ?? null;
  }

  async listUserTraders(userId: string) {
    const { rows } = await this.pool.query(
      `
      SELECT c.id AS config_id, c.*, t.handle, t.display_name, t.source,
        COALESCE(json_agg(json_build_object('chain',w.chain,'address',w.address)) FILTER (WHERE w.id IS NOT NULL),'[]') wallets
      FROM copy_configs c JOIN traders t ON t.id=c.trader_id
      LEFT JOIN trader_wallets w ON w.trader_id=t.id AND w.enabled=true
      WHERE c.user_id=$1 AND c.enabled=true
      GROUP BY c.id,t.id
      ORDER BY t.display_name
    `,
      [userId],
    );
    return rows;
  }

  async listInactiveUserTraders(userId: string) {
    const { rows } = await this.pool.query(
      `
      SELECT c.id AS config_id, c.*, t.handle, t.display_name, t.source,
        COALESCE(json_agg(json_build_object('chain',w.chain,'address',w.address)) FILTER (WHERE w.id IS NOT NULL),'[]') wallets
      FROM copy_configs c JOIN traders t ON t.id=c.trader_id
      LEFT JOIN trader_wallets w ON w.trader_id=t.id AND w.enabled=true
      WHERE c.user_id=$1 AND c.enabled=false
      GROUP BY c.id,t.id
      ORDER BY t.display_name
    `,
      [userId],
    );
    return rows;
  }

  async listSolanaWatchedAddresses() {
    const { rows } = await this.pool.query(`
      SELECT DISTINCT w.address FROM trader_wallets w
      JOIN copy_configs c ON c.trader_id=w.trader_id
      WHERE w.chain='solana' AND w.enabled=true AND c.enabled=true
    `);
    return rows.map((r) => r.address as string);
  }

  async configsForWallet(
    address: string,
  ): Promise<
    Array<
      CopyConfig & {
        chatId: string;
        traderHandle: string | null;
        traderName: string;
        traderId: string;
      }
    >
  > {
    const { rows } = await this.pool.query(
      `
      SELECT c.*, u.telegram_chat_id, t.handle, t.display_name
      FROM trader_wallets w
      JOIN traders t ON t.id=w.trader_id
      JOIN copy_configs c ON c.trader_id=t.id
      JOIN users u ON u.id=c.user_id
      WHERE w.address=$1 AND w.chain='solana' AND c.enabled=true AND w.enabled=true
    `,
      [address],
    );
    return rows.map((r) => ({
      ...mapCopyConfig(r),
      chatId: r.telegram_chat_id,
      traderHandle: r.handle,
      traderName: r.display_name,
      traderId: r.trader_id,
    }));
  }

  async insertSeenTrade(event: TradeEvent, key: string) {
    const { rowCount } = await this.pool.query(
      `
      INSERT INTO seen_trades(key) VALUES($1)
      ON CONFLICT DO NOTHING
    `,
      [key],
    );
    return rowCount === 1;
  }

  async classifyLeaderEntry(
    traderId: string,
    event: TradeEvent,
    observedKind?: EntryKind,
  ): Promise<EntryKind> {
    const { rows } = await this.pool.query(
      `
      SELECT is_open FROM leader_positions WHERE trader_id=$1 AND chain=$2 AND token=$3
    `,
      [traderId, event.chain, event.token],
    );
    // The transaction's pre-balance is the strongest signal. DB state is only a fallback.
    const kind: EntryKind =
      observedKind ?? (rows[0]?.is_open ? "top_up" : "new_entry");
    await this.pool.query(
      `
      INSERT INTO leader_positions(trader_id,chain,token,is_open,first_seen_tx,last_seen_tx,opened_at,closed_at)
      VALUES($1,$2,$3,true,$4,$4,now(),NULL)
      ON CONFLICT(trader_id,chain,token) DO UPDATE
      SET is_open=true,last_seen_tx=EXCLUDED.last_seen_tx,
          first_seen_tx=CASE WHEN leader_positions.is_open THEN leader_positions.first_seen_tx ELSE EXCLUDED.first_seen_tx END,
          opened_at=CASE WHEN leader_positions.is_open THEN leader_positions.opened_at ELSE now() END,
          closed_at=NULL
    `,
      [traderId, event.chain, event.token, event.txHash],
    );
    return kind;
  }

  async closeLeaderPosition(traderId: string, event: TradeEvent) {
    await this.pool.query(
      `
      UPDATE leader_positions SET is_open=false,last_seen_tx=$4,closed_at=now()
      WHERE trader_id=$1 AND chain=$2 AND token=$3
    `,
      [traderId, event.chain, event.token, event.txHash],
    );
  }

  async listOpenLeaderTokens(traderId: string, chain: string) {
    const { rows } = await this.pool.query(
      `
      SELECT token FROM leader_positions WHERE trader_id=$1 AND chain=$2 AND is_open=true
    `,
      [traderId, chain],
    );
    return rows.map((r) => r.token as string);
  }

  async listOpenPositionsForTrader(
    userId: string,
    traderId: string,
    chain: string,
    token?: string,
  ) {
    const params: unknown[] = [userId, traderId, chain];
    let tokenSql = "";
    if (token) {
      params.push(token);
      tokenSql = ` AND p.token=$4`;
    }
    const { rows } = await this.pool.query(
      `
      SELECT p.*, c.take_profit_pct,c.stop_loss_pct,c.max_hold_seconds,c.dry_run,c.slippage_bps,
             cw.public_address AS copy_wallet_address,cw.signer_ref,t.handle,t.display_name,u.telegram_chat_id
      FROM positions p JOIN copy_configs c ON c.id=p.copy_config_id
      JOIN traders t ON t.id=p.trader_id JOIN users u ON u.id=p.user_id
      LEFT JOIN copy_wallets cw ON cw.id=p.copy_wallet_id
      WHERE p.user_id=$1 AND p.trader_id=$2 AND p.chain=$3 AND p.status='open'${tokenSql}
    `,
      params,
    );
    return rows;
  }

  async getCopyWallet(userId: string, chain: string) {
    const { rows } = await this.pool.query(
      `
      SELECT * FROM copy_wallets WHERE user_id=$1 AND chain=$2 AND enabled=true
    `,
      [userId, chain],
    );
    return rows[0] ?? null;
  }

  async upsertCopyWallet(
    userId: string,
    chain: string,
    publicAddress: string,
    signerRef: string,
  ) {
    const existing = await this.pool.query(
      `SELECT id FROM copy_wallets WHERE user_id=$1 AND chain=$2`,
      [userId, chain],
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await this.pool.query(
      `
      INSERT INTO copy_wallets(id,user_id,chain,public_address,signer_ref)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id,chain) DO UPDATE SET public_address=EXCLUDED.public_address, signer_ref=EXCLUDED.signer_ref, enabled=true
    `,
      [id, userId, chain, publicAddress, signerRef],
    );
    await this.pool.query(
      `UPDATE copy_configs SET trading_wallet_id=$1 WHERE user_id=$2 AND trading_wallet_id IS NULL`,
      [id, userId],
    );
    return this.getCopyWallet(userId, chain);
  }

  async createPosition(input: {
    userId: string;
    traderId: string;
    configId: string;
    copyWalletId: string | null;
    chain: string;
    token: string;
    qty: number;
    costUsd: number;
    entryPrice: number;
    mode: "paper" | "live";
  }) {
    const existing = await this.pool.query(
      `
      SELECT * FROM positions WHERE user_id=$1 AND trader_id=$2 AND chain=$3 AND token=$4 AND status='open'
    `,
      [input.userId, input.traderId, input.chain, input.token],
    );
    if (existing.rows[0]) {
      const current = existing.rows[0];
      const oldQty = Number(current.qty);
      const oldCost = Number(current.cost_usd);
      const newQty = oldQty + input.qty;
      const newCost = oldCost + input.costUsd;
      const newAvg = newQty > 0 ? newCost / newQty : input.entryPrice;
      const { rows } = await this.pool.query(
        `
        UPDATE positions SET qty=$2,cost_usd=$3,avg_entry_price=$4,highest_price=GREATEST(highest_price,$5)
        WHERE id=$1 RETURNING *
      `,
        [current.id, newQty, newCost, newAvg, input.entryPrice],
      );
      return rows[0];
    }
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO positions(id,user_id,trader_id,copy_config_id,copy_wallet_id,chain,token,qty,cost_usd,avg_entry_price,highest_price,mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)
    `,
      [
        id,
        input.userId,
        input.traderId,
        input.configId,
        input.copyWalletId,
        input.chain,
        input.token,
        input.qty,
        input.costUsd,
        input.entryPrice,
        input.mode,
      ],
    );
    return (await this.pool.query(`SELECT * FROM positions WHERE id=$1`, [id]))
      .rows[0];
  }

  async listOpenPositions(userId?: string) {
    const params: unknown[] = [];
    let where = `p.status='open'`;
    if (userId) {
      params.push(userId);
      where += ` AND p.user_id=$1`;
    }
    const { rows } = await this.pool.query(
      `
      SELECT p.*, t.handle, t.display_name, c.take_profit_pct,c.stop_loss_pct,c.max_hold_seconds,c.dry_run,c.slippage_bps,
             u.telegram_chat_id, cw.public_address AS copy_wallet_address, cw.signer_ref
      FROM positions p JOIN traders t ON t.id=p.trader_id
      JOIN copy_configs c ON c.id=p.copy_config_id
      JOIN users u ON u.id=p.user_id
      LEFT JOIN copy_wallets cw ON cw.id=p.copy_wallet_id
      WHERE ${where}
      ORDER BY p.opened_at DESC
    `,
      params,
    );
    return rows;
  }

  async getPositionForUser(userId: string, positionId: string) {
    const { rows } = await this.pool.query(
      `
      SELECT p.*, c.take_profit_pct,c.stop_loss_pct,c.max_hold_seconds,c.dry_run,c.slippage_bps,
             cw.public_address AS copy_wallet_address,cw.signer_ref,t.handle,t.display_name,u.telegram_chat_id
      FROM positions p JOIN copy_configs c ON c.id=p.copy_config_id
      JOIN traders t ON t.id=p.trader_id JOIN users u ON u.id=p.user_id
      LEFT JOIN copy_wallets cw ON cw.id=p.copy_wallet_id
      WHERE p.id=$1 AND p.user_id=$2
    `,
      [positionId, userId],
    );
    return rows[0] ?? null;
  }

  async updatePositionHigh(positionId: string, price: number) {
    await this.pool.query(
      `UPDATE positions SET highest_price=GREATEST(highest_price,$2) WHERE id=$1`,
      [positionId, price],
    );
  }

  async setPositionStatus(
    positionId: string,
    status: "open" | "closing" | "closed" | "failed",
  ) {
    await this.pool.query(
      `UPDATE positions SET status=$2,closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END WHERE id=$1`,
      [positionId, status],
    );
  }

  async closePosition(positionId: string) {
    await this.pool.query(
      `UPDATE positions SET status='closed',closed_at=now() WHERE id=$1`,
      [positionId],
    );
  }

  async convertPaperPositionToLive(
    positionId: string,
    copyWalletId: string | null,
    qty: number,
    costUsd: number,
    entryPrice: number,
  ) {
    const { rows } = await this.pool.query(
      `
      UPDATE positions
      SET copy_wallet_id=$2, qty=$3, cost_usd=$4, avg_entry_price=$5, highest_price=$5,
          mode='live', opened_at=now()
      WHERE id=$1 AND mode='paper' AND status='open'
      RETURNING *
    `,
      [positionId, copyWalletId, qty, costUsd, entryPrice],
    );
    return rows[0] ?? null;
  }

  async createExecution(input: {
    userId: string;
    positionId?: string | null;
    traderId?: string | null;
    sourceTxHash?: string | null;
    chain: string;
    token: string;
    side: "buy" | "sell";
    reason: string;
    requestedUsd?: number | null;
    actualUsd?: number | null;
    tokenQty?: number | null;
    executionPrice?: number | null;
    txHash?: string | null;
    status: string;
  }) {
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO executions(id,user_id,position_id,trader_id,source_tx_hash,chain,token,side,reason,requested_usd,actual_usd,token_qty,execution_price,tx_hash,status,confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $15 IN ('confirmed','paper') THEN now() ELSE NULL END)
    `,
      [
        id,
        input.userId,
        input.positionId ?? null,
        input.traderId ?? null,
        input.sourceTxHash ?? null,
        input.chain,
        input.token,
        input.side,
        input.reason,
        input.requestedUsd ?? null,
        input.actualUsd ?? null,
        input.tokenQty ?? null,
        input.executionPrice ?? null,
        input.txHash ?? null,
        input.status,
      ],
    );
    return id;
  }

  async createActivityEvent(input: {
    userId?: string | null;
    traderId?: string | null;
    positionId?: string | null;
    executionId?: string | null;
    type: string;
    severity: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO activity_events(id,user_id,trader_id,position_id,execution_id,type,severity,message,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      RETURNING *
    `,
      [
        id,
        input.userId ?? null,
        input.traderId ?? null,
        input.positionId ?? null,
        input.executionId ?? null,
        input.type,
        input.severity,
        input.message,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0];
  }

  async listUnknownExecutions(limit = 50) {
    const { rows } = await this.pool.query(
      `
      SELECT e.*, cw.id AS copy_wallet_id,cw.public_address,cw.signer_ref
      FROM executions e
      LEFT JOIN copy_wallets cw ON cw.user_id=e.user_id AND cw.chain=e.chain AND cw.enabled=true
      WHERE e.status='submitted_unknown' AND e.tx_hash IS NOT NULL
      ORDER BY e.created_at ASC LIMIT $1
    `,
      [limit],
    );
    return rows;
  }

  async resolveExecution(
    id: string,
    patch: {
      status: string;
      actualUsd?: number | null;
      tokenQty?: number | null;
      executionPrice?: number | null;
      positionId?: string | null;
    },
  ) {
    await this.pool.query(
      `
      UPDATE executions SET status=$2,actual_usd=COALESCE($3,actual_usd),token_qty=COALESCE($4,token_qty),
        execution_price=COALESCE($5,execution_price),position_id=COALESCE($6,position_id),
        confirmed_at=CASE WHEN $2='confirmed' THEN now() ELSE confirmed_at END
      WHERE id=$1
    `,
      [
        id,
        patch.status,
        patch.actualUsd ?? null,
        patch.tokenQty ?? null,
        patch.executionPrice ?? null,
        patch.positionId ?? null,
      ],
    );
  }

  async getExecutionForUser(userId: string, id: string) {
    const { rows } = await this.pool.query(
      `
      SELECT e.*, t.handle,t.display_name,u.telegram_chat_id FROM executions e
      JOIN users u ON u.id=e.user_id
      LEFT JOIN traders t ON t.id=e.trader_id
      WHERE e.user_id=$1 AND e.id=$2
    `,
      [userId, id],
    );
    return rows[0] ?? null;
  }

  async listExecutions(userId: string, limit = 100) {
    const { rows } = await this.pool.query(
      `
      SELECT e.*, t.handle,t.display_name FROM executions e
      LEFT JOIN traders t ON t.id=e.trader_id
      WHERE e.user_id=$1 ORDER BY e.created_at DESC LIMIT $2
    `,
      [userId, limit],
    );
    return rows;
  }

  async listActivityEvents(userId: string, limit = 100) {
    const { rows } = await this.pool.query(
      `
      SELECT a.*, t.handle,t.display_name FROM activity_events a
      LEFT JOIN traders t ON t.id=a.trader_id
      WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT $2
    `,
      [userId, limit],
    );
    return rows;
  }

  async dashboard(userId: string) {
    const [
      positions,
      traders,
      inactiveTraders,
      executions,
      activity,
      user,
      wallet,
    ] = await Promise.all([
      this.listOpenPositions(userId),
      this.listUserTraders(userId),
      this.listInactiveUserTraders(userId),
      this.listExecutions(userId, 20),
      this.listActivityEvents(userId, 50),
      this.getUserById(userId),
      this.getCopyWallet(userId, "solana"),
    ]);
    return {
      user,
      wallet,
      positions,
      traders,
      inactiveTraders,
      executions,
      activity,
    };
  }
}

function mapCopyConfig(r: any): CopyConfig {
  return {
    id: r.id,
    userId: r.user_id,
    traderId: r.trader_id,
    tradingWalletId: r.trading_wallet_id,
    tradeAmountUsd: Number(r.trade_amount_usd),
    slippageBps: Number(r.slippage_bps),
    copyNewEntries: r.copy_new_entries,
    copyTopups: r.copy_topups,
    mirrorExits: r.mirror_exits,
    takeProfitPct: r.take_profit_pct == null ? null : Number(r.take_profit_pct),
    stopLossPct: r.stop_loss_pct == null ? null : Number(r.stop_loss_pct),
    maxHoldSeconds:
      r.max_hold_seconds == null ? null : Number(r.max_hold_seconds),
    dryRun: r.dry_run,
    enabled: r.enabled,
  };
}

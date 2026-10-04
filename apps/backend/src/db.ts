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

  async getBooleanSystemSetting(key: string, fallback: boolean) {
    const { rows } = await this.pool.query(
      `SELECT value FROM system_settings WHERE key=$1`,
      [key],
    );
    const value = rows[0]?.value;
    return typeof value === "boolean" ? value : fallback;
  }

  async setBooleanSystemSetting(key: string, value: boolean) {
    await this.pool.query(
      `
      INSERT INTO system_settings(key,value,updated_at)
      VALUES($1,$2::jsonb,now())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
    `,
      [key, JSON.stringify(value)],
    );
    return value;
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

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
        trade_amount_usd DOUBLE PRECISION NOT NULL DEFAULT 1,
        slippage_bps INTEGER NOT NULL DEFAULT 300,
        copy_new_entries BOOLEAN NOT NULL DEFAULT true,
        copy_topups BOOLEAN NOT NULL DEFAULT false,
        mirror_exits BOOLEAN NOT NULL DEFAULT true,
        take_profit_pct DOUBLE PRECISION DEFAULT 30,
        stop_loss_pct DOUBLE PRECISION DEFAULT 15,
        max_hold_seconds INTEGER DEFAULT 14400,
        custom_label TEXT,
        dry_run BOOLEAN NOT NULL DEFAULT true,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, trader_id)
      );

      CREATE TABLE IF NOT EXISTS auto_trading_configs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled_live BOOLEAN NOT NULL DEFAULT false,
        trade_amount_usd DOUBLE PRECISION NOT NULL DEFAULT 1,
        max_open_positions INTEGER NOT NULL DEFAULT 1,
        max_daily_buys INTEGER NOT NULL DEFAULT 3,
        daily_loss_limit_usd DOUBLE PRECISION NOT NULL DEFAULT 5,
        max_token_risk_score INTEGER NOT NULL DEFAULT 30,
        min_liquidity_usd DOUBLE PRECISION NOT NULL DEFAULT 10000,
        min_market_cap_usd DOUBLE PRECISION NOT NULL DEFAULT 7000,
        max_market_cap_usd DOUBLE PRECISION NOT NULL DEFAULT 40000,
        take_profit_pct DOUBLE PRECISION DEFAULT 50,
        stop_loss_pct DOUBLE PRECISION DEFAULT 15,
        max_hold_seconds INTEGER DEFAULT 14400,
        min_hold_seconds INTEGER DEFAULT 0,
        tp1_pct DOUBLE PRECISION DEFAULT 100,
        tp1_sell_pct DOUBLE PRECISION DEFAULT 50,
        tp2_pct DOUBLE PRECISION DEFAULT 200,
        tp2_sell_pct DOUBLE PRECISION DEFAULT 25,
        tp3_pct DOUBLE PRECISION DEFAULT 400,
        tp3_sell_pct DOUBLE PRECISION DEFAULT 25,
        runner_pct DOUBLE PRECISION DEFAULT 0,
        breakeven_trigger_pct DOUBLE PRECISION DEFAULT 50,
        trailing_trigger_pct DOUBLE PRECISION DEFAULT 100,
        trailing_distance_pct DOUBLE PRECISION DEFAULT 30,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
        trader_id TEXT REFERENCES traders(id) ON DELETE CASCADE,
        copy_config_id TEXT REFERENCES copy_configs(id) ON DELETE CASCADE,
        copy_wallet_id TEXT REFERENCES copy_wallets(id) ON DELETE SET NULL,
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        qty NUMERIC NOT NULL,
        cost_usd DOUBLE PRECISION NOT NULL,
        avg_entry_price DOUBLE PRECISION NOT NULL,
        highest_price DOUBLE PRECISION NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closing','closed','failed')),
        source_type TEXT NOT NULL DEFAULT 'leader',
        source_label TEXT,
        source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS positions_one_open_idx
        ON positions(user_id,trader_id,chain,token) WHERE status='open' AND trader_id IS NOT NULL;
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

      CREATE TABLE IF NOT EXISTS auto_trade_signals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        signal_source TEXT,
        signal_score DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'started',
        position_id TEXT REFERENCES positions(id) ON DELETE SET NULL,
        execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, chain, token)
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

      CREATE TABLE IF NOT EXISTS wallet_candidates (
        id TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        display_name TEXT,
        source_priority DOUBLE PRECISION NOT NULL DEFAULT 0,
        source_count INTEGER NOT NULL DEFAULT 0,
        first_discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        analysis_status TEXT NOT NULL DEFAULT 'PENDING',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(chain,wallet_address)
      );

      CREATE TABLE IF NOT EXISTS wallet_candidate_sources (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES wallet_candidates(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_provider TEXT,
        source_entity TEXT,
        source_event_id TEXT NOT NULL,
        token_mint TEXT,
        leader_wallet TEXT,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(candidate_id,source_type,source_event_id)
      );

      CREATE TABLE IF NOT EXISTS winning_tokens (
        id TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        token_mint TEXT NOT NULL,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        baseline_time TIMESTAMPTZ,
        baseline_price_usd NUMERIC,
        peak_time TIMESTAMPTZ,
        peak_price_usd NUMERIC,
        peak_multiple NUMERIC,
        liquidity_usd NUMERIC,
        market_cap_usd NUMERIC,
        discovery_reason TEXT NOT NULL,
        source_provider TEXT,
        processed_for_wallets BOOLEAN NOT NULL DEFAULT false,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(chain,token_mint)
      );

      CREATE TABLE IF NOT EXISTS token_early_buyers (
        id TEXT PRIMARY KEY,
        winning_token_id TEXT NOT NULL REFERENCES winning_tokens(id) ON DELETE CASCADE,
        wallet_address TEXT NOT NULL,
        buyer_rank INTEGER,
        buy_time TIMESTAMPTZ NOT NULL,
        buy_amount_usd NUMERIC,
        seconds_from_baseline BIGINT,
        price_at_buy_usd NUMERIC,
        meaningful BOOLEAN NOT NULL DEFAULT true,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(winning_token_id,wallet_address)
      );


      CREATE TABLE IF NOT EXISTS market_signal_snapshots (
        id TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        token_mint TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        price_usd DOUBLE PRECISION,
        liquidity_usd DOUBLE PRECISION,
        market_cap_usd DOUBLE PRECISION,
        volume_h1_usd DOUBLE PRECISION,
        txns_h1 INTEGER,
        age_minutes DOUBLE PRECISION,
        price_change_m5_pct DOUBLE PRECISION,
        price_change_h1_pct DOUBLE PRECISION,
        signal_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        recommendation TEXT NOT NULL,
        buy_reasons TEXT[] NOT NULL DEFAULT '{}',
        risk_reasons TEXT[] NOT NULL DEFAULT '{}',
        avoid_reasons TEXT[] NOT NULL DEFAULT '{}',
        entry_plan TEXT[] NOT NULL DEFAULT '{}',
        exit_plan TEXT[] NOT NULL DEFAULT '{}',
        quality JSONB NOT NULL DEFAULT '{}'::jsonb,
        sources TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS market_signal_snapshots_created_idx ON market_signal_snapshots(created_at DESC);
      CREATE INDEX IF NOT EXISTS market_signal_snapshots_token_idx ON market_signal_snapshots(chain, token_mint, created_at DESC);
      CREATE INDEX IF NOT EXISTS market_signal_snapshots_recommendation_idx ON market_signal_snapshots(recommendation, signal_score DESC);

      CREATE TABLE IF NOT EXISTS wallet_source_stats (
        candidate_id TEXT PRIMARY KEY REFERENCES wallet_candidates(id) ON DELETE CASCADE,
        winning_token_appearances INTEGER NOT NULL DEFAULT 0,
        two_x_appearances INTEGER NOT NULL DEFAULT 0,
        five_x_appearances INTEGER NOT NULL DEFAULT 0,
        ten_x_appearances INTEGER NOT NULL DEFAULT 0,
        leader_neighbor_appearances INTEGER NOT NULL DEFAULT 0,
        convergence_appearances INTEGER NOT NULL DEFAULT 0,
        social_identity_sources INTEGER NOT NULL DEFAULT 0,
        leaderboard_sources INTEGER NOT NULL DEFAULT 0,
        unique_source_types INTEGER NOT NULL DEFAULT 0,
        unique_tokens INTEGER NOT NULL DEFAULT 0,
        median_buyer_rank NUMERIC,
        median_entry_delay_seconds NUMERIC,
        last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS wallet_candidate_analyses (
        candidate_id TEXT PRIMARY KEY REFERENCES wallet_candidates(id) ON DELETE CASCADE,
        analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        recommendation TEXT NOT NULL,
        qualification_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_swaps INTEGER NOT NULL DEFAULT 0,
        buy_count INTEGER NOT NULL DEFAULT 0,
        sell_count INTEGER NOT NULL DEFAULT 0,
        distinct_tokens INTEGER NOT NULL DEFAULT 0,
        winning_token_hits INTEGER NOT NULL DEFAULT 0,
        five_x_hits INTEGER NOT NULL DEFAULT 0,
        recent_non_winning_buys INTEGER NOT NULL DEFAULT 0,
        trades_per_day DOUBLE PRECISION,
        median_hold_minutes DOUBLE PRECISION,
        sell_coverage_pct DOUBLE PRECISION,
        possible_bot BOOLEAN NOT NULL DEFAULT false,
        possible_router BOOLEAN NOT NULL DEFAULT false,
        possible_deployer BOOLEAN NOT NULL DEFAULT false,
        uses_multiple_fee_payers BOOLEAN NOT NULL DEFAULT false,
        warnings TEXT[] NOT NULL DEFAULT '{}',
        strengths TEXT[] NOT NULL DEFAULT '{}',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    await this.pool.query(
      `ALTER TABLE copy_configs ALTER COLUMN mirror_exits SET DEFAULT true`,
    );
    await this.pool.query(
      `ALTER TABLE copy_configs ALTER COLUMN trade_amount_usd SET DEFAULT 1`,
    );
    await this.pool.query(`ALTER TABLE copy_configs ADD COLUMN IF NOT EXISTS custom_label TEXT`);
    await this.pool.query(`ALTER TABLE positions ALTER COLUMN trader_id DROP NOT NULL`);
    await this.pool.query(`ALTER TABLE positions ALTER COLUMN copy_config_id DROP NOT NULL`);
    await this.pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'leader'`);
    await this.pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS source_label TEXT`);
    await this.pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS positions_one_open_auto_idx ON positions(user_id,chain,token) WHERE status='open' AND source_type='auto'`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS positions_source_idx ON positions(user_id, source_type, status, opened_at DESC)`);
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS min_hold_seconds INTEGER DEFAULT 0`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS tp1_pct DOUBLE PRECISION DEFAULT 100`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS tp1_sell_pct DOUBLE PRECISION DEFAULT 50`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS tp2_pct DOUBLE PRECISION DEFAULT 200`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS tp2_sell_pct DOUBLE PRECISION DEFAULT 25`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS tp3_pct DOUBLE PRECISION DEFAULT 400`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS tp3_sell_pct DOUBLE PRECISION DEFAULT 25`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS runner_pct DOUBLE PRECISION DEFAULT 0`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS breakeven_trigger_pct DOUBLE PRECISION DEFAULT 50`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS trailing_trigger_pct DOUBLE PRECISION DEFAULT 100`,
    );
    await this.pool.query(
      `ALTER TABLE auto_trading_configs ADD COLUMN IF NOT EXISTS trailing_distance_pct DOUBLE PRECISION DEFAULT 30`,
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

  async followTrader(userId: string, traderId: string, customLabel?: string | null) {
    const wallet = await this.getCopyWallet(userId, "solana");
    const existing = await this.pool.query(
      `SELECT id FROM copy_configs WHERE user_id=$1 AND trader_id=$2`,
      [userId, traderId],
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await this.pool.query(
      `
      INSERT INTO copy_configs(id,user_id,trader_id,trading_wallet_id,mirror_exits,custom_label)
      VALUES($1,$2,$3,$4,true,$5)
      ON CONFLICT(user_id,trader_id) DO UPDATE SET
        enabled=true,
        custom_label=COALESCE(EXCLUDED.custom_label,copy_configs.custom_label)
    `,
      [id, userId, traderId, wallet?.id ?? null, cleanLabel(customLabel)],
    );
    return this.getCopyConfig(id);
  }

  async getAutoTradingConfig(userId: string) {
    await this.pool.query(
      `INSERT INTO auto_trading_configs(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`,
      [userId],
    );
    const { rows } = await this.pool.query(
      `SELECT * FROM auto_trading_configs WHERE user_id=$1`,
      [userId],
    );
    return rows[0];
  }

  async updateAutoTradingConfig(userId: string, patch: Record<string, unknown>) {
    await this.getAutoTradingConfig(userId);
    const columns: Record<string, string> = {
      enabledLive: "enabled_live",
      tradeAmountUsd: "trade_amount_usd",
      maxOpenPositions: "max_open_positions",
      maxDailyBuys: "max_daily_buys",
      dailyLossLimitUsd: "daily_loss_limit_usd",
      maxTokenRiskScore: "max_token_risk_score",
      minLiquidityUsd: "min_liquidity_usd",
      minMarketCapUsd: "min_market_cap_usd",
      maxMarketCapUsd: "max_market_cap_usd",
      takeProfitPct: "take_profit_pct",
      stopLossPct: "stop_loss_pct",
      maxHoldSeconds: "max_hold_seconds",
      minHoldSeconds: "min_hold_seconds",
      tp1Pct: "tp1_pct",
      tp1SellPct: "tp1_sell_pct",
      tp2Pct: "tp2_pct",
      tp2SellPct: "tp2_sell_pct",
      tp3Pct: "tp3_pct",
      tp3SellPct: "tp3_sell_pct",
      runnerPct: "runner_pct",
      breakevenTriggerPct: "breakeven_trigger_pct",
      trailingTriggerPct: "trailing_trigger_pct",
      trailingDistancePct: "trailing_distance_pct",
    };
    const sets: string[] = [];
    const values: unknown[] = [userId];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      values.push(patch[key]);
      sets.push(`${column}=$${values.length}`);
    }
    if (sets.length) {
      await this.pool.query(
        `UPDATE auto_trading_configs SET ${sets.join(",")}, updated_at=now() WHERE user_id=$1`,
        values,
      );
    }
    return this.getAutoTradingConfig(userId);
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
      customLabel: string | null;
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
      customLabel: "custom_label",
      enabled: "enabled",
      dryRun: "dry_run",
    };
    const normalizedPatch = { ...patch };
    if ("customLabel" in normalizedPatch) {
      normalizedPatch.customLabel = cleanLabel(normalizedPatch.customLabel);
    }
    const entries = Object.entries(normalizedPatch).filter(([k]) => k in allowed);
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

  async configsForWallet(address: string): Promise<
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
    traderId: string | null;
    configId: string | null;
    copyWalletId: string | null;
    chain: string;
    token: string;
    qty: number;
    costUsd: number;
    entryPrice: number;
    mode: "paper" | "live";
    sourceType?: string;
    sourceLabel?: string | null;
    sourceMetadata?: Record<string, unknown>;
  }) {
    const existing = await this.pool.query(
      `
      SELECT * FROM positions
      WHERE user_id=$1
        AND chain=$3
        AND token=$4
        AND status='open'
        AND (
          ($2::text IS NOT NULL AND trader_id=$2)
          OR ($2::text IS NULL AND source_type=COALESCE($5,'auto'))
        )
    `,
      [input.userId, input.traderId, input.chain, input.token, input.sourceType ?? 'leader'],
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
      INSERT INTO positions(id,user_id,trader_id,copy_config_id,copy_wallet_id,chain,token,qty,cost_usd,avg_entry_price,highest_price,mode,source_type,source_label,source_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14::jsonb)
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
        input.sourceType ?? "leader",
        input.sourceLabel ?? null,
        JSON.stringify(input.sourceMetadata ?? {}),
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
      SELECT p.*, t.handle, COALESCE(t.display_name,p.source_label,'Autonomous') AS display_name,
             COALESCE(c.take_profit_pct,ac.take_profit_pct) AS take_profit_pct,
             COALESCE(c.stop_loss_pct,ac.stop_loss_pct) AS stop_loss_pct,
             COALESCE(c.max_hold_seconds,ac.max_hold_seconds) AS max_hold_seconds,
             ac.min_hold_seconds,
             COALESCE(c.dry_run,false) AS dry_run,
             COALESCE(c.slippage_bps,300) AS slippage_bps,
             u.telegram_chat_id, cw.public_address AS copy_wallet_address, cw.signer_ref
      FROM positions p
      LEFT JOIN traders t ON t.id=p.trader_id
      LEFT JOIN copy_configs c ON c.id=p.copy_config_id
      LEFT JOIN auto_trading_configs ac ON ac.user_id=p.user_id AND p.source_type='auto'
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
      SELECT p.*, COALESCE(c.take_profit_pct,ac.take_profit_pct) AS take_profit_pct,
             COALESCE(c.stop_loss_pct,ac.stop_loss_pct) AS stop_loss_pct,
             COALESCE(c.max_hold_seconds,ac.max_hold_seconds) AS max_hold_seconds,
             ac.min_hold_seconds,
             COALESCE(c.dry_run,false) AS dry_run,
             COALESCE(c.slippage_bps,300) AS slippage_bps,
             cw.public_address AS copy_wallet_address,cw.signer_ref,t.handle,COALESCE(t.display_name,p.source_label,'Autonomous') AS display_name,u.telegram_chat_id
      FROM positions p
      LEFT JOIN copy_configs c ON c.id=p.copy_config_id
      LEFT JOIN auto_trading_configs ac ON ac.user_id=p.user_id AND p.source_type='auto'
      LEFT JOIN traders t ON t.id=p.trader_id JOIN users u ON u.id=p.user_id
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
      WITH inserted AS (
        INSERT INTO activity_events(id,user_id,trader_id,position_id,execution_id,type,severity,message,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        RETURNING *
      )
      SELECT inserted.*, t.handle, t.display_name
      FROM inserted
      LEFT JOIN traders t ON t.id=inserted.trader_id
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

  async countFailedSellExecutions(positionId: string, token: string) {
    const { rows } = await this.pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM executions
      WHERE position_id=$1
        AND token=$2
        AND side='sell'
        AND status LIKE 'failed:%VALUE_SANITY_CHECK_FAILED%'
        AND reason NOT LIKE '%AUTO_EMERGENCY%'
    `,
      [positionId, token],
    );
    return Number(rows[0]?.count ?? 0);
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

  async listExecutionsForTrader(userId: string, traderId: string, limit = 200) {
    const { rows } = await this.pool.query(
      `
      SELECT e.*, t.handle,t.display_name FROM executions e
      LEFT JOIN traders t ON t.id=e.trader_id
      WHERE e.user_id=$1 AND e.trader_id=$2
      ORDER BY e.created_at DESC LIMIT $3
    `,
      [userId, traderId, limit],
    );
    return rows;
  }

  async listExecutionsForConfig(userId: string, configId: string, limit = 100, offset = 0) {
    const { rows } = await this.pool.query(
      `
      SELECT e.*, t.handle,t.display_name
      FROM copy_configs c
      JOIN executions e ON e.user_id=c.user_id AND e.trader_id=c.trader_id
      LEFT JOIN traders t ON t.id=e.trader_id
      WHERE c.user_id=$1 AND c.id=$2
      ORDER BY e.created_at DESC
      LIMIT $3 OFFSET $4
    `,
      [userId, configId, limit, offset],
    );
    return rows;
  }

  async countExecutionsForConfig(userId: string, configId: string) {
    const { rows } = await this.pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM copy_configs c
      JOIN executions e ON e.user_id=c.user_id AND e.trader_id=c.trader_id
      WHERE c.user_id=$1 AND c.id=$2
    `,
      [userId, configId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async listExecutions(userId: string, limit = 100) {
    const { rows } = await this.pool.query(
      `
      SELECT e.*, t.handle,COALESCE(t.display_name,p.source_label) AS display_name,p.source_type
      FROM executions e
      LEFT JOIN traders t ON t.id=e.trader_id
      LEFT JOIN positions p ON p.id=e.position_id
      WHERE e.user_id=$1 ORDER BY e.created_at DESC LIMIT $2
    `,
      [userId, limit],
    );
    return rows;
  }

  async listActivityEvents(userId: string, limit = 100) {
    const { rows } = await this.pool.query(
      `
      SELECT a.*, t.handle,COALESCE(t.display_name,p.source_label) AS display_name,p.source_type
      FROM activity_events a
      LEFT JOIN traders t ON t.id=a.trader_id
      LEFT JOIN positions p ON p.id=a.position_id
      WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT $2
    `,
      [userId, limit],
    );
    return rows;
  }

  async upsertWinningToken(input: {
    chain: string;
    tokenMint: string;
    baselinePriceUsd?: number | null;
    peakPriceUsd?: number | null;
    peakMultiple?: number | null;
    liquidityUsd?: number | null;
    marketCapUsd?: number | null;
    discoveryReason: string;
    sourceProvider?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO winning_tokens(id,chain,token_mint,detected_at,baseline_price_usd,peak_price_usd,peak_multiple,liquidity_usd,market_cap_usd,discovery_reason,source_provider,metadata,created_at,updated_at)
      VALUES($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),now())
      ON CONFLICT(chain,token_mint) DO UPDATE SET
        peak_price_usd=COALESCE(EXCLUDED.peak_price_usd,winning_tokens.peak_price_usd),
        peak_multiple=COALESCE(EXCLUDED.peak_multiple,winning_tokens.peak_multiple),
        liquidity_usd=COALESCE(EXCLUDED.liquidity_usd,winning_tokens.liquidity_usd),
        market_cap_usd=COALESCE(EXCLUDED.market_cap_usd,winning_tokens.market_cap_usd),
        metadata=winning_tokens.metadata || EXCLUDED.metadata,
        updated_at=now()
      RETURNING *
    `,
      [
        id,
        input.chain,
        input.tokenMint,
        input.baselinePriceUsd ?? null,
        input.peakPriceUsd ?? null,
        input.peakMultiple ?? null,
        input.liquidityUsd ?? null,
        input.marketCapUsd ?? null,
        input.discoveryReason,
        input.sourceProvider ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0];
  }

  async getWinningTokenByMint(chain: string, tokenMint: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM winning_tokens WHERE chain=$1 AND token_mint=$2 LIMIT 1`,
      [chain, tokenMint],
    );
    return rows[0] ?? null;
  }

  async markWinningTokenProcessed(id: string) {
    await this.pool.query(
      `UPDATE winning_tokens SET processed_for_wallets=true,updated_at=now() WHERE id=$1`,
      [id],
    );
  }

  async upsertWalletCandidate(input: {
    chain: string;
    walletAddress: string;
    displayName?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO wallet_candidates(id,chain,wallet_address,display_name,first_discovered_at,last_discovered_at,metadata,created_at,updated_at)
      VALUES($1,$2,$3,$4,now(),now(),$5::jsonb,now(),now())
      ON CONFLICT(chain,wallet_address) DO UPDATE SET
        display_name=COALESCE(EXCLUDED.display_name,wallet_candidates.display_name),
        last_discovered_at=now(),
        metadata=wallet_candidates.metadata || EXCLUDED.metadata,
        updated_at=now()
      RETURNING *
    `,
      [
        id,
        input.chain,
        input.walletAddress,
        input.displayName ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0];
  }

  async addWalletCandidateSource(input: {
    candidateId: string;
    sourceType: string;
    sourceProvider?: string | null;
    sourceEntity?: string | null;
    sourceEventId: string;
    tokenMint?: string | null;
    leaderWallet?: string | null;
    observedAt?: Date;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO wallet_candidate_sources(id,candidate_id,source_type,source_provider,source_entity,source_event_id,token_mint,leader_wallet,observed_at,metadata,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())
      ON CONFLICT(candidate_id,source_type,source_event_id) DO NOTHING
    `,
      [
        id,
        input.candidateId,
        input.sourceType,
        input.sourceProvider ?? null,
        input.sourceEntity ?? null,
        input.sourceEventId,
        input.tokenMint ?? null,
        input.leaderWallet ?? null,
        input.observedAt ?? new Date(),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async addTokenEarlyBuyer(input: {
    winningTokenId: string;
    walletAddress: string;
    buyerRank?: number | null;
    buyTime: Date;
    buyAmountUsd?: number | null;
    secondsFromBaseline?: number | null;
    priceAtBuyUsd?: number | null;
    meaningful?: boolean;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO token_early_buyers(id,winning_token_id,wallet_address,buyer_rank,buy_time,buy_amount_usd,seconds_from_baseline,price_at_buy_usd,meaningful,metadata,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())
      ON CONFLICT(winning_token_id,wallet_address) DO UPDATE SET
        buyer_rank=LEAST(COALESCE(token_early_buyers.buyer_rank,EXCLUDED.buyer_rank),COALESCE(EXCLUDED.buyer_rank,token_early_buyers.buyer_rank)),
        buy_amount_usd=COALESCE(token_early_buyers.buy_amount_usd,EXCLUDED.buy_amount_usd),
        metadata=token_early_buyers.metadata || EXCLUDED.metadata
    `,
      [
        id,
        input.winningTokenId,
        input.walletAddress,
        input.buyerRank ?? null,
        input.buyTime,
        input.buyAmountUsd ?? null,
        input.secondsFromBaseline ?? null,
        input.priceAtBuyUsd ?? null,
        input.meaningful ?? true,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async getWalletCandidate(candidateId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM wallet_candidates WHERE id=$1 LIMIT 1`,
      [candidateId],
    );
    return rows[0] ?? null;
  }

  async upsertWalletCandidateAnalysis(input: {
    candidateId: string;
    recommendation: string;
    qualificationScore: number;
    totalSwaps: number;
    buyCount: number;
    sellCount: number;
    distinctTokens: number;
    winningTokenHits: number;
    fiveXHits: number;
    recentNonWinningBuys: number;
    tradesPerDay?: number | null;
    medianHoldMinutes?: number | null;
    sellCoveragePct?: number | null;
    possibleBot: boolean;
    possibleRouter: boolean;
    possibleDeployer: boolean;
    usesMultipleFeePayers: boolean;
    warnings: string[];
    strengths: string[];
    metadata?: Record<string, unknown>;
  }) {
    const { rows } = await this.pool.query(
      `
      INSERT INTO wallet_candidate_analyses(candidate_id,analyzed_at,recommendation,qualification_score,total_swaps,buy_count,sell_count,distinct_tokens,winning_token_hits,five_x_hits,recent_non_winning_buys,trades_per_day,median_hold_minutes,sell_coverage_pct,possible_bot,possible_router,possible_deployer,uses_multiple_fee_payers,warnings,strengths,metadata)
      VALUES($1,now(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
      ON CONFLICT(candidate_id) DO UPDATE SET
        analyzed_at=now(),
        recommendation=EXCLUDED.recommendation,
        qualification_score=EXCLUDED.qualification_score,
        total_swaps=EXCLUDED.total_swaps,
        buy_count=EXCLUDED.buy_count,
        sell_count=EXCLUDED.sell_count,
        distinct_tokens=EXCLUDED.distinct_tokens,
        winning_token_hits=EXCLUDED.winning_token_hits,
        five_x_hits=EXCLUDED.five_x_hits,
        recent_non_winning_buys=EXCLUDED.recent_non_winning_buys,
        trades_per_day=EXCLUDED.trades_per_day,
        median_hold_minutes=EXCLUDED.median_hold_minutes,
        sell_coverage_pct=EXCLUDED.sell_coverage_pct,
        possible_bot=EXCLUDED.possible_bot,
        possible_router=EXCLUDED.possible_router,
        possible_deployer=EXCLUDED.possible_deployer,
        uses_multiple_fee_payers=EXCLUDED.uses_multiple_fee_payers,
        warnings=EXCLUDED.warnings,
        strengths=EXCLUDED.strengths,
        metadata=EXCLUDED.metadata
      RETURNING *
    `,
      [
        input.candidateId,
        input.recommendation,
        input.qualificationScore,
        input.totalSwaps,
        input.buyCount,
        input.sellCount,
        input.distinctTokens,
        input.winningTokenHits,
        input.fiveXHits,
        input.recentNonWinningBuys,
        input.tradesPerDay ?? null,
        input.medianHoldMinutes ?? null,
        input.sellCoveragePct ?? null,
        input.possibleBot,
        input.possibleRouter,
        input.possibleDeployer,
        input.usesMultipleFeePayers,
        input.warnings,
        input.strengths,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    await this.pool.query(
      `UPDATE wallet_candidates SET analysis_status=$2,updated_at=now() WHERE id=$1`,
      [input.candidateId, input.recommendation],
    );
    return rows[0];
  }

  async recalculateWalletSourceStats() {
    await this.pool.query(`
      INSERT INTO wallet_source_stats(candidate_id,winning_token_appearances,two_x_appearances,five_x_appearances,ten_x_appearances,leader_neighbor_appearances,convergence_appearances,social_identity_sources,leaderboard_sources,unique_source_types,unique_tokens,median_buyer_rank,median_entry_delay_seconds,last_calculated_at)
      SELECT c.id,
        COUNT(DISTINCT s.token_mint) FILTER (WHERE s.source_type IN ('WINNING_TOKEN_EARLY_BUYER','REPEAT_WINNING_TOKEN_BUYER'))::int,
        COUNT(DISTINCT s.token_mint) FILTER (WHERE (s.metadata->>'tokenPeakMultiple')::numeric >= 2)::int,
        COUNT(DISTINCT s.token_mint) FILTER (WHERE (s.metadata->>'tokenPeakMultiple')::numeric >= 5)::int,
        COUNT(DISTINCT s.token_mint) FILTER (WHERE (s.metadata->>'tokenPeakMultiple')::numeric >= 10)::int,
        COUNT(*) FILTER (WHERE s.source_type LIKE 'LEADER_%')::int,
        COUNT(*) FILTER (WHERE s.source_type='CONVERGENCE_CLUSTER')::int,
        COUNT(*) FILTER (WHERE s.source_type IN ('FOMOSCAN_IDENTITY','SOCIAL_HANDLE'))::int,
        COUNT(*) FILTER (WHERE s.source_type='PUBLIC_LEADERBOARD')::int,
        COUNT(DISTINCT s.source_type)::int,
        COUNT(DISTINCT s.token_mint)::int,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(s.metadata->>'buyerRank','')::numeric) FILTER (WHERE s.metadata ? 'buyerRank'),
        percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(s.metadata->>'entryDelaySeconds','')::numeric) FILTER (WHERE s.metadata ? 'entryDelaySeconds'),
        now()
      FROM wallet_candidates c
      LEFT JOIN wallet_candidate_sources s ON s.candidate_id=c.id
      GROUP BY c.id
      ON CONFLICT(candidate_id) DO UPDATE SET
        winning_token_appearances=EXCLUDED.winning_token_appearances,
        two_x_appearances=EXCLUDED.two_x_appearances,
        five_x_appearances=EXCLUDED.five_x_appearances,
        ten_x_appearances=EXCLUDED.ten_x_appearances,
        leader_neighbor_appearances=EXCLUDED.leader_neighbor_appearances,
        convergence_appearances=EXCLUDED.convergence_appearances,
        social_identity_sources=EXCLUDED.social_identity_sources,
        leaderboard_sources=EXCLUDED.leaderboard_sources,
        unique_source_types=EXCLUDED.unique_source_types,
        unique_tokens=EXCLUDED.unique_tokens,
        median_buyer_rank=EXCLUDED.median_buyer_rank,
        median_entry_delay_seconds=EXCLUDED.median_entry_delay_seconds,
        last_calculated_at=now()
    `);
    await this.pool.query(`
      UPDATE wallet_candidates c SET
        source_count=COALESCE(src.source_count,0),
        source_priority=LEAST(100,
          COALESCE(st.winning_token_appearances,0)*14 +
          COALESCE(st.five_x_appearances,0)*9 +
          COALESCE(st.ten_x_appearances,0)*14 +
          COALESCE(st.unique_source_types,0)*6 +
          CASE WHEN st.median_buyer_rank IS NOT NULL THEN GREATEST(0, 12 - st.median_buyer_rank / 10) ELSE 0 END
        ),
        updated_at=now()
      FROM wallet_source_stats st
      LEFT JOIN (SELECT candidate_id, COUNT(*)::int source_count FROM wallet_candidate_sources GROUP BY candidate_id) src ON src.candidate_id=st.candidate_id
      WHERE c.id=st.candidate_id
    `);
  }

  async listWalletCandidates(limit = 50, order: "priority" | "recent" = "priority") {
    const orderSql =
      order === "recent"
        ? "c.last_discovered_at DESC,c.created_at DESC"
        : "c.source_priority DESC,c.last_discovered_at DESC";
    const { rows } = await this.pool.query(
      `
      SELECT c.*, st.winning_token_appearances,st.two_x_appearances,st.five_x_appearances,st.ten_x_appearances,
             st.unique_source_types,st.unique_tokens,st.median_buyer_rank,st.median_entry_delay_seconds,
             a.analyzed_at,a.recommendation,a.qualification_score,a.total_swaps,a.buy_count,a.sell_count,
             a.distinct_tokens,a.winning_token_hits,a.five_x_hits,a.recent_non_winning_buys,
             a.trades_per_day,a.median_hold_minutes,a.sell_coverage_pct,a.possible_bot,a.possible_router,
             a.possible_deployer,a.uses_multiple_fee_payers,a.warnings,a.strengths,a.metadata AS analysis_metadata,
             COALESCE(src.source_types,'{}') AS source_types
      FROM wallet_candidates c
      LEFT JOIN wallet_source_stats st ON st.candidate_id=c.id
      LEFT JOIN wallet_candidate_analyses a ON a.candidate_id=c.id
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT source_type) AS source_types
        FROM wallet_candidate_sources
        WHERE candidate_id=c.id
      ) src ON true
      ORDER BY ${orderSql}
      LIMIT $1
    `,
      [limit],
    );
    return rows;
  }

  async insertMarketSignalSnapshot(input: {
    chain: string;
    tokenMint: string;
    symbol?: string | null;
    name?: string | null;
    priceUsd?: number | null;
    liquidityUsd?: number | null;
    marketCapUsd?: number | null;
    volumeH1Usd?: number | null;
    txnsH1?: number | null;
    ageMinutes?: number | null;
    priceChangeM5Pct?: number | null;
    priceChangeH1Pct?: number | null;
    signalScore: number;
    recommendation: string;
    buyReasons: string[];
    riskReasons: string[];
    avoidReasons: string[];
    entryPlan: string[];
    exitPlan: string[];
    quality?: Record<string, unknown>;
    sources: string[];
  }) {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO market_signal_snapshots(id,chain,token_mint,symbol,name,price_usd,liquidity_usd,market_cap_usd,volume_h1_usd,txns_h1,age_minutes,price_change_m5_pct,price_change_h1_pct,signal_score,recommendation,buy_reasons,risk_reasons,avoid_reasons,entry_plan,exit_plan,quality,sources)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)
      RETURNING *
    `,
      [
        id,
        input.chain,
        input.tokenMint,
        input.symbol ?? null,
        input.name ?? null,
        input.priceUsd ?? null,
        input.liquidityUsd ?? null,
        input.marketCapUsd ?? null,
        input.volumeH1Usd ?? null,
        input.txnsH1 ?? null,
        input.ageMinutes ?? null,
        input.priceChangeM5Pct ?? null,
        input.priceChangeH1Pct ?? null,
        input.signalScore,
        input.recommendation,
        input.buyReasons,
        input.riskReasons,
        input.avoidReasons,
        input.entryPlan,
        input.exitPlan,
        JSON.stringify(input.quality ?? {}),
        input.sources,
      ],
    );
    return rows[0];
  }

  async listMarketSignalFeed(limit = 30) {
    const { rows } = await this.pool.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (chain, token_mint) *
        FROM market_signal_snapshots
        ORDER BY chain, token_mint, created_at DESC
      )
      SELECT * FROM latest
      ORDER BY signal_score DESC, created_at DESC
      LIMIT $1
    `,
      [limit],
    );
    return rows;
  }

  async marketSignalStats() {
    const { rows } = await this.pool.query(
      `
      SELECT
        COUNT(*)::int AS snapshot_count,
        MAX(created_at) AS last_scan_at,
        COUNT(DISTINCT token_mint)::int AS token_count
      FROM market_signal_snapshots
    `,
    );
    return rows[0];
  }

  async walletCandidateQuality(wallets: string[]) {
    if (!wallets.length) return [];
    const { rows } = await this.pool.query(
      `
      SELECT c.wallet_address,c.source_priority,c.analysis_status,
             st.winning_token_appearances,st.five_x_appearances,st.ten_x_appearances,
             a.recommendation,a.qualification_score,a.metadata AS analysis_metadata,
             a.possible_router,a.possible_deployer,a.possible_bot
      FROM wallet_candidates c
      LEFT JOIN wallet_source_stats st ON st.candidate_id=c.id
      LEFT JOIN wallet_candidate_analyses a ON a.candidate_id=c.id
      WHERE c.wallet_address = ANY($1)
    `,
      [wallets],
    );
    return rows;
  }

  async listWinningTokens(limit = 30) {
    const { rows } = await this.pool.query(
      `
      SELECT wt.*, COUNT(teb.id)::int AS early_buyer_count
      FROM winning_tokens wt
      LEFT JOIN token_early_buyers teb ON teb.winning_token_id=wt.id
      GROUP BY wt.id
      ORDER BY wt.detected_at DESC
      LIMIT $1
    `,
      [limit],
    );
    return rows;
  }

  async candidateSources(candidateId: string) {
    const { rows } = await this.pool.query(
      `
      SELECT * FROM wallet_candidate_sources WHERE candidate_id=$1 ORDER BY observed_at DESC LIMIT 100
    `,
      [candidateId],
    );
    return rows;
  }

  async candidateAnalysis(candidateId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM wallet_candidate_analyses WHERE candidate_id=$1 LIMIT 1`,
      [candidateId],
    );
    return rows[0] ?? null;
  }

  async sourcingStats() {
    const { rows } = await this.pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM wallet_candidates) AS candidate_count,
        (SELECT COUNT(*)::int FROM winning_tokens) AS winning_token_count,
        (SELECT COUNT(*)::int FROM winning_tokens WHERE processed_for_wallets) AS processed_token_count,
        (SELECT MAX(detected_at) FROM winning_tokens) AS last_token_detected_at,
        (SELECT MAX(last_discovered_at) FROM wallet_candidates) AS last_candidate_discovered_at
    `);
    return rows[0];
  }

  async listEnabledAutoTradingConfigs() {
    const { rows } = await this.pool.query(
      `
      SELECT ac.*, u.telegram_chat_id, u.paused,
             cw.id AS copy_wallet_id,cw.public_address,cw.signer_ref
      FROM auto_trading_configs ac
      JOIN users u ON u.id=ac.user_id
      LEFT JOIN copy_wallets cw ON cw.user_id=ac.user_id AND cw.chain='solana' AND cw.enabled=true
      WHERE ac.enabled_live=true
      ORDER BY ac.updated_at ASC
    `,
    );
    return rows;
  }

  async listAutoTradeCandidates(userId: string, config: any, limit = 5) {
    const { rows } = await this.pool.query(
      `
      SELECT wt.*,
             COUNT(teb.id)::int AS early_buyer_count,
             COALESCE(MAX(NULLIF(teb.buy_amount_usd,0)),0) AS largest_early_buy_usd
      FROM winning_tokens wt
      LEFT JOIN token_early_buyers teb ON teb.winning_token_id=wt.id
      WHERE wt.chain='solana'
        AND wt.detected_at >= now() - interval '48 hours'
        AND COALESCE(wt.liquidity_usd,0) >= $2
        AND COALESCE(wt.market_cap_usd, wt.liquidity_usd, 0) >= $3
        AND COALESCE(wt.market_cap_usd, wt.liquidity_usd, 0) <= $4
        AND NOT EXISTS (
          SELECT 1 FROM auto_trade_signals s
          WHERE s.user_id=$1 AND s.chain=wt.chain AND s.token=wt.token_mint
        )
        AND NOT EXISTS (
          SELECT 1 FROM positions p
          WHERE p.user_id=$1 AND p.chain=wt.chain AND p.token=wt.token_mint AND p.status='open'
        )
      GROUP BY wt.id
      HAVING COUNT(teb.id) > 0
      ORDER BY wt.detected_at DESC, COALESCE(wt.peak_multiple,0) DESC, early_buyer_count DESC
      LIMIT $5
    `,
      [
        userId,
        Number(config.min_liquidity_usd ?? 0),
        Number(config.min_market_cap_usd ?? 0),
        Number(config.max_market_cap_usd ?? 1_000_000_000),
        limit,
      ],
    );
    return rows;
  }

  async tryStartAutoTradeSignal(input: {
    userId: string;
    chain: string;
    token: string;
    signalType: string;
    signalSource?: string | null;
    signalScore?: number | null;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO auto_trade_signals(id,user_id,chain,token,signal_type,signal_source,signal_score,status,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,'started',$8::jsonb)
      ON CONFLICT(user_id,chain,token) DO NOTHING
      RETURNING *
    `,
      [
        id,
        input.userId,
        input.chain,
        input.token,
        input.signalType,
        input.signalSource ?? null,
        input.signalScore ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0] ?? null;
  }

  async updateAutoTradeSignal(
    id: string,
    patch: { status: string; positionId?: string | null; executionId?: string | null; metadata?: Record<string, unknown> },
  ) {
    await this.pool.query(
      `
      UPDATE auto_trade_signals
      SET status=$2, position_id=COALESCE($3,position_id), execution_id=COALESCE($4,execution_id),
          metadata=metadata || $5::jsonb, updated_at=now()
      WHERE id=$1
    `,
      [id, patch.status, patch.positionId ?? null, patch.executionId ?? null, JSON.stringify(patch.metadata ?? {})],
    );
  }

  async countOpenAutoPositions(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM positions WHERE user_id=$1 AND source_type='auto' AND status='open'`,
      [userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async countDailyAutoBuys(userId: string) {
    const { rows } = await this.pool.query(
      `
      SELECT COUNT(*)::int AS count FROM executions e
      LEFT JOIN positions p ON p.id=e.position_id
      WHERE e.user_id=$1 AND e.side='buy' AND e.reason LIKE 'AUTO_%'
        AND e.status IN ('confirmed','submitted_unknown')
        AND e.created_at >= date_trunc('day', now())
    `,
      [userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async autoDailyRealizedPnlUsd(userId: string) {
    // V1 does not yet attribute partial sell proceeds back to proportional cost basis.
    // Return 0 instead of counting fresh buys as realized losses and blocking auto mode.
    await Promise.resolve(userId);
    return 0;
  }

  async listAutoPositions(userId: string, limit = 50) {
    const { rows } = await this.pool.query(
      `
      SELECT p.*, p.source_label AS display_name,
             ac.take_profit_pct,ac.stop_loss_pct,ac.max_hold_seconds,ac.min_hold_seconds,
             false AS dry_run, 300 AS slippage_bps
      FROM positions p
      LEFT JOIN auto_trading_configs ac ON ac.user_id=p.user_id
      WHERE p.user_id=$1 AND p.source_type='auto'
      ORDER BY p.opened_at DESC LIMIT $2
    `,
      [userId, limit],
    );
    return rows;
  }

  async listAutoExecutions(userId: string, limit = 50) {
    const { rows } = await this.pool.query(
      `
      SELECT e.*, p.source_type, p.source_label AS display_name
      FROM executions e
      LEFT JOIN positions p ON p.id=e.position_id
      WHERE e.user_id=$1 AND (e.reason LIKE 'AUTO_%' OR p.source_type='auto')
      ORDER BY e.created_at DESC LIMIT $2
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

function cleanLabel(value: unknown) {
  if (value == null) return null;
  const label = String(value).trim().replace(/\s+/g, " ").slice(0, 80);
  return label || null;
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
    customLabel: r.custom_label ?? null,
    dryRun: r.dry_run,
    enabled: r.enabled,
  };
}

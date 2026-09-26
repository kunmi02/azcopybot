import { Bot, InlineKeyboard } from "grammy";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import type { TraderService } from "./services/traders.js";
import type { PositionService } from "./services/positions.js";
import { randomLoginCode } from "./auth.js";
import { loadSolanaSigner } from "./wallet.js";
import type { SolanaRpc } from "./chains/solana/rpc.js";
import { SOLANA_USDC } from "./execution/solana.js";

export class TelegramController {
  readonly bot: Bot;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly traders: TraderService,
    private readonly positions: PositionService,
    private readonly rpc: SolanaRpc,
  ) {
    this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);
    this.registerHandlers();
  }

  async notify(chatId: string, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>) {
    const keyboard = buttons ? new InlineKeyboard() : undefined;
    if (keyboard && buttons) {
      for (const row of buttons) {
        for (const b of row) keyboard.text(b.text, b.callback_data);
        keyboard.row();
      }
    }
    try {
      await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (error) {
      console.error("telegram_notify_failed", { chatId, error: String(error) });
    }
  }

  async start() {
    try {
      await this.bot.api.setMyCommands([
        { command: "start", description: "Register this Telegram account" },
        { command: "login", description: "Get a one-time web login code" },
        { command: "follow", description: "Follow a FOMO trader: /follow @handle" },
        { command: "following", description: "List followed traders" },
        { command: "unfollow", description: "Stop following a config" },
        { command: "positions", description: "List open positions" },
        { command: "wallet", description: "Show your dedicated copy wallet" },
        { command: "live", description: "Request live mode for a config" },
        { command: "paper", description: "Return a config to paper mode" },
        { command: "liveall", description: "Request live mode for all followed traders" },
        { command: "paperall", description: "Return all followed traders to paper mode" },
        { command: "pause", description: "Pause new copied entries" },
        { command: "resume", description: "Resume automatic copying" },
        { command: "help", description: "Show commands" },
      ]);
    } catch (error) {
      console.error("telegram_set_commands_failed", String(error));
    }
    this.bot.catch((error) => console.error("telegram_bot_error", String(error.error)));
    this.bot.start({ onStart: () => console.log("telegram_bot_started") });
  }

  private allowed(telegramUserId?: number) {
    if (!telegramUserId) return false;
    if (this.config.allowedTelegramUserIds.size === 0) return false;
    return this.config.allowedTelegramUserIds.has(String(telegramUserId));
  }

  private async userFromContext(ctx: any) {
    if (!this.allowed(ctx.from?.id)) {
      await ctx.reply("This bot is private. Your Telegram account is not allowlisted.");
      return null;
    }
    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || ctx.from?.username || String(ctx.from.id);
    const user = await this.db.upsertTelegramUser({
      telegramUserId: String(ctx.from.id),
      chatId: String(ctx.chat.id),
      displayName,
    });
    const bootstrap = this.config.bootstrapUsers.find((x) => x.telegramUserId === String(ctx.from.id));
    if (bootstrap) await this.db.upsertCopyWallet(user.id, "solana", bootstrap.solanaAddress, bootstrap.signerRef);
    return user;
  }

  private registerHandlers() {
    this.bot.command("start", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      await ctx.reply("CopyBot is connected to this Telegram account. New configs start in PAPER mode. Use /login for the web dashboard or /follow @handle to add a FOMO trader.");
    });

    this.bot.command("login", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      let code = "";
      for (let i = 0; i < 5; i++) {
        const candidate = randomLoginCode();
        if (await this.db.createLoginCode(user.id, candidate, new Date(Date.now() + 5 * 60_000))) { code = candidate; break; }
      }
      if (!code) return void ctx.reply("Could not create a login code. Try again.");
      await ctx.reply(`Web login code: ${code}\nExpires in 5 minutes.\n${this.config.PUBLIC_APP_URL}`);
    });

    this.bot.command("follow", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const handle = ctx.match?.trim();
      if (!handle) return void ctx.reply("Usage: /follow @fomo_handle");
      try {
        const result = await this.traders.resolveFomo(handle);
        const cleanHandle = String(result.identity.handle).replace(/^@/, "");
        const wallets = [
          result.identity.solanaAddress ? `SOL: ${result.identity.solanaAddress}` : "SOL: not resolved",
          result.identity.evmAddress ? `EVM: ${result.identity.evmAddress}` : "EVM: not resolved",
        ].join("\n");
        const kb = new InlineKeyboard().text("Confirm & follow", `confirm_follow_fomo:${cleanHandle}`).row().text("Cancel", "noop");
        await ctx.reply(
          `Trader resolved\n@${cleanHandle}\n${wallets}\n\nV1 copies Solana entries only. Confirm before this trader is added to your watched list.`,
          { reply_markup: kb },
        );
      } catch (error) {
        await ctx.reply(`Could not resolve trader: ${String(error)}`);
      }
    });

    this.bot.callbackQuery(/^confirm_follow_fomo:(.+)$/, async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const handle = ctx.match[1];
      try {
        const result = await this.traders.followFomo(user.id, handle);
        await ctx.editMessageText(
          `✅ Following @${result.identity.handle}\nSOL: ${result.identity.solanaAddress}\n${result.identity.evmAddress ? `EVM: ${result.identity.evmAddress}\n` : ""}Config: $${result.config?.tradeAmountUsd ?? 10}/entry, PAPER mode by default.`,
        );
      } catch (error) {
        await ctx.answerCallbackQuery({ text: String(error).slice(0, 180), show_alert: true });
      }
    });

    this.bot.command("following", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const rows = await this.db.listUserTraders(user.id);
      if (!rows.length) return void ctx.reply("You are not following any traders yet.");
      const text = rows.map((r: any) => `${r.enabled ? "🟢" : "⚪"} ${r.handle ? `@${r.handle}` : r.display_name}\nConfig ${r.config_id.slice(0, 8)} · $${Number(r.trade_amount_usd).toFixed(2)} · ${r.dry_run ? "PAPER" : "LIVE"}`).join("\n\n");
      await ctx.reply(text);
    });

    this.bot.command("unfollow", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const id = ctx.match?.trim();
      if (!id) return void ctx.reply("Usage: /unfollow <config-id>");
      try {
        await this.traders.unfollow(user.id, id);
        await ctx.reply("Trader unfollowed. Its config was returned to PAPER and disabled.");
      } catch (error) {
        await ctx.reply(`Could not unfollow: ${String(error)}`);
      }
    });

    this.bot.command("positions", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const rows = await this.db.listOpenPositions(user.id);
      if (!rows.length) return void ctx.reply("No open positions.");
      for (const p of rows) {
        const kb = new InlineKeyboard().text("Sell 50%", `exit:50:${p.id}`).text("Sell all", `exit:100:${p.id}`);
        await ctx.reply(`${p.mode === "paper" ? "🟡" : "🟢"} ${p.token}\nCost: $${Number(p.cost_usd).toFixed(2)}\nEntry: $${Number(p.avg_entry_price)}\nSource: ${p.handle ? `@${p.handle}` : p.display_name}`, { reply_markup: kb });
      }
    });

    this.bot.command("wallet", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const wallet = await this.db.getCopyWallet(user.id, "solana");
      if (!wallet) return void ctx.reply("No Solana copy wallet is configured for your Telegram account.");
      const [solLamports, usdcRaw] = await Promise.all([
        this.rpc.solBalance(wallet.public_address).catch(() => null),
        this.rpc.tokenBalanceRaw(wallet.public_address, SOLANA_USDC).catch(() => null),
      ]);
      const sol = solLamports == null ? "?" : (Number(solLamports) / 1e9).toFixed(4);
      const usdc = usdcRaw == null ? "?" : (Number(usdcRaw) / 1e6).toFixed(2);
      await ctx.reply(`Copy wallet\n${wallet.public_address}\nUSDC: $${usdc}\nSOL: ${sol}\nSigning key is never stored in Telegram or Postgres.`);
    });

    this.bot.command("pause", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      await this.db.setUserPaused(user.id, true);
      await ctx.reply("⏸ New copied entries are paused. Existing TP/SL/max-hold protection remains active, and manual exits still work.");
    });

    this.bot.command("resume", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      await this.db.setUserPaused(user.id, false);
      await ctx.reply("▶️ Automatic copying is enabled again.");
    });

    this.bot.command("paper", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const id = ctx.match?.trim();
      if (!id) return void ctx.reply("Usage: /paper <config-id>");
      const updated = await this.db.updateCopyConfig(user.id, id, { dryRun: true });
      await ctx.reply(updated ? "Config returned to PAPER mode." : "Config not found.");
    });

    this.bot.command("paperall", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const updated = await this.db.setAllCopyConfigsMode(user.id, true);
      await ctx.reply(`All followed traders returned to PAPER mode (${updated} config${updated === 1 ? "" : "s"}). Existing live positions remain real and manageable.`);
    });

    this.bot.command("live", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const id = ctx.match?.trim();
      if (!id) return void ctx.reply("Usage: /live <config-id>");
      const current = await this.db.getCopyConfig(id);
      if (!current || current.userId !== user.id) return void ctx.reply("Config not found.");
      const kb = new InlineKeyboard().text("I understand — enable LIVE", `confirm_live:${id}`).row().text("Cancel", "noop");
      await ctx.reply("⚠️ LIVE mode can spend real funds from your dedicated copy wallet. Confirm explicitly. New configs never become live automatically.", { reply_markup: kb });
    });

    this.bot.command("liveall", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const rows = await this.db.listUserTraders(user.id);
      if (!rows.length) return void ctx.reply("You are not following any traders yet.");
      const kb = new InlineKeyboard().text("I understand — enable LIVE for all", "confirm_live_all").row().text("Cancel", "noop");
      await ctx.reply(`⚠️ Enable LIVE for all ${rows.length} followed trader${rows.length === 1 ? "" : "s"}?\n\nFuture qualifying entries for any followed trader can spend real funds from your copy wallet. Confirm explicitly.`, { reply_markup: kb });
    });

    this.bot.callbackQuery(/^confirm_live:(.+)$/, async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const id = ctx.match[1];
      const current = await this.db.getCopyConfig(id);
      if (!current || current.userId !== user.id) return void ctx.answerCallbackQuery({ text: "Config not found" });
      const wallet = await this.db.getCopyWallet(user.id, "solana");
      if (!wallet) return void ctx.answerCallbackQuery({ text: "No copy wallet configured" });
      if (!this.config.JUPITER_API_KEY) return void ctx.answerCallbackQuery({ text: "Live trading is not ready: Jupiter API key is missing", show_alert: true });
      try {
        const signer = loadSolanaSigner(wallet.signer_ref);
        if (signer.publicKey.toBase58() !== wallet.public_address) throw new Error("SIGNER_PUBLIC_KEY_MISMATCH");
      } catch (error) {
        return void ctx.answerCallbackQuery({ text: `Live trading is not ready: ${String(error).slice(0, 120)}`, show_alert: true });
      }
      await this.db.updateCopyConfig(user.id, id, { dryRun: false });
      await ctx.editMessageText("🔴 LIVE mode enabled for this config. Real trades may now execute under its rules.");
    });

    this.bot.callbackQuery("confirm_live_all", async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const wallet = await this.db.getCopyWallet(user.id, "solana");
      if (!wallet) return void ctx.answerCallbackQuery({ text: "No copy wallet configured", show_alert: true });
      if (!this.config.JUPITER_API_KEY) return void ctx.answerCallbackQuery({ text: "Live trading is not ready: Jupiter API key is missing", show_alert: true });
      try {
        const signer = loadSolanaSigner(wallet.signer_ref);
        if (signer.publicKey.toBase58() !== wallet.public_address) throw new Error("SIGNER_PUBLIC_KEY_MISMATCH");
      } catch (error) {
        return void ctx.answerCallbackQuery({ text: `Live trading is not ready: ${String(error).slice(0, 120)}`, show_alert: true });
      }
      const updated = await this.db.setAllCopyConfigsMode(user.id, false);
      await ctx.editMessageText(`🔴 LIVE mode enabled for ${updated} followed trader${updated === 1 ? "" : "s"}. Real trades may now execute under their rules.`);
    });

    this.bot.callbackQuery(/^exit:(25|50|75|100):(.+)$/, async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const pct = Number(ctx.match[1]);
      const positionId = ctx.match[2];
      try {
        await this.positions.exit(user.id, positionId, pct, "MANUAL_EXIT");
        await ctx.answerCallbackQuery({ text: `Exit ${pct}% requested` });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: String(error).slice(0, 180), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^position:(.+)$/, async (ctx) => {
      const user = await this.userFromContext(ctx);
      if (!user) return;
      const p = await this.db.getPositionForUser(user.id, ctx.match[1]);
      if (!p) return void ctx.answerCallbackQuery({ text: "Position not found" });
      await ctx.answerCallbackQuery();
      await ctx.reply(`${p.token}\nMode: ${p.mode}\nQty: ${p.qty}\nCost: $${Number(p.cost_usd).toFixed(2)}\nEntry: $${Number(p.avg_entry_price)}`);
    });

    this.bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

    this.bot.command("help", (ctx) => ctx.reply("/follow @handle · /following · /unfollow <config-id> · /positions · /wallet · /login · /pause · /resume · /live <config-id> · /paper <config-id> · /liveall · /paperall"));
  }
}

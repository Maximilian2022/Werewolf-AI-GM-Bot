/**
 * src/server/app.ts
 * WebUI バックエンド Express サーバー
 * - REST API
 * - Discord OAuth2 認証
 * - リアルタイムゲームモニター情報秘匿ロック（ゴースティング防止）
 * - 静的アセット配信
 */
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import lusca from 'lusca';
import * as path from 'node:path';
import { StateManager } from '../state/StateManager.js';
import { SettingsManager } from '../managers/SettingsManager.js';
import { RegulationManager } from '../regulations/RegulationManager.js';
import { RoleRegistry } from '../roles/RoleRegistry.js';
import { TunnelManager } from '../managers/TunnelManager.js';
import { ZoomProfileManager } from '../managers/ZoomProfileManager.js';
import { ZoomService } from '../services/ZoomService.js';
import { AIService } from '../services/AIService.js';
import { Logger } from '../utils/logger.js';

// セッションの型定義拡張
declare module 'express-session' {
  interface SessionData {
    user?: {
      id: string;
      username: string;
      displayName: string;
      discriminator: string;
      avatar: string | null;
      isAdmin: boolean;
    };
    unlockedGameIds?: string[]; // 解除済みゲームIDリスト（ゲーム単位でロック管理）
    gmUnlocked?: boolean;       // 後方互換用
  }
}

export class WebServer {
  private static instance: WebServer;
  private app: express.Application;
  private server: any = null;
  private discordClient: any = null;
  private readonly port: number = 3000;

  private constructor() {
    this.app = express();
    this.setupMiddlewares();
    this.setupRoutes();
  }

  public static getInstance(): WebServer {
    if (!WebServer.instance) {
      WebServer.instance = new WebServer();
    }
    return WebServer.instance;
  }

  private setupMiddlewares() {
    // リバースプロキシ / Cloudflare Tunnel 配下でのプロキシヘッダー信頼
    this.app.set('trust proxy', 1);

    // 全体レートリミッター（DoS・ブルートフォース攻撃防止: CWE-770 / CWE-400 対策）
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15分間
      max: 1500, // 最大1500リクエスト
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_requests', message: 'リクエスト数が上限を超えました。しばらく待ってから再試行してください。' }
    });
    this.app.use(limiter);

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cookieParser());

    // セキュアCookie設定（CWE-614 / CWE-319 対策）
    const isSecureCookie = process.env.COOKIE_INSECURE === 'true' ? false : true;
    this.app.use(session({
      secret: process.env.SESSION_SECRET || 'werewolf-gm-bot-super-secret-key-2026',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: isSecureCookie, // HTTPS / Secure Cookie を強制
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7日間
      }
    }));

    // CSRF 保護ミドルウェア（CWE-352 対策）
    this.app.use(lusca.csrf({
      angular: true, // XSRF-TOKEN クッキーを発行し、x-xsrf-token ヘッダーを検証
      cookie: {
        options: {
          sameSite: 'lax',
          secure: isSecureCookie,
          httpOnly: false // フロントエンドJSがヘッダー付与用に読み取り可能
        }
      }
    }));

    // 静的ファイル配信
    const publicPath = path.join(process.cwd(), 'public');
    this.app.use(express.static(publicPath));
  }


  private setupRoutes() {
    const tunnelMgr = TunnelManager.getInstance();
    const regMgr = RegulationManager.getInstance();
    const roleReg = RoleRegistry.getInstance();
    const settingsMgr = SettingsManager.getInstance();
    const stateMgr = StateManager.getInstance();

    // 管理者判定関数
    const checkIsAdmin = async (userId: string): Promise<boolean> => {
      // 1. 環境変数 ADMIN_USER_IDS の確認
      const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.includes(userId)) return true;

      // 2. Discord Client からギルドの管理者権限またはオーナー判定
      if (this.discordClient) {
        try {
          const testGuildId = process.env.TEST_GUILD_ID;
          const guild = testGuildId ? this.discordClient.guilds.cache.get(testGuildId) : this.discordClient.guilds.cache.first();
          if (guild) {
            if (guild.ownerId === userId) return true;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && member.permissions.has('Administrator')) {
              return true;
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. 管理者ID設定がなくギルドも未指定の場合（ローカル開発時）
      if (adminIds.length === 0 && !process.env.TEST_GUILD_ID) {
        return true;
      }

      return false;
    };

    // 認証必須ミドルウェア (Discordログインが必要)
    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
      if (req.session && req.session.user) {
        return next();
      }
      return res.status(401).json({ error: 'unauthorized', message: 'Discordログインが必要です' });
    };

    // 管理者権限必須ミドルウェア
    const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
      if (req.session && req.session.user && req.session.user.isAdmin) {
        return next();
      }
      return res.status(403).json({ error: 'forbidden', message: '管理者権限が必要です。' });
    };

    // ==========================================
    // 1. 認証エンドポイント (Discord OAuth2)
    // ==========================================
    this.app.get('/api/auth/config', (req: Request, res: Response) => {
      const config = tunnelMgr.getConfig();
      const clientId = config.discordClientId || process.env.DISCORD_CLIENT_ID;
      const clientSecret = config.discordClientSecret || process.env.DISCORD_CLIENT_SECRET;
      res.json({
        configured: Boolean(clientId && clientSecret),
        clientId: clientId || ''
      });
    });

    this.app.get('/api/auth/discord/login', (req: Request, res: Response) => {
      const config = tunnelMgr.getConfig();
      const clientId = config.discordClientId || process.env.DISCORD_CLIENT_ID;
      const redirectUri = config.discordRedirectUri || (config.fqdn ? `https://${config.fqdn}/api/auth/discord/callback` : `http://localhost:${this.port}/api/auth/discord/callback`);

      if (!clientId) {
        return res.status(400).send('Discord Client ID が設定されていません。WebUIの設定画面から設定してください。');
      }

      const scope = encodeURIComponent('identify');
      const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
      res.redirect(discordAuthUrl);
    });

    this.app.get('/api/auth/discord/callback', async (req: Request, res: Response) => {
      const code = req.query.code as string;
      if (!code) {
        return res.status(400).send('認可コードが取得できませんでした。');
      }

      const config = tunnelMgr.getConfig();
      const clientId = config.discordClientId || process.env.DISCORD_CLIENT_ID;
      const clientSecret = config.discordClientSecret || process.env.DISCORD_CLIENT_SECRET;
      const redirectUri = config.discordRedirectUri || (config.fqdn ? `https://${config.fqdn}/api/auth/discord/callback` : `http://localhost:${this.port}/api/auth/discord/callback`);

      if (!clientId || !clientSecret) {
        return res.status(500).send('Discord Client ID または Secret が未設定です。');
      }

      try {
        // トークン取得
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
          })
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          Logger.error('WebServer', 'Discord OAuth トークン取得失敗', tokenData);
          return res.status(401).send('Discord 認証に失敗しました。');
        }

        // ユーザー情報取得
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userRes.json();
        const isAdmin = await checkIsAdmin(userData.id);

        let displayName = userData.global_name || userData.username;
        if (this.discordClient) {
          try {
            const testGuildId = process.env.TEST_GUILD_ID;
            const guild = testGuildId ? this.discordClient.guilds.cache.get(testGuildId) : this.discordClient.guilds.cache.first();
            if (guild) {
              const member = await guild.members.fetch(userData.id).catch(() => null);
              if (member) {
                displayName = member.displayName || member.nickname || displayName;
              }
            }
          } catch {}
        }

        req.session.user = {
          id: userData.id,
          username: userData.username,
          displayName,
          discriminator: userData.discriminator || '0',
          avatar: userData.avatar,
          isAdmin
        };

        res.redirect('/?login=success');
      } catch (err: any) {
        Logger.error('WebServer', 'Discord OAuth コールバック例外', err);
        res.status(500).send('認証処理中にエラーが発生しました。');
      }
    });

    this.app.get('/api/auth/me', (req: Request, res: Response) => {
      const user = req.session.user || null;
      res.json({
        user,
        authenticated: Boolean(user),
        isAdmin: Boolean(user && user.isAdmin)
      });
    });

    this.app.post('/api/auth/logout', (req: Request, res: Response) => {
      req.session.destroy(() => {
        res.json({ success: true });
      });
    });

    // ==========================================
    // 2. リアルタイムゲームモニター API (ゲーム単位ロック & 解除通知)
    // ==========================================
    // アクティブなゲーム一覧取得
    this.app.get('/api/game/games', (req: Request, res: Response) => {
      const games = stateMgr.getAllActiveGames();
      const unlockedIds = req.session.unlockedGameIds || [];
      const isAdmin = Boolean(req.session.user?.isAdmin);

      const summary = games.map(g => ({
        gameId: g.gameId,
        platform: g.platform || 'discord',
        day: g.day,
        phase: g.phase,
        playerCount: g.players ? g.players.length : 0,
        aliveCount: g.players ? g.players.filter(p => p.isAlive).length : 0,
        isLocked: (g.phase !== 'setup' && g.phase !== 'finished') && !isAdmin && !unlockedIds.includes(g.gameId)
      }));

      res.json(summary);
    });

    this.app.get('/api/game/state', (req: Request, res: Response) => {
      const queryGameId = req.query.gameId as string | undefined;
      const state = stateMgr.getStateSafe(queryGameId);
      const user = req.session.user;
      const unlockedIds = req.session.unlockedGameIds || [];
      const isGmUnlocked = Boolean(
        user?.isAdmin ||
        (state && unlockedIds.includes(state.gameId)) ||
        req.session.gmUnlocked
      );

      // 試合が開催されていない場合
      if (!state || !state.gameId) {
        return res.json({
          hasActiveGame: false,
          locked: false,
          state: null
        });
      }

      // ゲーム進行中（感想戦・終了以外）のアクセス制限判定
      const isGameActive = state.phase !== 'setup' && state.phase !== 'finished';

      if (isGameActive && !isGmUnlocked) {
        // Discord参加プレイヤーとしてログイン中の場合
        const isParticipant = user ? state.players.some(p => p.userId === user.id) : false;
        if (isParticipant) {
          return res.json({
            hasActiveGame: true,
            gameId: state.gameId,
            locked: true,
            lockReason: 'participant_locked',
            message: '⚠️ あなたは現在ゲームに参加中のプレイヤーです。\n公平性と情報秘匿を保つため、ゲーム終了（感想戦）までゲームモニターは閲覧できません。',
            phase: state.phase,
            day: state.day,
            currentRole: '秘匿中'
          });
        }

        // 未解除のアクセス者（案A: Discordログイン＆GMパスコードによる解除を要求）
        return res.json({
          hasActiveGame: true,
          gameId: state.gameId,
          locked: true,
          lockReason: 'gm_passcode_required',
          message: '🔒 人狼ゲーム進行中（情報保護ロック）\n役職や夜の行動などの機密情報を保護しています。GMまたは観戦者の方はDiscordログインの上、GMパスコードを入力して解除してください。',
          phase: state.phase,
          day: state.day,
          platform: state.platform || 'discord'
        });
      }

      // GMパスコード解除済み、管理者、またはゲーム終了後はフルデータを返却
      res.json({
        hasActiveGame: true,
        gameId: state.gameId,
        locked: false,
        isGmUnlocked,
        state
      });
    });

    // GMパスコード認証・解除（ゲーム単位 & Zoom/Discord通知）
    this.app.post('/api/game/unlock', async (req: Request, res: Response) => {
      const { gameId, passcode } = req.body;
      const user = req.session.user;

      // Discordログイン前提
      if (!user) {
        return res.status(401).json({
          success: false,
          requireLogin: true,
          error: 'GMパスコードを解除するには、まずDiscordアカウントでログインしてください。'
        });
      }

      const targetGameId = gameId || stateMgr.getStateSafe()?.gameId;
      if (!targetGameId) {
        return res.status(400).json({ success: false, error: '解除対象のゲームが見つかりません。' });
      }

      const correctPasscode = settingsMgr.getSystem().gmPasscode || '1234';
      if (passcode !== undefined && String(passcode).trim() === String(correctPasscode).trim()) {
        if (!req.session.unlockedGameIds) {
          req.session.unlockedGameIds = [];
        }
        if (!req.session.unlockedGameIds.includes(targetGameId)) {
          req.session.unlockedGameIds.push(targetGameId);
        }
        req.session.gmUnlocked = true;

        // 全体チャットへの通知文（サーバーネーム表示）
        const serverName = user.displayName || user.username;
        const announcementMsg = `📢 【ゲームモニター解除】${serverName} さんがゲーム（${targetGameId}）の役職秘匿ロックを解除しました。`;

        // 1. Zoomミーティングの全体テキストチャットへ通知
        try {
          const zService = ZoomService.getInstance();
          zService.sendChatMessage(announcementMsg);
        } catch (zErr: any) {
          Logger.warn('WebServer', `Zoom全体チャット通知送信エラー: ${zErr?.message || zErr}`);
        }

        // 2. Discordのテキストチャンネルへ通知
        const gState = stateMgr.getStateSafe(targetGameId);
        if (gState && gState.voteChannelId && this.discordClient) {
          try {
            const ch = await this.discordClient.channels.fetch(gState.voteChannelId).catch(() => null);
            if (ch && ch.isTextBased()) {
              await ch.send(announcementMsg);
            }
          } catch {}
        }

        Logger.info('WebServer', `ゲームモニターが解除されました: ${serverName} (${user.id}) -> ${targetGameId}`);
        res.json({ success: true, message: `ゲーム [${targetGameId}] のGM認証に成功しました。全体チャットへ通知しました。` });
      } else {
        res.status(401).json({ success: false, error: 'GMパスコードが正しくありません。' });
      }
    });

    // GMモニターの再ロック
    this.app.post('/api/game/relock', (req: Request, res: Response) => {
      const { gameId } = req.body;
      const targetGameId = gameId || stateMgr.getStateSafe()?.gameId;
      if (targetGameId && req.session.unlockedGameIds) {
        req.session.unlockedGameIds = req.session.unlockedGameIds.filter(id => id !== targetGameId);
      }
      req.session.gmUnlocked = false;
      res.json({ success: true, message: 'ゲームモニターを再ロックしました。' });
    });

    // ==========================================
    // 3. レギュレーション & 役職 API (認証必須)
    // ==========================================
    this.app.get('/api/roles', requireAuth, (req: Request, res: Response) => {
      res.json(roleReg.getAll());
    });

    this.app.get('/api/regulations', requireAuth, (req: Request, res: Response) => {
      res.json(regMgr.getAll());
    });

    this.app.post('/api/regulations', requireAuth, (req: Request, res: Response) => {
      const newReg = req.body;
      if (!newReg.id) {
        newReg.id = `custom_${Date.now()}`;
      }
      const result = regMgr.saveCustom(newReg);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, regulation: regMgr.get(newReg.id) });
    });

    this.app.delete('/api/regulations/:id', requireAuth, (req: Request, res: Response) => {
      const id = req.params.id as string;
      const success = regMgr.deleteCustom(id);
      res.json({ success });
    });

    // ==========================================
    // 4. ゲーム設定 & AIモデル API (認証必須)
    // ==========================================
    this.app.get('/api/settings', requireAuth, (req: Request, res: Response) => {
      res.json({
        normal: settingsMgr.get(false),
        debug: settingsMgr.get(true),
        system: settingsMgr.getSystem()
      });
    });

    this.app.post('/api/settings', requireAuth, (req: Request, res: Response) => {
      const { normal, debug, system } = req.body;
      if (normal) settingsMgr.update(false, normal);
      if (debug) settingsMgr.update(true, debug);
      if (system) settingsMgr.updateSystem(system);
      res.json({ success: true });
    });

    this.app.get('/api/ai/models', requireAuth, async (req: Request, res: Response) => {
      const models = await AIService.getAvailableModels();
      res.json(models);
    });

    // ==========================================
    // 5. Cloudflare Tunnel 管理 API (管理者権限必須)
    // ==========================================
    this.app.get('/api/tunnel', requireAdmin, (req: Request, res: Response) => {
      const status = tunnelMgr.getStatus();
      const config = tunnelMgr.getConfig();
      res.json({
        ...status,
        config: {
          fqdn: config.fqdn,
          autoStart: config.autoStart,
          hasToken: Boolean(config.token && config.token.length > 0),
          discordClientId: config.discordClientId || '',
          hasDiscordSecret: Boolean(config.discordClientSecret && config.discordClientSecret.length > 0),
          discordRedirectUri: config.discordRedirectUri || ''
        }
      });
    });

    this.app.post('/api/tunnel/config', requireAdmin, (req: Request, res: Response) => {
      const { token, fqdn, autoStart, discordClientId, discordClientSecret, discordRedirectUri } = req.body;
      const updates: any = {};
      if (token !== undefined) updates.token = token;
      if (fqdn !== undefined) updates.fqdn = fqdn;
      if (autoStart !== undefined) updates.autoStart = autoStart;
      if (discordClientId !== undefined) updates.discordClientId = discordClientId;
      if (discordClientSecret !== undefined && discordClientSecret.length > 0) updates.discordClientSecret = discordClientSecret;
      if (discordRedirectUri !== undefined) updates.discordRedirectUri = discordRedirectUri;

      tunnelMgr.saveConfig(updates);
      res.json({ success: true, status: tunnelMgr.getStatus() });
    });

    this.app.post('/api/tunnel/start', requireAdmin, async (req: Request, res: Response) => {
      const result = await tunnelMgr.start();
      res.json(result);
    });

    this.app.post('/api/tunnel/stop', requireAdmin, async (req: Request, res: Response) => {
      const result = await tunnelMgr.stop();
      res.json(result);
    });

    // ==========================================
    // 6. Zoom 連携 API (認証必須)
    // ==========================================
    const zoomProfileMgr = ZoomProfileManager.getInstance();
    const zoomService = ZoomService.getInstance();

    this.app.get('/api/zoom/profiles', requireAuth, (req: Request, res: Response) => {
      res.json(zoomProfileMgr.getMaskedProfiles());
    });

    this.app.post('/api/zoom/profiles', requireAuth, async (req: Request, res: Response) => {
      try {
        const { id, name, clientId, clientSecret, defaultHostKey } = req.body;
        if (!name || !clientId) {
          return res.status(400).json({ error: 'プロファイル名とClient IDは必須です' });
        }
        const saved = await zoomProfileMgr.saveProfile({ id, name, clientId, clientSecret, defaultHostKey });
        res.json({ success: true, profile: { ...saved, clientSecret: undefined } });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.delete('/api/zoom/profiles/:id', requireAuth, async (req: Request, res: Response) => {
      const success = await zoomProfileMgr.deleteProfile(req.params.id as string);
      res.json({ success });
    });

    this.app.get('/api/zoom/status', requireAuth, (req: Request, res: Response) => {
      res.json({
        ...zoomService.getStatus(),
        chatLogs: zoomService.getChatLogs(),
      });
    });

    this.app.post('/api/zoom/parse-url', requireAuth, (req: Request, res: Response) => {
      const { url } = req.body;
      const parsed = ZoomService.parseZoomUrl(url || '');
      res.json({ parsed });
    });

    this.app.post('/api/zoom/join', requireAuth, async (req: Request, res: Response) => {
      const { profileId, meetingNumber, passcode, hostKey, enableAIRecording, botName } = req.body;
      if (!profileId || !meetingNumber) {
        return res.status(400).json({ error: 'プロファイルとミーティング番号は必須です' });
      }
      const result = await zoomService.joinMeeting({
        profileId,
        meetingNumber,
        passcode: passcode || '',
        hostKey: hostKey || undefined,
        enableAIRecording: Boolean(enableAIRecording),
        botName: botName || '人狼ゲームマスター',
      });
      res.json(result);
    });

    this.app.post('/api/zoom/leave', requireAuth, async (req: Request, res: Response) => {
      await zoomService.leaveMeeting();
      res.json({ success: true });
    });

    this.app.post('/api/zoom/chat', requireAuth, (req: Request, res: Response) => {
      const { message, targetUserId } = req.body;
      if (!message) return res.status(400).json({ error: 'メッセージは必須です' });
      zoomService.sendChatMessage(message, targetUserId);
      res.json({ success: true });
    });

    // ==========================================
    // 7. Zoom 仮想シミュレータ API (デバッグモード)
    // ==========================================
    this.app.post('/api/zoom/mock/start', requireAuth, (req: Request, res: Response) => {
      const count = parseInt(req.body.count) || 7;
      const result = zoomService.startMockSimulation(count);
      res.json(result);
    });

    this.app.post('/api/zoom/mock/stop', requireAuth, (req: Request, res: Response) => {
      zoomService.stopMockSimulation();
      res.json({ success: true, message: '仮想シミュレータを停止しました' });
    });

    this.app.post('/api/zoom/mock/chat', requireAuth, (req: Request, res: Response) => {
      const { senderUserId, message } = req.body;
      zoomService.sendMockUserChat(senderUserId, message || '');
      res.json({ success: true });
    });

    // SPA フォールバック (未マッチのルートはHTMLへ)
    this.app.use((req: Request, res: Response) => {
      res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
    });
  }

  public start(discordClient?: any) {
    if (discordClient) {
      this.discordClient = discordClient;
    }
    this.server = this.app.listen(this.port, '0.0.0.0', () => {
      Logger.info('WebServer', `🌐 WebUI サーバーがポート ${this.port} で起動しました (http://0.0.0.0:${this.port})`);
      
      // 自動起動がONならTunnelを起動
      const config = TunnelManager.getInstance().getConfig();
      if (config.autoStart && config.token) {
        TunnelManager.getInstance().start().catch(() => {});
      }
    });
  }

  public stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

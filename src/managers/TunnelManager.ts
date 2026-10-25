/**
 * src/managers/TunnelManager.ts
 * Cloudflare Tunnel (cloudflared) のプロセス起動・停止・死活監視・設定永続化を行うマネージャー
 */
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../utils/logger.js';

export interface TunnelConfig {
  token: string;
  fqdn: string; // 例: gm.example.com
  autoStart: boolean;
  discordClientId?: string;
  discordClientSecret?: string;
  discordRedirectUri?: string;
}

export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

export class TunnelManager {
  private static instance: TunnelManager;
  private process: ChildProcess | null = null;
  private status: TunnelStatus = 'stopped';
  private lastLogs: string[] = [];
  private readonly configPath = path.join(process.cwd(), 'data', 'tunnel.json');
  private config: TunnelConfig = {
    token: '',
    fqdn: '',
    autoStart: false,
    discordClientId: '',
    discordClientSecret: '',
    discordRedirectUri: ''
  };

  private constructor() {
    this.loadConfig();
  }

  public static getInstance(): TunnelManager {
    if (!TunnelManager.instance) {
      TunnelManager.instance = new TunnelManager();
    }
    return TunnelManager.instance;
  }

  public loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        this.config = { ...this.config, ...JSON.parse(raw) };
      }
    } catch (e: any) {
      Logger.error('TunnelManager', 'Tunnel設定の読み込みに失敗しました', e);
    }
  }

  public saveConfig(newConfig: Partial<TunnelConfig>) {
    this.config = { ...this.config, ...newConfig };
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (e: any) {
      Logger.error('TunnelManager', 'Tunnel設定の保存に失敗しました', e);
    }
  }

  public getConfig(): TunnelConfig {
    return { ...this.config };
  }

  public getStatus(): { status: TunnelStatus; fqdn: string; publicUrl: string | null; logs: string[] } {
    const publicUrl = this.config.fqdn ? `https://${this.config.fqdn}` : null;
    return {
      status: this.status,
      fqdn: this.config.fqdn,
      publicUrl: this.status === 'running' ? publicUrl : null,
      logs: this.lastLogs.slice(-20)
    };
  }

  public getPublicUrl(): string | null {
    if (!this.config.fqdn) return null;
    return `https://${this.config.fqdn}`;
  }

  public async start(): Promise<{ success: boolean; message: string }> {
    if (this.status === 'running' || this.status === 'starting') {
      return { success: false, message: 'Tunnelは既に起動中または起動処理中です。' };
    }

    if (!this.config.token || this.config.token.trim().length === 0) {
      return { success: false, message: 'Cloudflare Tunnel Tokenが設定されていません。' };
    }

    const token = this.config.token.trim();
    this.status = 'starting';
    this.lastLogs = [];
    this.log(`[TunnelManager] cloudflared トンネルを起動しています...`);

    try {
      // 安全な配列引数での spawn (シェルインジェクション防止)
      this.process = spawn('cloudflared', ['tunnel', 'run', '--token', token]);

      this.process.stdout?.on('data', (data) => {
        const str = data.toString();
        this.log(str);
      });

      this.process.stderr?.on('data', (data) => {
        const str = data.toString();
        this.log(str);

        // 接続成功キーワード検知
        if (str.includes('Registered tunnel connection') || str.includes('Connected to') || str.includes('Connection registered')) {
          if (this.status !== 'running') {
            this.status = 'running';
            this.log(`[TunnelManager] ✅ Cloudflare Tunnel接続が確立されました！`);
          }
        }
      });

      this.process.on('close', (code) => {
        this.log(`[TunnelManager] cloudflared プロセスが終了しました (Code: ${code})`);
        this.status = code === 0 ? 'stopped' : 'error';
        this.process = null;
      });

      this.process.on('error', (err) => {
        this.log(`[TunnelManager] プロセス起動エラー: ${err.message}`);
        this.status = 'error';
        this.process = null;
      });

      // 3秒待って即死していないか確認
      await new Promise(r => setTimeout(r, 3000));
      if ((this.status as string) === 'error') {
        return { success: false, message: 'cloudflaredの起動に失敗しました。cloudflaredがインストールされているか確認してください。' };
      }

      // 起動プロセスが継続していればひとまず成功（接続待ちまたは接続完了）
      if ((this.status as string) === 'starting') {
        // バックグラウンドで接続確認を継続しつつOKを返す
        this.status = 'running';
      }

      return { success: true, message: 'Cloudflare Tunnelを起動しました。' };
    } catch (e: any) {
      this.status = 'error';
      this.log(`[TunnelManager] 起動例外: ${e.message}`);
      return { success: false, message: `起動例外が発生しました: ${e.message}` };
    }
  }

  public async stop(): Promise<{ success: boolean; message: string }> {
    if (!this.process) {
      this.status = 'stopped';
      return { success: true, message: 'Tunnelは停止しています。' };
    }

    try {
      this.process.kill('SIGTERM');
      this.process = null;
      this.status = 'stopped';
      this.log(`[TunnelManager] Tunnelを停止しました。`);
      return { success: true, message: 'Tunnelを停止しました。' };
    } catch (e: any) {
      return { success: false, message: `停止中にエラーが発生しました: ${e.message}` };
    }
  }

  private log(message: string) {
    const lines = message.split('\n').filter(l => l.trim().length > 0);
    for (const l of lines) {
      this.lastLogs.push(`[${new Date().toLocaleTimeString('ja-JP')}] ${l}`);
      if (this.lastLogs.length > 100) this.lastLogs.shift();
    }
    Logger.info('TunnelManager', message);
  }
}

/**
 * src/managers/ZoomProfileManager.ts
 * Zoom Private App（Meeting SDK）のプロファイル管理および署名生成マネージャー
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ZoomProfile } from '../types.js';
import { Logger } from '../utils/logger.js';

export class ZoomProfileManager {
  private static instance: ZoomProfileManager;
  private readonly filePath = path.join(process.cwd(), 'data', 'zoom_profiles.json');
  private profiles: Map<string, ZoomProfile> = new Map();

  private constructor() {
    this.loadProfiles();
  }

  public static getInstance(): ZoomProfileManager {
    if (!ZoomProfileManager.instance) {
      ZoomProfileManager.instance = new ZoomProfileManager();
    }
    return ZoomProfileManager.instance;
  }

  /**
   * プロファイル一覧をファイルからロード
   */
  private loadProfiles(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const list: ZoomProfile[] = JSON.parse(raw);
        this.profiles.clear();
        for (const p of list) {
          this.profiles.set(p.id, p);
        }
        Logger.info('ZoomProfileManager', `Zoomプロファイルをロードしました: ${this.profiles.size} 件`);
      }
    } catch (err: any) {
      Logger.error('ZoomProfileManager', `プロファイルの読み込みに失敗しました: ${err.message}`);
    }
  }

  /**
   * プロファイル一覧をファイルへアトミック保存
   */
  private async saveProfilesAsync(): Promise<void> {
    try {
      const tempPath = `${this.filePath}.tmp`;
      const list = Array.from(this.profiles.values());
      await fs.promises.writeFile(tempPath, JSON.stringify(list, null, 2), 'utf-8');
      await fs.promises.rename(tempPath, this.filePath);
    } catch (err: any) {
      Logger.error('ZoomProfileManager', `プロファイルの保存に失敗しました: ${err.message}`);
    }
  }

  /**
   * WebUI・API返却用（clientSecretをマスクしたプロファイル一覧）
   */
  public getMaskedProfiles(): (Omit<ZoomProfile, 'clientSecret'> & { clientSecretMasked: string })[] {
    return Array.from(this.profiles.values()).map(p => ({
      id: p.id,
      name: p.name,
      clientId: p.clientId,
      clientSecretMasked: this.maskSecret(p.clientSecret),
      defaultHostKey: p.defaultHostKey,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  /**
   * 署名生成用のフルプロファイル（秘密鍵含む）取得
   */
  public getProfile(id: string): ZoomProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * プロファイルの作成・更新
   */
  public async saveProfile(data: {
    id?: string;
    name: string;
    clientId: string;
    clientSecret?: string;
    defaultHostKey?: string;
  }): Promise<ZoomProfile> {
    const now = new Date().toISOString();
    const id = data.id || `zoom_prof_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const existing = this.profiles.get(id);

    // clientSecretが未指定（マスクされたままの更新）の場合は既存のSecretを保持
    let secret = data.clientSecret?.trim() || '';
    if ((!secret || secret.startsWith('****')) && existing) {
      secret = existing.clientSecret;
    }

    if (!secret) {
      throw new Error('Client Secret は必須です');
    }

    const profile: ZoomProfile = {
      id,
      name: data.name.trim(),
      clientId: data.clientId.trim(),
      clientSecret: secret,
      defaultHostKey: data.defaultHostKey?.trim() || undefined,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.profiles.set(id, profile);
    await this.saveProfilesAsync();
    Logger.info('ZoomProfileManager', `Zoomプロファイルを保存しました: [${profile.name}] (${id})`);
    return profile;
  }

  /**
   * プロファイルの削除
   */
  public async deleteProfile(id: string): Promise<boolean> {
    const deleted = this.profiles.delete(id);
    if (deleted) {
      await this.saveProfilesAsync();
      Logger.info('ZoomProfileManager', `Zoomプロファイルを削除しました: ${id}`);
    }
    return deleted;
  }

  /**
   * Zoom Meeting SDK 接続用署名（Signature: JWT / HMAC-SHA256）の生成
   */
  public generateSignature(profileId: string, meetingNumber: string, role: number = 0): string {
    const profile = this.getProfile(profileId);
    if (!profile) {
      throw new Error(`Zoomプロファイルが見つかりません: ${profileId}`);
    }

    const cleanMeetingNumber = meetingNumber.replace(/\s+/g, '');
    const iat = Math.floor(Date.now() / 1000) - 30; // 30秒前のクロックスキュー許容
    const exp = iat + 60 * 60 * 2; // 2時間有効

    const oHeader = { alg: 'HS256', typ: 'JWT' };
    const oPayload = {
      appKey: profile.clientId,
      sdkKey: profile.clientId,
      mn: cleanMeetingNumber,
      role, // 0: 参加者, 1: ホスト
      iat,
      exp,
      tokenExp: exp,
    };

    const sHeader = Buffer.from(JSON.stringify(oHeader)).toString('base64url');
    const sPayload = Buffer.from(JSON.stringify(oPayload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', profile.clientSecret)
      .update(`${sHeader}.${sPayload}`)
      .digest('base64url');

    return `${sHeader}.${sPayload}.${signature}`;
  }

  private maskSecret(secret: string): string {
    if (!secret || secret.length <= 6) return '******';
    return `****${secret.slice(-4)}`;
  }
}

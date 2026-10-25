/**
 * src/managers/SettingsManager.ts
 * ゲームの設定を管理するシングルトンマネージャー
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../utils/logger.js';

// 各フェーズの制限時間設定
export interface GameSettings {
  day1DiscussionMin: number;    // 1日目の昼の話し合い時間（単位：分）
  day2DiscussionMin: number;    // 2日目以降の昼の話し合い時間（単位：分）
  dayDecreaseMin: number;       // 日数が進むごとに昼の話し合い時間をどれだけ減らすか（単位：分）
  wolfMeetingMin: number;       // 人狼会議の時間（分）
  actionTimeoutMin: number;     // 夜の行動のタイムアウト時間（分）
  handRaiseTimeoutSec: number;  // 挙手のタイムアウト時間（秒）
  speechMin: number;            // 発言時間の最小値（単位：分）
  lastWordMin: number;          // 最後の発言時間（単位：分）
  cleanupDelayMin: number;      // クリーンアップの遅延時間（単位：分）
  dataDeletionDays: number;     // セーブデータの保持期間（日数）
  runoffDefenseMin: number;     // 決選弁明時間（単位：分）
  runoffVoteTimeoutMin: number; // 決選投票時間（単位：分）
}

export interface SystemSettings {
  gmVoice: string; 
  aiModel: string;   
  mvpMode: 'discussion' | 'contribution' | 'compare';
  aiTone: 'gentle' | 'normal' | 'spicy' | 'extreme'; 
  regulation: string; 
  enableAIRecording?: boolean; // 🎙️ AI総評・音声録音の有効化（デフォルト true）
  enableRegulationAnnouncement?: boolean; // 📜 ゲーム開始時のレギュレーション読み上げ有効化（デフォルト true）
  gmPasscode?: string;        // 🔑 進行中モニター解除用パスコード（デフォルト '1234'）
}

export interface AppSettings {
  normal: GameSettings;
  debug: GameSettings;
  system: SystemSettings;
}

const DEFAULT_SETTINGS: AppSettings = {
  normal: { 
    day1DiscussionMin: 5, 
    day2DiscussionMin: 4,
    dayDecreaseMin: 1,
    wolfMeetingMin: 1,
    actionTimeoutMin: 1,
    handRaiseTimeoutSec: 15,
    speechMin: 1,
    lastWordMin: 1,
    cleanupDelayMin: 1,
    dataDeletionDays: 7,
    runoffDefenseMin: 1,     
    runoffVoteTimeoutMin: 1  
  },
  debug: {
    day1DiscussionMin: 0.166, 
    day2DiscussionMin: 0.166,
    dayDecreaseMin: 0,
    wolfMeetingMin: 0.166,
    actionTimeoutMin: 0.166,
    handRaiseTimeoutSec: 2,
    speechMin: 0.083,
    lastWordMin: 0.083,
    cleanupDelayMin: 0.083,
    dataDeletionDays: 1,
    runoffDefenseMin: 0.083,     
    runoffVoteTimeoutMin: 0.083  
  },
  system: {
    gmVoice: 'ja-JP-Neural2-D',
    aiModel: 'gemini-flash-latest',
    mvpMode: 'compare',
    aiTone: 'normal',
    regulation: '標準レギュレーション（11人/13人）',
    enableAIRecording: true,
    enableRegulationAnnouncement: true,
    gmPasscode: '1234'
  }
};
// ゲームの設定を管理するシングルトンマネージャー。設定は通常モードとデバッグモードの両方を持ち、さらにシステム全体で使用される設定も管理する。設定はJSONファイルに保存され、アプリケーションの起動時に読み込まれる。設定の更新やリセットも可能で、更新が行われるたびにファイルに保存される。設定の取得は、現在のモード（通常/デバッグ）に応じて適切な設定を返す。

export class SettingsManager {
  private static instance: SettingsManager;
  private settings: AppSettings;
  private readonly savePath = path.join(process.cwd(), 'data', 'settings.json');

  private constructor() {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  public load() {
    if (fs.existsSync(this.savePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.savePath, 'utf-8'));
        this.settings = {
          normal: { ...DEFAULT_SETTINGS.normal, ...(parsed.normal || {}) },
          debug: { ...DEFAULT_SETTINGS.debug, ...(parsed.debug || {}) },
          system: { ...DEFAULT_SETTINGS.system, ...(parsed.system || {}) }
        };
        // 互換性維持：設定ファイルに古い属性しかない場合の補完
        if (!this.settings.system.aiTone) this.settings.system.aiTone = 'normal';
        if (this.settings.system.gmVoice === 'male') this.settings.system.gmVoice = 'ja-JP-Neural2-D';
        if (this.settings.system.gmVoice === 'female') this.settings.system.gmVoice = 'ja-JP-Neural2-B';
        if (this.settings.system.aiModel === 'gemini-1.5-flash' || !this.settings.system.aiModel) this.settings.system.aiModel = 'gemini-flash-latest';
      } catch(e) { 
        Logger.error('SettingsManager', '設定の解析に失敗しました。デフォルト値を使用します。'); 
        this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      }
    } else {
      this.save();
    }
  }

  public save() {
    if (!fs.existsSync(path.dirname(this.savePath))) fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
    fs.writeFileSync(this.savePath, JSON.stringify(this.settings, null, 2));
  }

  public get(isDebug: boolean): GameSettings { return isDebug ? this.settings.debug : this.settings.normal; }
  public getSystem(): SystemSettings { return this.settings.system; }

  public update(isDebug: boolean, newSet: Partial<GameSettings>) {
    if (isDebug) {
        this.settings.debug = { ...this.settings.debug, ...newSet };
    } else {
        this.settings.normal = { ...this.settings.normal, ...newSet };
    }
    this.save();
  }

  public updateSystem(newSet: Partial<SystemSettings>) {
    this.settings.system = { ...this.settings.system, ...newSet };
    this.save();
    // モデルなどが変更された可能性があるので、静的セリフを再プリフェッチする
    import('../services/TTSService.js').then(m => m.TTSService.prefetchStaticAudios()).catch(() => {});
  }

  public reset() {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.save();
  }
}
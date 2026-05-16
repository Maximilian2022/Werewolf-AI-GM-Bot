/**
 * src/managers/SettingsManager.ts
 * 決選投票のオプション設定対応版
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../utils/logger.js';

// 各フェーズの制限時間設定
export interface GameSettings {
  day1DiscussionMin: number;
  day2DiscussionMin: number;
  dayDecreaseMin: number; 
  wolfMeetingMin: number;
  actionTimeoutMin: number;
  handRaiseTimeoutSec: number; 
  speechMin: number;        
  lastWordMin: number;      
  cleanupDelayMin: number;  
  dataDeletionDays: number; 
  runoffDefenseMin: number;     // 🚨 新規追加：決選弁明時間（単位：分）
  runoffVoteTimeoutMin: number; // 🚨 新規追加：決選投票時間（単位：分）
}

export interface SystemSettings {
  gmVoice: string; 
  aiModel: string;   
  mvpMode: 'discussion' | 'contribution' | 'compare';
  aiTone: 'gentle' | 'normal' | 'spicy' | 'extreme'; 
  regulation: string; 
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
    runoffDefenseMin: 1,     // 🚨 通常時は1分
    runoffVoteTimeoutMin: 1  // 🚨 通常時は1分
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
    runoffDefenseMin: 0.083,     // 🚨 デバッグ時は5秒 (5/60分)
    runoffVoteTimeoutMin: 0.083  // 🚨 デバッグ時は5秒 (5/60分)
  },
  system: {
    gmVoice: 'ja-JP-Neural2-D',
    aiModel: 'gemini-1.5-flash',
    mvpMode: 'compare',
    aiTone: 'normal',
    regulation: '標準レギュレーション（11人/13人）'
  }
};

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
  }

  public reset() {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.save();
  }
}
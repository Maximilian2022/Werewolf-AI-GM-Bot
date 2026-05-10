/**
 * src/managers/SettingsManager.ts
 * 差分補完（ディープマージ）＆ デフォルト値修正版
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

export interface GameSettings {
  day1DiscussionMin: number;
  day2DiscussionMin: number;
  dayDecreaseMin: number; // 毎日の短縮時間
  wolfMeetingMin: number;
  actionTimeoutMin: number;
}

export interface SystemSettings {
  gmVoice: string; 
}

export interface AppSettings {
  normal: GameSettings;
  debug: GameSettings;
  system: SystemSettings;
}

// 🚨 ご要望通りデフォルト値を変更（通常: 1分短縮、デバッグ: 0分短縮）
const DEFAULT_SETTINGS: AppSettings = {
  normal: { day1DiscussionMin: 5, day2DiscussionMin: 4, dayDecreaseMin: 1, wolfMeetingMin: 1, actionTimeoutMin: 1 },
  debug: { day1DiscussionMin: 0.166, day2DiscussionMin: 0.166, dayDecreaseMin: 0, wolfMeetingMin: 0.25, actionTimeoutMin: 0.25 },
  system: { gmVoice: 'male' }
};

export class SettingsManager {
  private static instance: SettingsManager;
  private settings: AppSettings;
  private readonly savePath = path.join(process.cwd(), 'data', 'settings.json');

  private constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.load();
  }

  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) SettingsManager.instance = new SettingsManager();
    return SettingsManager.instance;
  }

  public load() {
    if (fs.existsSync(this.savePath)) {
      try {
        const data = fs.readFileSync(this.savePath, 'utf-8');
        const parsed = JSON.parse(data);
        
        // 🚨 修正: 古いJSONに新しい設定項目が欠けていても、DEFAULT_SETTINGSで補完してあげる（ディープマージ）
        this.settings = {
          normal: { ...DEFAULT_SETTINGS.normal, ...(parsed.normal || {}) },
          debug: { ...DEFAULT_SETTINGS.debug, ...(parsed.debug || {}) },
          system: { ...DEFAULT_SETTINGS.system, ...(parsed.system || {}) }
        };
      } catch(e) { 
        Logger.error('SettingsManager', '設定の読み込みに失敗しました。デフォルト値を使用します。'); 
        this.settings = { normal: { ...DEFAULT_SETTINGS.normal }, debug: { ...DEFAULT_SETTINGS.debug }, system: { ...DEFAULT_SETTINGS.system } };
      }
    } else {
      this.save();
    }
  }

  public save() {
    if (!fs.existsSync(path.dirname(this.savePath))) fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
    fs.writeFileSync(this.savePath, JSON.stringify(this.settings, null, 2));
  }

  public get(isDebug: boolean): GameSettings {
    return isDebug ? this.settings.debug : this.settings.normal;
  }

  public getSystem(): SystemSettings {
    return this.settings.system;
  }

  public update(isDebug: boolean, newSet: GameSettings) {
    if (isDebug) this.settings.debug = newSet;
    else this.settings.normal = newSet;
    this.save();
  }

  public updateSystem(newSet: SystemSettings) {
    this.settings.system = newSet;
    this.save();
  }

  public reset(type?: 'normal' | 'debug' | 'system') {
    if (type === 'debug') this.settings.debug = { ...DEFAULT_SETTINGS.debug };
    else if (type === 'normal') this.settings.normal = { ...DEFAULT_SETTINGS.normal };
    else if (type === 'system') this.settings.system = { ...DEFAULT_SETTINGS.system };
    else {
        this.settings = { 
            normal: { ...DEFAULT_SETTINGS.normal }, 
            debug: { ...DEFAULT_SETTINGS.debug }, 
            system: { ...DEFAULT_SETTINGS.system } 
        };
    }
    this.save();
  }
}
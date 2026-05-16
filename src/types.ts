/**
 * src/types.ts
 * 既存の型定義 ＋ スナップショット＆イベントログ対応（真の完全版）
 */
import { GameSettings } from './managers/SettingsManager.js';

export type Role = '人狼' | '狂人' | '占い師' | '霊媒師' | '騎士' | '村人';

export type Phase = 
  | 'setup' 
  | 'day_discussion' 
  | 'voting' 
  | 'runoff_voting' 
  | 'execution' 
  | 'night' 
  | 'finished';

export interface Player {
  userId: string;
  role: Role | null;
  isAlive: boolean;
  waitVcId: string;
  personalRoleId: string;
  personalTextChannelId: string; // 🚨 新規追加：個人用テキストチャンネル
}

export interface SpeechLog {
  userId: string;
  phase: Phase;
  day: number;
  timestamp: number;
  durationMs: number;
  audioFilePath: string;
}

export interface NightActions {
  wolfTargetId?: string;
  seerTargetId?: string;
  knightTargetId?: string;
}

export interface GameState {
  gameId: string;
  serverId: string;
  categoryId: string;
  originalVcId: string;
  waitVcId: string;
  mainVcId: string;
  wolfVcId: string;
  ghostVcId: string;
  voteChannelId: string;
  isDebug: boolean;
  phase: Phase;
  day: number;
  players: Player[];
  lastGuardedUserId: string | null;
  currentVotes: Record<string, string>;
  nightActions: NightActions;
  speechLogs: SpeechLog[];
  expectedVcIds: Record<string, string>;
  isResumedBonus?: boolean;
  settingsSnapshot: GameSettings;   // 🚨 新規追加項目// 試合開始時の設定スナップショット
  eventLogs: string[];            // イベントログ
  endedAt?: number;               // 終了時刻（クリーンアップ用）
  wolfTextChannelId: string; // 🚨 <--- この1行を新規追加！！！
  isPaused?: boolean; // 🚨 新規追加：一時停止フラグ
  relayWorkerId?: string;    // 🚨 追加：中継担当のWorker ID
  recorderWorkerId?: string; // 🚨 追加：録音担当のWorker ID
}

export interface DiscordTask {
  id: string;
  execute: () => Promise<void>;
  retryCount: number;
}

export interface GameEnvironment {
  commonRoleId: string;
  categoryId: string;
  mainVcId: string;
  wolfVcId: string;
  ghostVcId: string;
  voteChannelId: string;
  wolfTextChannelId: string; 
  playerEnvs: {
    userId: string;
    waitVcId: string;
    personalRoleId: string;
    personalTextChannelId: string; // 🚨 新規追加
  }[];
}
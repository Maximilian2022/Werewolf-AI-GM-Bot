/**
 * src/types.ts
 * 完全版（スナップショット対応 ＋ 既存の型定義復活）
 */
import { GameSettings } from './managers/SettingsManager';

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
  expectedVcIds: Record<string, string>; // 誰がどのVCにいるべきかの台帳
  isResumedBonus?: boolean; // 復帰ボーナスフラグ
  settingsSnapshot: GameSettings; // 🚨 試合開始時の設定スナップショット
}

// =========================================
// 🚨 前回削ってしまった型定義を復活
// =========================================

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
  playerEnvs: {
    userId: string;
    waitVcId: string;
    personalRoleId: string;
  }[];
}
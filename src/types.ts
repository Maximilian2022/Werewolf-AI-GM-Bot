/**
 * src/types.ts
 * 既存の型定義に加えて、ゲームの状態管理やプレイヤー情報、スピーチログなど、ゲーム全体で使用される主要な型を定義するファイル
 */
import { GameSettings } from './managers/SettingsManager.js';

export type Role = '人狼' | '狂人' | '占い師' | '霊媒師' | '騎士' | '村人';

export type Phase = 
  | 'setup'                      // ゲーム開始前の準備フェーズ
  | 'day_discussion'             // 昼の話し合いフェーズ
  | 'voting'                     // 投票フェーズ
  | 'runoff_voting'              // 決選投票フェーズ
  | 'execution'                  // 処刑フェーズ
  | 'night'                      // 夜の行動フェーズ
  | 'finished';                  // ゲーム終了フェーズ

export interface Player {
  userId: string;                 // DiscordユーザーID
  role: Role | null;              // ゲーム開始前はnull、ゲーム開始後は割り当てられた役職
  isAlive: boolean;               // 生存状態
  waitVcId: string;               // 待機部屋のVC ID
  personalRoleId: string;         // プレイヤー専用の役職ロールID
  personalTextChannelId: string;  // プレイヤー専用のテキストチャンネルID
}

export interface SpeechLog {
  userId: string;                 // 発言者のDiscordユーザーID
  phase: Phase;                   // 発言が行われたフェーズ
  day: number;                    // 発言が行われた日数
  timestamp: number;              // 発言のタイムスタンプ（ミリ秒）
  durationMs: number;             // 発言の持続時間（ミリ秒）
  audioFilePath: string;          // 発言の音声ファイルパス
}

export interface NightActions {
  wolfTargetId?: string;         // 人狼の襲撃対象ユーザーID
  seerTargetId?: string;         // 占い師の占い対象ユーザーID
  knightTargetId?: string;       // 騎士の護衛対象ユーザーID
}

export interface GameState {
  gameId: string;                          // ゲームの一意識別子
  serverId: string;                        // ゲームが開催されているDiscordサーバーID
  categoryId: string;                      // ゲーム用カテゴリーID
  originalVcId: string;                    // ゲーム開始前のロビーVC ID
  waitVcId: string;                        // プレイヤーが最初に入る待機部屋のVC ID
  mainVcId: string;                        // ゲーム中のメインVC ID
  wolfVcId: string;                        // 人狼専用VC ID
  ghostVcId: string;                       // 霊専用VC ID
  voteChannelId: string;                   // 投票用テキストチャンネルID
  isDebug: boolean;                        // デバッグモードフラグ
  phase: Phase;                            // 現在のフェーズ
  day: number;                             // 現在の日数（ゲーム開始時は0、1日目の昼で1、2日目の昼で2...）
  players: Player[];                       // プレイヤー情報の配列
  lastGuardedUserId: string | null;        // 前の夜に騎士が護衛したユーザーID（夜の行動で使用）
  currentVotes: Record<string, string>;    // 投票状況（投票者のユーザーIDをキー、投票先のユーザーIDを値とするオブジェクト）
  nightActions: NightActions;              // 夜の行動情報
  speechLogs: SpeechLog[];                 // 発言ログの配列
  expectedVcIds: Record<string, string>;   // プレイヤーのユーザーIDをキー、現在いるべきVC IDを値とするオブジェクト（不正なVC移動の検出に使用）
  isResumedBonus?: boolean;                // 中断再開時のボーナスタイム付与フラグ
  settingsSnapshot: GameSettings;          // 試合開始時の設定スナップショット
  eventLogs: string[];                     // イベントログ
  endedAt?: number;                        // 終了時刻（クリーンアップ用）
  wolfTextChannelId: string;               // 人狼部屋テキストチャンネルID
  isPaused?: boolean;                      // 一時停止フラグ
  recorderWorkerId?: string;               // 録音担当のWorker ID
  firstWhiteTargetId?: string;             // 占い師の初日白通知対象
  executedUserId?: string | null;                 // 処刑対象となったプレイヤーのID
  runoffTargets?: string[];                // 決選投票の対象プレイヤーIDリスト
  awayPlayerIds: string[];                 // 退席中のプレイヤーIDリスト
}

export interface DiscordTask {
  id: string;                        // タスクの一意識別子
  execute: () => Promise<void>;      // タスクの実行関数
  retryCount: number;                // リトライ回数
}

export interface GameEnvironment {
  commonRoleId: string;            // 共通の役職ロールID（例: 人狼陣営全員に付与するロール）
  categoryId: string;              // ゲーム用カテゴリーID
  mainVcId: string;                // ゲーム中のメインVC ID
  wolfVcId: string;                // 人狼専用VC ID
  ghostVcId: string;               // 霊専用VC ID
  voteChannelId: string;           // 投票用テキストチャンネルID
  wolfTextChannelId: string;       // 人狼部屋テキストチャンネルID
  playerEnvs: {
    userId: string;                // DiscordユーザーID
    waitVcId: string;              // プレイヤーが最初に入る待機部屋のVC ID
    personalRoleId: string;        // プレイヤー専用の役職ロールIDを追加
    personalTextChannelId: string; // プレイヤー専用テキストチャンネルIDを追加
  }[];
}
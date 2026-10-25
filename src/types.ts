/**
 * src/types.ts
 * 既存の型定義に加えて、ゲームの状態管理やプレイヤー情報、スピーチログなど、ゲーム全体で使用される主要な型を定義するファイル
 */
import { GameSettings } from './managers/SettingsManager.js';

export type Role = 
  | '村人' | '人狼' | '占い師' | '霊媒師' | '騎士' | '狂人'
  | '未熟な占い師' | '無謀な占い師' | '狐憑き' | '棺桶屋'
  | '妖狐' | '狂信者' | '共有者' | '猫又' | 'パン屋' | 'てるてる坊主'
  | 'ハンター' | '独裁者' | 'タフガイ' | '罠師' | 'カウンセラー'
  | '一匹狼' | '恋人' | '神様' | 'スパイ' | '内通者'
  | '人狼の子ども' | '占い師の弟子' | '狙われる市民' | '黒猫'
  | 'キューピット' | '悪女' | '女王' | '生霊' | '狼の眷属' | '凶暴な狼'
  | string;

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
  wolfTargetId?: string;                 // 人狼の襲撃対象ユーザーID
  wolfSecondTargetId?: string;           // 2回襲撃時の第2対象（人狼の子ども/凶暴な狼）
  seerTargetId?: string;                 // 占い師の占い対象ユーザーID
  knightTargetId?: string;               // 騎士の護衛対象ユーザーID
  apprenticeTargetId?: string;           // 未熟な占い師の占い対象
  apprenticePrediction?: 'wolf' | 'villager'; // 未熟な占い師の予想
  recklessTargetId?: string;             // 無謀な占い師の占い対象
  foxProtectedTargetId?: string;         // 狐憑きの加護対象
  undertakerTargetId?: string;           // 棺桶屋の処刑予想対象
  // 新規役職アクション
  trapperTargetId?: string;              // 罠師の罠設置対象
  counselorTargetId?: string;            // カウンセラーの更生対象
  spyTargetId?: string;                  // スパイの妨害対象
  hunterRevengeTargetId?: string;        // ハンターの道連れ事前指定対象
  cupidTargets?: [string, string];       // キューピットの恋人指定
  femmeFataleHoneyId?: string;           // 悪女の本命
  femmeFatalePawnIds?: string[];         // 悪女の手玉
  livingSpiritTargetId?: string;         // 生霊の憑依対象
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
  executedUserId?: string | null;          // 処刑対象となったプレイヤーのID
  runoffTargets?: string[];                // 決選投票の対象プレイヤーIDリスト
  awayPlayerIds: string[];                 // 退席中のプレイヤーIDリスト
  regulationId?: string;                   // 適用されたレギュレーションID
  undertakerHitCount?: number;             // 棺桶屋の累計的中回数
  undertakerHistory?: Record<string, string[]>; // 棺桶屋の過去の指定履歴
  apprenticeStatus?: Record<string, boolean>;   // 未熟な占い師の能力喪失状態
  platform?: PlatformType;                      // 'discord' | 'zoom' プラットフォーム識別
  
  // 新規役職状態
  loversUserIds?: [string, string];             // 恋人のIDペア
  femmeFataleData?: { femmeFataleId: string; honeyId: string; pawnIds: string[] };
  livingSpiritData?: Record<string, string>;     // 生霊ID -> 憑依先ID
  queenUserId?: string;                          // 女王のユーザーID
  toughGuyPoisoned?: Record<string, boolean>;    // タフガイが襲撃されて毒を受けた状態（翌夜息絶える）
  spyUsedRoles?: string[];                       // スパイが妨害済みの役職ID一覧
  wolfCubRevenge?: boolean;                      // 人狼の子ども処刑による次夜2回襲撃フラグ
  berserkUsed?: boolean;                         // 凶暴な狼が自爆2回襲撃を使用したフラグ
  dictatorUsed?: boolean;                        // 独裁者がCO使用済みフラグ
  apprenticeDivinerAwakened?: boolean;           // 占い師の弟子が覚醒したフラグ
  hunterShotTargets?: Record<string, string>;    // ハンターの道連れ指定（ユーザーID -> 対象ID）
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

export type PlatformType = 'discord' | 'zoom';

export interface ZoomProfile {
  id: string;                    // 一意識別子
  name: string;                  // プロファイル表示名（例: "幹事AのZoom"）
  clientId: string;              // Zoom Meeting SDK Client ID
  clientSecret: string;          // Zoom Meeting SDK Client Secret
  defaultHostKey?: string;       // デフォルトのホストキー（6桁）
  createdAt: string;             // 作成日時 ISO
  updatedAt: string;             // 更新日時 ISO
}

export interface ZoomSessionConfig {
  profileId: string;             // 使用するプロファイルID
  meetingNumber: string;         // ミーティング番号（数字列）
  passcode: string;              // パスコード
  hostKey?: string;              // ホストキー（任意）
  enableAIRecording: boolean;    // GeminiによるAI総評・録音の有効化（OFFなら録音ポップアップなし）
  botName?: string;              // Bot表示名（デフォルト: 人狼ゲームマスター）
}

export interface ZoomParticipant {
  userId: string;                // Zoom内のユーザーID
  userName: string;              // 参加者表示名
  isHost: boolean;               // ホストフラグ
  isCoHost: boolean;             // 共同ホストフラグ
  isMuted: boolean;              // ミュート状態
  breakoutRoomId?: string;       // 割り当てブレイクアウトルームID
  currentRoomName?: string;      // 表示用ルーム名（メインルーム、人狼の部屋、霊界など）
  role?: string;                 // ゲーム内役職（例: 人狼, 占い師, 市民など）
  isAlive?: boolean;             // 生存状態（false: 処刑・襲撃死）
}

export interface ZoomMeetingStatus {
  isConnected: boolean;          // 接続中か
  isConnecting: boolean;         // 接続試行中か
  meetingNumber?: string;        // 参加中ミーティング番号
  isHostOrCoHost: boolean;       // ホストまたは共同ホスト権限を獲得済みか
  isMockMode?: boolean;          // 仮想シミュレータ（デバッグモード）か
  participants: ZoomParticipant[]; // 現在の参加者一覧
  currentRoom: string;           // Botがいる現在の部屋（メインまたは各ブレイクアウトルーム）
  error?: string | null;         // エラーメッセージ
}
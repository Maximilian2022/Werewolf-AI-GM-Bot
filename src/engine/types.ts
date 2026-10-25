/**
 * src/engine/types.ts
 * ルール解決エンジンの型定義
 */
import { Player } from '../types.js';

export interface NightInputActions {
  wolfTargetId?: string;                 // 人狼の襲撃対象
  wolfSecondTargetId?: string;           // 2回襲撃時の第2対象
  seerTargetId?: string;                 // 通常占い師の対象
  apprenticeTargetId?: string;           // 未熟な占い師の対象
  apprenticePrediction?: 'wolf' | 'villager'; // 未熟な占い師の予想
  recklessTargetId?: string;             // 無謀な占い師の対象
  knightTargetId?: string;               // 騎士の護衛対象
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

export interface SeerResultDetail {
  seerUserId: string;
  targetUserId: string;
  result: 'wolf' | 'villager' | 'blocked'; // 'blocked' は狐憑きまたはスパイによる妨害（表示は「×」）
  isApprentice?: boolean;
  predictionCorrect?: boolean;
  lostAbility?: boolean;
}

export interface NightResolutionOutput {
  killedUserIds: string[];               // 翌朝発表される死亡者一覧
  guardedUserId: string | null;          // 護衛されたユーザーID
  guardSuccess: boolean;                 // 護衛が成功したか
  recklessGuardedPierceKill: boolean;    // 無謀な占い師が護衛貫通で死亡したか
  cursedFoxUserIds: string[];            // 呪殺された妖狐一覧
  foxFollowerUserIds: string[];          // 妖狐死亡に伴う後追いで死亡した狐憑き一覧
  seerResults: SeerResultDetail[];       // 占い結果リスト
  foxProtectedSuccess: boolean;          // 狐憑きが妖狐を守ったか（👍通知用）
  foxPossessedUserId?: string;           // 狐憑きのユーザーID
  logs: string[];                        // イベントログ
  
  // 新規役職解決結果
  trappedWolfUserId?: string;            // 罠にかかって死亡した人狼
  counselorReformedUserId?: string;      // 更生された裏切り者（村人化）
  counselorDiedUserId?: string;          // 人狼指名により殉職したカウンセラー
  spyBlockedUserId?: string;             // スパイによって能力妨害されたユーザー
  toughGuyPoisonedUserIds: string[];     // 襲撃されて毒を受けたタフガイ（翌朝は死なず翌夜死）
  targetedCivilianInfectedUserId?: string;// 襲撃され人狼化した市民
  berserkWolfDiedUserId?: string;        // 自爆した凶暴な狼
  loversFollowerUserIds: string[];       // 恋人後追いで死亡した一覧
  queenDied: boolean;                    // 女王が死亡したか
  queenShockKilledUserIds: string[];     // 女王崩御による市民ショック死一覧
  livingSpiritInheritedQueenUserId?: string;// 生霊が新女王を継承してショック死を防いだ場合
  hunterRevengeKilledUserIds: string[];  // ハンター襲撃死による道連れ犠牲者
}

export interface ExecutionInput {
  executedUserId: string | null;
  undertakerTargetId?: string;
  undertakerHitCount: number;
  hunterRevengeTargetId?: string;        // ハンター処刑時の道連れ指定
  isDictatorExecution?: boolean;         // 独裁者COによる即時処刑か
}

export interface ExecutionResolutionOutput {
  executedUserId: string | null;
  additionalKilledUserIds: string[];     // 猫又道連れなどの追加死亡者
  undertakerHit: boolean;
  undertakerNewHitCount: number;
  undertakerWin: boolean;                // 棺桶屋の単独勝利
  foolWin: boolean;                      // てるてる坊主の単独勝利
  undertakerAnnouncement?: string;       // 「棺桶が一つ売れたようです」など
  logs: string[];
  
  // 新規役職処刑解決
  wolfCubKilled: boolean;                // 人狼の子ども処刑フラグ（次夜2回襲撃）
  blackCatRevengeKilledUserId?: string;  // 黒猫処刑によるランダム道連れ（非人狼）
  hunterRevengeKilledUserId?: string;    // ハンター処刑による指定道連れ
  loversFollowerUserIds: string[];       // 恋人後追い死
  queenDied: boolean;                    // 女王が処刑されたか
  queenShockKilledUserIds: string[];     // 女王処刑による市民ショック死
  livingSpiritInheritedQueenUserId?: string; // 生霊の新女王継承
}

export type WinningTeam = 
  | '村人陣営' 
  | '人狼陣営' 
  | '妖狐陣営' 
  | '棺桶屋' 
  | 'てるてる坊主' 
  | '恋人陣営' 
  | '一匹狼' 
  | '神様' 
  | null;

/**
 * src/regulations/types.ts
 * レギュレーション定義の型
 */

export interface RegulationRuleOptions {
  firstNightDivination: 'white_npc' | 'free' | 'none'; // 初日白通知 / 初日自由占い / なし
  consecutiveGuard: boolean;                           // 連続護衛可能か（true: 可能, false: 不可）
  runoffTieBreaker: 'random_execution' | 'no_execution'; // 決選同票時の処刑ルール
  hasMediumResult: boolean;                            // 霊媒結果の発表有無
  wolfVoiceChat: boolean;                              // 夜の人狼VC会話を許可するか
}

export interface RegulationTimeSettings {
  day1DiscussionMin?: number;    // 1日目の昼の話し合い時間（分）
  day2DiscussionMin?: number;    // 2日目以降の昼の話し合い時間（分）
  dayDecreaseMin?: number;       // 日数減算（分）
  actionTimeoutMin?: number;     // 夜の行動制限時間（分）
  runoffDefenseMin?: number;     // 決選弁明時間（分）
  runoffVoteTimeoutMin?: number; // 決選投票時間（分）
  lastWordMin?: number;          // 遺言時間（分）
}

export interface RegulationSystemSettings {
  gmVoice?: string;              // GM音声モデル
  aiModel?: string;              // AI解析モデル
  aiTone?: string;               // AI講評トーン
  mvpMode?: string;              // MVP評価モード
  enableAIRecording?: boolean;   // 🎙️ AI総評・音声録音の有効化（falseならGemini解析スキップ）
  enableRegulationAnnouncement?: boolean; // 📜 ゲーム開始時のレギュレーション読み上げ有効化（デフォルト true）
}

export interface Regulation {
  id: string;                                          // 一意ID（例: 'preset_standard_13'）
  name: string;                                        // 表示名（例: '標準13人村'）
  description: string;                                 // 説明文
  isPreset: boolean;                                   // プリセットかカスタムか
  playerCount: number;                                 // 想定プレイヤー人数
  roles: Record<string, number>;                       // 役職ごとの人数（例: { werewolf: 2, seer: 1, ... }）
  rules: RegulationRuleOptions;                        // ルール設定
  times?: RegulationTimeSettings;                      // 個別時間設定
  system?: RegulationSystemSettings;                   // 個別システム・AI演出設定
}


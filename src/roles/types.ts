/**
 * src/roles/types.ts
 * 役職システムの型定義
 */

export type RoleId = 
  | 'villager'            // 村人
  | 'werewolf'            // 人狼
  | 'seer'                // 占い師
  | 'apprentice_seer'     // 未熟な占い師
  | 'reckless_seer'       // 無謀な占い師
  | 'medium'              // 霊媒師
  | 'knight'              // 騎士
  | 'madman'              // 狂人
  | 'fox'                 // 妖狐
  | 'fox_possessed'       // 狐憑き
  | 'fanatic'             // 狂信者
  | 'mason'               // 共有者
  | 'nekomata'            // 猫又
  | 'baker'               // パン屋
  | 'fool'                // てるてる坊主
  | 'undertaker'          // 棺桶屋
  // 新規役職
  | 'hunter'              // ハンター
  | 'dictator'            // 独裁者
  | 'tough_guy'           // タフガイ
  | 'trapper'             // 罠師
  | 'counselor'           // カウンセラー
  | 'lone_wolf'           // 一匹狼
  | 'lovers'              // 恋人
  | 'god'                 // 神様
  | 'spy'                 // スパイ
  | 'informant'           // 内通者
  | 'wolf_cub'            // 人狼の子ども
  | 'apprentice_diviner'  // 占い師の弟子
  | 'targeted_civilian'   // 狙われる市民
  | 'black_cat'           // 黒猫
  | 'cupid'               // キューピット
  | 'femme_fatale'        // 悪女
  | 'queen'               // 女王
  | 'living_spirit'       // 生霊
  | 'wolf_minion'         // 狼の眷属
  | 'berserk_wolf';       // 凶暴な狼

export type Team = 'villager' | 'werewolf' | 'fox' | 'third' | 'lovers';

export type CountType = 'human' | 'wolf' | 'none';

export type NightActionType = 
  | 'attack'               // 人狼の襲撃
  | 'divine'               // 通常の占い
  | 'apprentice_divine'    // 未熟な占い（予想付き）
  | 'reckless_divine'      // 無謀な占い
  | 'guard'                // 騎士の護衛
  | 'fox_protect'          // 狐憑きの加護
  | 'undertaker_predict'   // 棺桶屋の処刑予想
  | 'trapper_trap'         // 罠師の罠設置
  | 'counselor_counsel'    // カウンセラーの更生指名
  | 'spy_block'            // スパイの能力妨害
  | 'cupid_shoot'          // キューピットの恋人指定
  | 'femme_fatale_choose'  // 悪女の本命・手玉指定
  | 'living_spirit_possess'// 生霊の憑依先指定
  | 'hunter_shoot';        // ハンターの道連れ事前指定

export interface NightPromptOptions {
  label: string;
  placeholder: string;
  voicePromptId?: string;
  voicePromptText?: string;
}

export interface IRole {
  readonly id: RoleId;
  readonly name: string;
  readonly team: Team;
  readonly countType: CountType;
  readonly description: string;
  
  // 能力フラグ
  readonly hasNightAction: boolean;
  readonly nightActionType?: NightActionType;
  readonly canBeGuarded: boolean; // false の場合、護衛対象であっても襲撃死する（無謀な占い師など）
  readonly canVoiceChatAtNight: boolean; // 人狼など、夜に通話可能な役職
  
  // 夜の行動に関するプロンプト設定
  getNightPrompt?(day: number, extraData?: any): NightPromptOptions | null;
}

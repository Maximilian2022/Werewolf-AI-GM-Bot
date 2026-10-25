/**
 * src/roles/definitions/NewRoles.ts
 * 新規追加役職（20種）の定義
 */
import { IRole } from '../types.js';
import { MSG } from '../../messages.js';

// 1. ハンター
export const HunterRole: IRole = {
  id: 'hunter',
  name: 'ハンター',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。追放または人狼による襲撃で死亡した際、生存者の中から1名を指名して道連れ（銃殺）にする。夜フェーズ中に事前指定が可能。',
  hasNightAction: true,
  nightActionType: 'hunter_shoot',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '道連れ事前指定',
    placeholder: '万一死亡した際の道連れ対象を選択',
    voicePromptId: 'hunter_prompt',
    voicePromptText: MSG.VOICE.PROMPT_HUNTER
  })
};

// 2. 独裁者
export const DictatorRole: IRole = {
  id: 'dictator',
  name: '独裁者',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。ゲーム中1度だけ、昼の議論中に「独裁者CO」ボタンで議論を強制終了させ、独断でその日の処刑者を1名決定できる。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 3. タフガイ
export const ToughGuyRole: IRole = {
  id: 'tough_guy',
  name: 'タフガイ',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。人狼に襲撃されても翌朝は死なず耐え抜き、昼の議論・投票に参加した後の翌夜（個別部屋移動直後）に息絶える。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 4. 罠師
export const TrapperRole: IRole = {
  id: 'trapper',
  name: '罠師',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。毎晩自分以外の生存者1名に罠を設置する。罠にかかった対象への人狼襲撃は阻止され、襲撃した人狼が罠にかかって死亡する。',
  hasNightAction: true,
  nightActionType: 'trapper_trap',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '罠の設置',
    placeholder: '罠を仕掛ける対象を選択',
    voicePromptId: 'trapper_prompt',
    voicePromptText: MSG.VOICE.PROMPT_TRAPPER
  })
};

// 5. カウンセラー
export const CounselorRole: IRole = {
  id: 'counselor',
  name: 'カウンセラー',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。毎晩1名を指名してカウンセリングを行う。裏切り者（狂人・狂信者・スパイ・黒猫・狼の眷属）なら村人に更生させ、人狼ならカウンセラー自身が殉職する。',
  hasNightAction: true,
  nightActionType: 'counselor_counsel',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: 'カウンセリング',
    placeholder: '更生を試みる対象を選択',
    voicePromptId: 'counselor_prompt',
    voicePromptText: MSG.VOICE.PROMPT_COUNSELOR
  })
};

// 6. 一匹狼
export const LoneWolfRole: IRole = {
  id: 'lone_wolf',
  name: '一匹狼',
  team: 'third',
  countType: 'wolf',
  description: '第三陣営。人狼VCには入らず単独行動。通常の人狼が全員死亡し、かつゲーム終了時に生き残っていれば一匹狼の単独勝利となる。判定は人狼。',
  hasNightAction: true,
  nightActionType: 'attack',
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 7. 恋人
export const LoversRole: IRole = {
  id: 'lovers',
  name: '恋人',
  team: 'lovers',
  countType: 'human',
  description: '第三陣営。初めから互いを知る2人組。どちらかが死亡するともう片方も後追い死亡する。2人で最後まで生き残れば恋人陣営の勝利。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 8. 神様
export const GodRole: IRole = {
  id: 'god',
  name: '神様',
  team: 'third',
  countType: 'human',
  description: '第三陣営。初日に全プレイヤーの真の役職が知らされる。ゲーム終了時まで生き残っていれば神様の単独勝利となる。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 9. スパイ
export const SpyRole: IRole = {
  id: 'spy',
  name: 'スパイ',
  team: 'werewolf',
  countType: 'human',
  description: '人狼陣営。毎晩人間陣営1名の能力を妨害（ロールブロック）する。各役職につきゲーム中1度のみ妨害可能。判定は人間。',
  hasNightAction: true,
  nightActionType: 'spy_block',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '能力妨害',
    placeholder: '能力を妨害する対象を選択',
    voicePromptId: 'spy_prompt',
    voicePromptText: MSG.VOICE.PROMPT_SPY
  })
};

// 10. 内通者
export const InformantRole: IRole = {
  id: 'informant',
  name: '内通者',
  team: 'werewolf',
  countType: 'human',
  description: '人狼陣営。初日夜に誰が人狼かを知ることができる（人狼側は内通者が誰かを知らない）。判定は人間。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 11. 人狼の子ども
export const WolfCubRole: IRole = {
  id: 'wolf_cub',
  name: '人狼の子ども',
  team: 'werewolf',
  countType: 'wolf',
  description: '人狼陣営。昼の投票で処刑された場合、親狼たちが激怒し翌夜の人狼襲撃が2回になる。人狼VCに参加可能。',
  hasNightAction: true,
  nightActionType: 'attack',
  canBeGuarded: true,
  canVoiceChatAtNight: true
};

// 12. 占い師の弟子
export const ApprenticeDivinerRole: IRole = {
  id: 'apprentice_diviner',
  name: '占い師の弟子',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。本物の占い師が死亡した瞬間に覚醒し、翌夜から毎晩1名を占えるようになる。占い師生存中は通常の村人と同様。',
  hasNightAction: false, // 覚醒後に動的に有効化
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '弟子の占い',
    placeholder: '占う対象を選択',
    voicePromptId: 'seer_prompt',
    voicePromptText: MSG.VOICE.PROMPT_SEER
  })
};

// 13. 狙われる市民
export const TargetedCivilianRole: IRole = {
  id: 'targeted_civilian',
  name: '狙われる市民',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。人狼に襲撃されると死亡せず、人狼に感染して「人狼」になる。人狼化後は人狼VCに参加し人狼陣営の勝利を目指す。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 14. 黒猫
export const BlackCatRole: IRole = {
  id: 'black_cat',
  name: '黒猫',
  team: 'werewolf',
  countType: 'human',
  description: '人狼陣営。昼の投票で処刑された場合、生存している人間・第三陣営の中からランダムで1名を道連れにする。判定は人間。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 15. キューピット
export const CupidRole: IRole = {
  id: 'cupid',
  name: 'キューピット',
  team: 'third',
  countType: 'human',
  description: '第三陣営。初日夜に2名を選んで恋人にする。自身が結んだ恋人2名が最後まで生存すればキューピットの勝利。恋人が全滅すると後追い死亡する。',
  hasNightAction: true,
  nightActionType: 'cupid_shoot',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: (day: number) => (day === 0 ? {
    label: '恋人の矢',
    placeholder: '恋人にする対象を選択',
    voicePromptId: 'cupid_prompt',
    voicePromptText: MSG.VOICE.PROMPT_CUPID
  } : null)
};

// 16. 悪女
export const FemmeFataleRole: IRole = {
  id: 'femme_fatale',
  name: '悪女',
  team: 'third',
  countType: 'human',
  description: '第三陣営。初日夜に本命1名と手玉を指定する。本命と手玉には同一の通知が送られるが、悪女と後追い関係にあるのは本命のみ。悪女と本命の生存で勝利。',
  hasNightAction: true,
  nightActionType: 'femme_fatale_choose',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: (day: number) => (day === 0 ? {
    label: '本命・手玉選択',
    placeholder: '誘惑する対象を選択',
    voicePromptId: 'femme_fatale_prompt',
    voicePromptText: MSG.VOICE.PROMPT_FEMME_FATALE
  } : null)
};

// 17. 女王
export const QueenRole: IRole = {
  id: 'queen',
  name: '女王',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。村人陣営全員が初日から女王を知っている。女王が死亡すると市民全員がショック死し村人陣営は即座に完全敗北となる。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

// 18. 生霊
export const LivingSpiritRole: IRole = {
  id: 'living_spirit',
  name: '生霊',
  team: 'villager',
  countType: 'human',
  description: '初日夜に憑依先を1名指定。対象者が死亡した瞬間、その役職と陣営・勝利条件を完全に引き継ぐ。女王憑依時は新女王となり市民ショック死を防ぐ。',
  hasNightAction: true,
  nightActionType: 'living_spirit_possess',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: (day: number) => (day === 0 ? {
    label: '憑依先の指定',
    placeholder: '憑依する対象を選択',
    voicePromptId: 'living_spirit_prompt',
    voicePromptText: MSG.VOICE.PROMPT_LIVING_SPIRIT
  } : null)
};

// 19. 狼の眷属
export const WolfMinionRole: IRole = {
  id: 'wolf_minion',
  name: '狼の眷属',
  team: 'werewolf',
  countType: 'human',
  description: '人狼陣営。毎晩人狼VCに入って通話・相談に参加できる人間。判定は白、カウントは人間。',
  hasNightAction: true,
  nightActionType: 'attack',
  canBeGuarded: true,
  canVoiceChatAtNight: true
};

// 20. 凶暴な狼
export const BerserkWolfRole: IRole = {
  id: 'berserk_wolf',
  name: '凶暴な狼',
  team: 'werewolf',
  countType: 'wolf',
  description: '人狼陣営。ゲーム中1度だけ「自爆凶暴化」を発動し、夜に2名襲撃できる。夜が明けると自身も死亡する。',
  hasNightAction: true,
  nightActionType: 'attack',
  canBeGuarded: true,
  canVoiceChatAtNight: true
};

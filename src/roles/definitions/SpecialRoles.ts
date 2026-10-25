/**
 * src/roles/definitions/SpecialRoles.ts
 * 特殊役職（未熟な占い師、無謀な占い師、狐憑き、棺桶屋）の定義
 */
import { IRole } from '../types.js';
import { MSG } from '../../messages.js';

export const ApprenticeSeerRole: IRole = {
  id: 'apprentice_seer',
  name: '未熟な占い師',
  team: 'villager',
  countType: 'human',
  description: '毎晩1人を占い、対象が「人狼／村人」かを予想する。予想が当たれば翌日も占えるが、外れると当日の結果は知らされるものの翌日から能力を失う。',
  hasNightAction: true,
  nightActionType: 'apprentice_divine',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '未熟な占い（予想付き）',
    placeholder: '占う対象を選択',
    voicePromptId: 'apprentice_seer_prompt',
    voicePromptText: MSG.VOICE.PROMPT_APPRENTICE_SEER
  })
};

export const RecklessSeerRole: IRole = {
  id: 'reckless_seer',
  name: '無謀な占い師',
  team: 'villager',
  countType: 'human',
  description: '毎晩1人を占うことができるが、護衛の恩恵を受けられない。襲撃対象かつ護衛対象だった場合、護衛は成功するが無謀な占い師は死亡する。',
  hasNightAction: true,
  nightActionType: 'reckless_divine',
  canBeGuarded: false, // 護衛貫通死フラグ
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '無謀な占い',
    placeholder: '占う対象を選択',
    voicePromptId: 'reckless_seer_prompt',
    voicePromptText: MSG.VOICE.PROMPT_RECKLESS_SEER
  })
};

export const FoxPossessedRole: IRole = {
  id: 'fox_possessed',
  name: '狐憑き',
  team: 'fox',
  countType: 'none',
  description: '妖狐陣営。毎晩1人を指定し、その人が占われた場合に占いを無効（判定×）にして妖狐の呪殺を防ぐ。妖狐を指定した場合GMから合図が届く。妖狐が全員死亡すると翌朝後を追って死亡する。',
  hasNightAction: true,
  nightActionType: 'fox_protect',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '狐の加護',
    placeholder: '加護を与える対象を選択',
    voicePromptId: 'fox_possessed_prompt',
    voicePromptText: MSG.VOICE.PROMPT_FOX_POSSESSED
  })
};

export const UndertakerRole: IRole = {
  id: 'undertaker',
  name: '棺桶屋',
  team: 'third',
  countType: 'none',
  description: '第三陣営。毎晩、翌日処刑されそうな人を予想する。処刑予想に2回成功した瞬間、その場で単独勝利となる。成功時には「棺桶が一つ売れたようです」と発表される。自分を指定可能、同一人物の再指定不可（全員1巡でリセット）。',
  hasNightAction: true,
  nightActionType: 'undertaker_predict',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '処刑予想',
    placeholder: '翌日処刑されそうな人を予想',
    voicePromptId: 'undertaker_prompt',
    voicePromptText: MSG.VOICE.PROMPT_UNDERTAKER
  })
};

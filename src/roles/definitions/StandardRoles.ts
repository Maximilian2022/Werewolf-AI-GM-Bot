/**
 * src/roles/definitions/StandardRoles.ts
 * 標準役職（村人、人狼、占い師、霊媒師、騎士、狂人）の定義
 */
import { IRole } from '../types.js';
import { MSG } from '../../messages.js';

export const VillagerRole: IRole = {
  id: 'villager',
  name: '村人',
  team: 'villager',
  countType: 'human',
  description: '特別な能力は持たないが、鋭い推理と投票で人狼を追い詰める村人陣営の基礎役職。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

export const WerewolfRole: IRole = {
  id: 'werewolf',
  name: '人狼',
  team: 'werewolf',
  countType: 'wolf',
  description: '夜に仲間の人狼と相談し、村人を1人ずつ襲撃する人狼陣営の主役。',
  hasNightAction: true,
  nightActionType: 'attack',
  canBeGuarded: true,
  canVoiceChatAtNight: true,
  getNightPrompt: () => ({
    label: '人狼の襲撃',
    placeholder: '襲撃先を選択',
    voicePromptId: 'wolf_prompt',
    voicePromptText: MSG.VOICE.PROMPT_WOLF
  })
};

export const SeerRole: IRole = {
  id: 'seer',
  name: '占い師',
  team: 'villager',
  countType: 'human',
  description: '毎晩1人を占い、その者が「人狼」か「人狼ではない」かを知ることができる村人陣営の重要役職。',
  hasNightAction: true,
  nightActionType: 'divine',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '占い',
    placeholder: '占う対象を選択',
    voicePromptId: 'seer_prompt',
    voicePromptText: MSG.VOICE.PROMPT_SEER
  })
};

export const MediumRole: IRole = {
  id: 'medium',
  name: '霊媒師',
  team: 'villager',
  countType: 'human',
  description: '前日に処刑された者が「人狼」だったか「人狼ではなかった」かを知ることができる村人陣営の役職。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

export const KnightRole: IRole = {
  id: 'knight',
  name: '騎士',
  team: 'villager',
  countType: 'human',
  description: '毎晩1人を人狼の襲撃から護衛することができる村人陣営の盾。',
  hasNightAction: true,
  nightActionType: 'guard',
  canBeGuarded: true,
  canVoiceChatAtNight: false,
  getNightPrompt: () => ({
    label: '護衛',
    placeholder: '護衛対象を選択',
    voicePromptId: 'knight_prompt',
    voicePromptText: MSG.VOICE.PROMPT_KNIGHT
  })
};

export const MadmanRole: IRole = {
  id: 'madman',
  name: '狂人',
  team: 'werewolf',
  countType: 'human',
  description: '人狼陣営に味方する狂気の人。人狼が誰かは分からないが、人狼の勝利を目指して村を混乱させる。占い・霊媒では「人間」と判定される。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

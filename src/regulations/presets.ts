/**
 * src/regulations/presets.ts
 * 公式プリセットレギュレーション定義
 */
import { Regulation } from './types.js';

export const PRESET_REGULATIONS: Regulation[] = [
  {
    id: 'preset_standard_11',
    name: '標準11人村',
    description: '最も標準的な11人村構成（村人5, 人狼2, 狂人1, 占い師1, 霊媒師1, 騎士1）',
    isPreset: true,
    playerCount: 11,
    roles: {
      villager: 5,
      werewolf: 2,
      madman: 1,
      seer: 1,
      medium: 1,
      knight: 1
    },
    rules: {
      firstNightDivination: 'white_npc',
      consecutiveGuard: false,
      runoffTieBreaker: 'random_execution',
      hasMediumResult: true,
      wolfVoiceChat: true
    }
  },
  {
    id: 'preset_standard_13',
    name: '標準13人村',
    description: 'アルティメット人狼等で親しまれる13人村構成（村人6, 人狼3, 狂人1, 占い師1, 霊媒師1, 騎士1）',
    isPreset: true,
    playerCount: 13,
    roles: {
      villager: 6,
      werewolf: 3,
      madman: 1,
      seer: 1,
      medium: 1,
      knight: 1
    },
    rules: {
      firstNightDivination: 'white_npc',
      consecutiveGuard: false,
      runoffTieBreaker: 'random_execution',
      hasMediumResult: true,
      wolfVoiceChat: true
    }
  },
  {
    id: 'preset_standard_9',
    name: '標準9人村',
    description: '少人数でテンポよく遊べる定番構成（村人4, 人狼2, 狂人1, 占い師1, 騎士1）',
    isPreset: true,
    playerCount: 9,
    roles: {
      villager: 4,
      werewolf: 2,
      madman: 1,
      seer: 1,
      knight: 1
    },
    rules: {
      firstNightDivination: 'white_npc',
      consecutiveGuard: false,
      runoffTieBreaker: 'random_execution',
      hasMediumResult: false,
      wolfVoiceChat: true
    }
  },
  {
    id: 'preset_fox_12',
    name: '妖狐・狐憑き入り12人村',
    description: '第三陣営の妖狐と狐憑きが暗躍する12人構成（村人4, 人狼2, 狂信者1, 占い師1, 霊媒師1, 騎士1, 妖狐1, 狐憑き1）',
    isPreset: true,
    playerCount: 12,
    roles: {
      villager: 4,
      werewolf: 2,
      fanatic: 1,
      seer: 1,
      medium: 1,
      knight: 1,
      fox: 1,
      fox_possessed: 1
    },
    rules: {
      firstNightDivination: 'white_npc',
      consecutiveGuard: false,
      runoffTieBreaker: 'random_execution',
      hasMediumResult: true,
      wolfVoiceChat: true
    }
  },
  {
    id: 'preset_special_12',
    name: '特殊役職満載12人村',
    description: '未熟な占い師、無謀な占い師、猫又、パン屋、棺桶屋が入り乱れる大波乱構成',
    isPreset: true,
    playerCount: 12,
    roles: {
      villager: 3,
      werewolf: 2,
      fanatic: 1,
      apprentice_seer: 1,
      reckless_seer: 1,
      knight: 1,
      nekomata: 1,
      baker: 1,
      undertaker: 1
    },
    rules: {
      firstNightDivination: 'free',
      consecutiveGuard: false,
      runoffTieBreaker: 'random_execution',
      hasMediumResult: false,
      wolfVoiceChat: true
    }
  }
];

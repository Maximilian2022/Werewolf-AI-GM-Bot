/**
 * src/roles/definitions/ExtendedRoles.ts
 * 拡張役職（妖狐、狂信者、共有者、猫又、パン屋、てるてる坊主）の定義
 */
import { IRole } from '../types.js';

export const FoxRole: IRole = {
  id: 'fox',
  name: '妖狐',
  team: 'fox',
  countType: 'none',
  description: '第三陣営。人狼に襲撃されても死亡しないが、占い師に占われると翌朝呪殺される。村人陣営か人狼陣営の勝利条件が満たされた際に生存していれば単独勝利。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

export const FanaticRole: IRole = {
  id: 'fanatic',
  name: '狂信者',
  team: 'werewolf',
  countType: 'human',
  description: '人狼陣営。初日夜に誰が人狼かを知ることができる（人狼側は狂信者が誰かを知らない）。占い・霊媒では「人間」と判定される。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

export const MasonRole: IRole = {
  id: 'mason',
  name: '共有者',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。2人1組で存在し、お互いが共有者であることを知っている。専用の共有者チャットで会話可能。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

export const NekomataRole: IRole = {
  id: 'nekomata',
  name: '猫又',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。昼に処刑された場合は生存者からランダムで1名を道連れにし、夜に人狼に襲撃された場合は襲撃した人狼の中から1名を道連れにして死亡させる。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

export const BakerRole: IRole = {
  id: 'baker',
  name: 'パン屋',
  team: 'villager',
  countType: 'human',
  description: '村人陣営。生存している間、毎朝「パン屋がおいしいパンを焼いてくれました」と村全体にアナウンスされる。死亡するとパンが焼けなくなり、パン屋の死が村に知れ渡る。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

export const FoolRole: IRole = {
  id: 'fool',
  name: 'てるてる坊主',
  team: 'third',
  countType: 'none',
  description: '第三陣営。昼の投票によって処刑されることを目指す。自分が処刑された瞬間に単独勝利となる。',
  hasNightAction: false,
  canBeGuarded: true,
  canVoiceChatAtNight: false
};

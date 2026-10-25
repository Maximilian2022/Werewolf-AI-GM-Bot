/**
 * src/engine/WinConditionChecker.ts
 * 全陣営・特殊役職の勝利条件を汎用判定するエンジン
 */
import { Player } from '../types.js';
import { RoleRegistry } from '../roles/RoleRegistry.js';
import { WinningTeam } from './types.js';
import { NightContext } from './NightActionResolver.js';

export class WinConditionChecker {
  public static check(
    players: Player[], 
    specialWin?: { undertakerWin?: boolean; foolWin?: boolean },
    context?: NightContext
  ): WinningTeam {
    // 1. 特殊即時単独勝利チェック（最優先）
    if (specialWin?.undertakerWin) return '棺桶屋';
    if (specialWin?.foolWin) return 'てるてる坊主';

    const roleRegistry = RoleRegistry.getInstance();
    const alivePlayers = players.filter(p => p.isAlive);

    let wolfCount = 0;
    let normalWolfCount = 0;
    let loneWolfAlive = false;
    let humanCount = 0;
    let foxAliveCount = 0;
    let godAlive = false;

    for (const player of alivePlayers) {
      if (!player.role) continue;
      const role = roleRegistry.get(player.role);
      if (!role) continue;

      if (role.id === 'lone_wolf') {
        loneWolfAlive = true;
        wolfCount += 1;
      } else if (['werewolf', 'wolf_cub', 'berserk_wolf'].includes(role.id)) {
        normalWolfCount += 1;
        wolfCount += 1;
      } else if (role.countType === 'human') {
        humanCount += 1;
      }

      if (role.team === 'fox') {
        foxAliveCount += 1;
      }

      if (role.id === 'god') {
        godAlive = true;
      }
    }

    // 恋人陣営生存チェック
    let loversWin = false;
    if (context?.loversUserIds) {
      const p1Alive = alivePlayers.some(p => p.userId === context.loversUserIds![0]);
      const p2Alive = alivePlayers.some(p => p.userId === context.loversUserIds![1]);
      if (p1Alive && p2Alive) loversWin = true;
    }
    if (context?.femmeFataleData) {
      const ffAlive = alivePlayers.some(p => p.userId === context.femmeFataleData!.femmeFataleId);
      const honeyAlive = alivePlayers.some(p => p.userId === context.femmeFataleData!.honeyId);
      if (ffAlive && honeyAlive) loversWin = true;
    }

    // 基本勝敗条件の成立チェック
    const isVillagerWinCondition = (wolfCount === 0);
    const isWolfWinCondition = (wolfCount >= humanCount);

    if (isVillagerWinCondition || isWolfWinCondition) {
      // 優先度 2: 恋人陣営（恋人2名が生存）
      if (loversWin) {
        return '恋人陣営';
      }

      // 優先度 3: 一匹狼（通常人狼全滅 ＋ 一匹狼生存）
      if (loneWolfAlive && normalWolfCount === 0) {
        return '一匹狼';
      }

      // 優先度 4: 神様（最後まで生存）
      if (godAlive) {
        return '神様';
      }

      // 優先度 5: 妖狐陣営（妖狐生存）
      if (foxAliveCount > 0) {
        return '妖狐陣営';
      }

      // 優先度 6 / 7: 通常の村人 / 人狼
      return isVillagerWinCondition ? '村人陣営' : '人狼陣営';
    }

    // 勝敗未決
    return null;
  }
}

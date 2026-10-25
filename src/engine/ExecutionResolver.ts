/**
 * src/engine/ExecutionResolver.ts
 * 処刑フェーズの能力解決エンジン（棺桶屋、てるてる坊主、猫又、黒猫、ハンター、人狼の子ども、女王崩御、恋人後追いなど）
 */
import { Player } from '../types.js';
import { RoleRegistry } from '../roles/RoleRegistry.js';
import { ExecutionInput, ExecutionResolutionOutput } from './types.js';
import { NightContext } from './NightActionResolver.js';

export class ExecutionResolver {
  public static resolve(
    players: Player[], 
    input: ExecutionInput,
    context: NightContext = {}
  ): ExecutionResolutionOutput {
    const roleRegistry = RoleRegistry.getInstance();
    const { executedUserId, undertakerTargetId, undertakerHitCount, hunterRevengeTargetId } = input;
    const additionalKilledSet = new Set<string>();
    const logs: string[] = [];

    let undertakerHit = false;
    let undertakerNewHitCount = undertakerHitCount;
    let undertakerWin = false;
    let foolWin = false;
    let undertakerAnnouncement: string | undefined;

    let wolfCubKilled = false;
    let blackCatRevengeKilledUserId: string | undefined;
    let hunterRevengeKilledUserId: string | undefined;
    const loversFollowerUserIds: string[] = [];
    let queenDied = false;
    const queenShockKilledUserIds: string[] = [];
    let livingSpiritInheritedQueenUserId: string | undefined;

    if (!executedUserId) {
      return {
        executedUserId: null,
        additionalKilledUserIds: [],
        undertakerHit: false,
        undertakerNewHitCount: undertakerHitCount,
        undertakerWin: false,
        foolWin: false,
        logs: ['[処刑なし] 誰も処刑されませんでした'],
        wolfCubKilled: false,
        loversFollowerUserIds: [],
        queenDied: false,
        queenShockKilledUserIds: []
      };
    }

    const executedPlayer = players.find(p => p.userId === executedUserId);
    const executedRole = executedPlayer?.role ? roleRegistry.get(executedPlayer.role) : undefined;

    const getRole = (userId: string) => {
      const p = players.find(pl => pl.userId === userId);
      return p?.role ? roleRegistry.get(p.role) : undefined;
    };

    // 1. 棺桶屋の予想チェック
    if (undertakerTargetId && undertakerTargetId === executedUserId) {
      undertakerHit = true;
      undertakerNewHitCount += 1;
      logs.push(`[棺桶屋] 処刑予想が的中しました (累計的中数: ${undertakerNewHitCount})`);

      if (undertakerNewHitCount >= 2) {
        undertakerWin = true;
        logs.push(`[棺桶屋勝利] 2回目の予想的中により棺桶屋の単独勝利が確定しました`);
      } else {
        undertakerAnnouncement = '棺桶が一つ売れたようです';
      }
    }

    // 2. てるてる坊主（Fool）の単独勝利チェック
    if (executedRole?.id === 'fool') {
      foolWin = true;
      logs.push(`[てるてる坊主勝利] てるてる坊主が処刑されたため、単独勝利が確定しました`);
    }

    // 3. 人狼の子ども（Wolf Cub）の処刑チェック
    if (executedRole?.id === 'wolf_cub') {
      wolfCubKilled = true;
      logs.push(`[人狼の子ども処刑] 人狼の子どもが処刑されたため、次夜の襲撃が2回になります`);
    }

    // 4. 黒猫（Black Cat）の処刑時道連れチェック（非人狼からランダム1名）
    if (executedRole?.id === 'black_cat') {
      const nonWolves = players.filter(p => {
        if (!p.isAlive || p.userId === executedUserId || additionalKilledSet.has(p.userId)) return false;
        const r = getRole(p.userId);
        return !r || !['werewolf', 'wolf_cub', 'berserk_wolf', 'lone_wolf'].includes(r.id);
      });
      if (nonWolves.length > 0) {
        const victim = nonWolves[Math.floor(Math.random() * nonWolves.length)];
        additionalKilledSet.add(victim.userId);
        blackCatRevengeKilledUserId = victim.userId;
        logs.push(`[黒猫処刑道連れ] 黒猫の処刑により生存者から1名が道連れになりました (Target: ${victim.userId})`);
      }
    }

    // 5. 猫又（Nekomata）の処刑時道連れチェック（生存者からランダム1名）
    if (executedRole?.id === 'nekomata') {
      const remainingAlive = players.filter(p => p.isAlive && p.userId !== executedUserId && !additionalKilledSet.has(p.userId));
      if (remainingAlive.length > 0) {
        const victim = remainingAlive[Math.floor(Math.random() * remainingAlive.length)];
        additionalKilledSet.add(victim.userId);
        logs.push(`[猫又処刑道連れ] 猫又の処刑により生存者から1名が道連れになりました (Target: ${victim.userId})`);
      }
    }

    // 6. ハンター（Hunter）の処刑時道連れチェック
    if (executedRole?.id === 'hunter') {
      let victimId = hunterRevengeTargetId;
      if (!victimId || !players.some(p => p.isAlive && p.userId === victimId && p.userId !== executedUserId)) {
        const remaining = players.filter(p => p.isAlive && p.userId !== executedUserId && !additionalKilledSet.has(p.userId));
        if (remaining.length > 0) {
          victimId = remaining[Math.floor(Math.random() * remaining.length)].userId;
        }
      }
      if (victimId) {
        additionalKilledSet.add(victimId);
        hunterRevengeKilledUserId = victimId;
        logs.push(`[ハンター処刑道連れ] ハンターの道連れにより1名が銃殺されました (Target: ${victimId})`);
      }
    }

    // 7. 恋人の後追い死チェック
    const checkLovers = (u1: string, u2: string) => {
      const u1Dead = (u1 === executedUserId || additionalKilledSet.has(u1));
      const u2Dead = (u2 === executedUserId || additionalKilledSet.has(u2));
      if (u1Dead && !u2Dead) {
        additionalKilledSet.add(u2);
        loversFollowerUserIds.push(u2);
        logs.push(`[恋人後追い] 処刑に伴い恋人が後を追って息絶えました (User: ${u2})`);
      } else if (u2Dead && !u1Dead) {
        additionalKilledSet.add(u1);
        loversFollowerUserIds.push(u1);
        logs.push(`[恋人後追い] 処刑に伴い恋人が後を追って息絶えました (User: ${u1})`);
      }
    };

    if (context.loversUserIds) {
      checkLovers(context.loversUserIds[0], context.loversUserIds[1]);
    }
    if (context.femmeFataleData) {
      checkLovers(context.femmeFataleData.femmeFataleId, context.femmeFataleData.honeyId);
    }

    // 8. 女王崩御の市民ショック死チェック
    const isQueenDead = (context.queenUserId && (context.queenUserId === executedUserId || additionalKilledSet.has(context.queenUserId)));
    if (isQueenDead && context.queenUserId) {
      queenDied = true;
      logs.push(`[女王崩御] 女王が死亡しました (Queen: ${context.queenUserId})`);

      let hasSpiritInherited = false;
      if (context.livingSpiritData) {
        for (const [spiritId, targetId] of Object.entries(context.livingSpiritData)) {
          if (targetId === context.queenUserId && spiritId !== executedUserId && !additionalKilledSet.has(spiritId)) {
            hasSpiritInherited = true;
            livingSpiritInheritedQueenUserId = spiritId;
            const spiritPlayer = players.find(p => p.userId === spiritId);
            if (spiritPlayer) {
              spiritPlayer.role = '女王';
            }
            logs.push(`[新女王即位] 生霊が女王の遺志を継ぎ新女王となりました (User: ${spiritId})`);
            break;
          }
        }
      }

      if (!hasSpiritInherited) {
        const citizenRoles = [
          'villager', 'seer', 'medium', 'knight', 'apprentice_seer', 'reckless_seer',
          'mason', 'nekomata', 'baker', 'hunter', 'dictator', 'tough_guy', 'trapper',
          'counselor', 'apprentice_diviner', 'queen'
        ];
        for (const p of players) {
          if (p.isAlive && p.userId !== executedUserId && !additionalKilledSet.has(p.userId)) {
            const r = getRole(p.userId);
            if (r && citizenRoles.includes(r.id)) {
              additionalKilledSet.add(p.userId);
              queenShockKilledUserIds.push(p.userId);
              logs.push(`[女王ショック死] 女王崩御に伴い市民がショック死しました (User: ${p.userId})`);
            }
          }
        }
      }
    }

    return {
      executedUserId,
      additionalKilledUserIds: Array.from(additionalKilledSet),
      undertakerHit,
      undertakerNewHitCount,
      undertakerWin,
      foolWin,
      undertakerAnnouncement,
      logs,
      wolfCubKilled,
      blackCatRevengeKilledUserId,
      hunterRevengeKilledUserId,
      loversFollowerUserIds,
      queenDied,
      queenShockKilledUserIds,
      livingSpiritInheritedQueenUserId
    };
  }
}

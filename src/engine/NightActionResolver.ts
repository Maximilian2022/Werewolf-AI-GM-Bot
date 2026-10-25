/**
 * src/engine/NightActionResolver.ts
 * 夜のアクション（襲撃、占い、護衛、加護、罠、更生、妨害、呪殺、後追いなど）を一括突合・解決するエンジン
 */
import { Player } from '../types.js';
import { RoleRegistry } from '../roles/RoleRegistry.js';
import { NightInputActions, NightResolutionOutput, SeerResultDetail } from './types.js';

export interface NightContext {
  loversUserIds?: [string, string];
  femmeFataleData?: { femmeFataleId: string; honeyId: string; pawnIds: string[] };
  livingSpiritData?: Record<string, string>; // 生霊ID -> 憑依先ID
  queenUserId?: string;
  berserkWolfActive?: boolean;
  berserkWolfUserId?: string;
  apprenticeDivinerAwakened?: boolean;
}

export class NightActionResolver {
  public static resolve(
    players: Player[], 
    actions: NightInputActions,
    apprenticeStatus: Record<string, boolean> = {}, // 未熟な占い師の能力喪失状態
    context: NightContext = {}
  ): NightResolutionOutput {
    const roleRegistry = RoleRegistry.getInstance();
    const alivePlayers = players.filter(p => p.isAlive);
    const logs: string[] = [];
    const killedSet = new Set<string>();

    const getRole = (userId: string) => {
      const p = players.find(pl => pl.userId === userId);
      return p?.role ? roleRegistry.get(p.role) : undefined;
    };

    // 1. スパイ（Spy）の能力妨害を確定
    let spyBlockedUserId: string | undefined;
    const spyPlayer = alivePlayers.find(p => getRole(p.userId)?.id === 'spy');
    if (spyPlayer && actions.spyTargetId) {
      spyBlockedUserId = actions.spyTargetId;
      logs.push(`[スパイ妨害] スパイが対象の能力を妨害しました (Target: ${spyBlockedUserId})`);
    }

    // 2. 狐憑き（FoxPossessed）の加護を確定
    const foxProtectedTargetId = actions.foxProtectedTargetId;
    let foxProtectedSuccess = false;
    let foxPossessedUserId: string | undefined;

    const foxPossessedPlayer = alivePlayers.find(p => getRole(p.userId)?.id === 'fox_possessed');
    if (foxPossessedPlayer && foxProtectedTargetId && foxPossessedPlayer.userId !== spyBlockedUserId) {
      foxPossessedUserId = foxPossessedPlayer.userId;
      const targetRole = getRole(foxProtectedTargetId);
      if (targetRole?.id === 'fox') {
        foxProtectedSuccess = true;
        logs.push(`[狐憑き] 妖狐を守護しました (Target: ${foxProtectedTargetId})`);
      }
    }

    // 3. 騎士の護衛 ＆ 罠師の罠設置
    let guardedUserId: string | null = null;
    const knightPlayer = alivePlayers.find(p => getRole(p.userId)?.id === 'knight');
    if (knightPlayer && actions.knightTargetId && knightPlayer.userId !== spyBlockedUserId) {
      guardedUserId = actions.knightTargetId;
    }

    let trappedUserId: string | null = null;
    const trapperPlayer = alivePlayers.find(p => getRole(p.userId)?.id === 'trapper');
    if (trapperPlayer && actions.trapperTargetId && trapperPlayer.userId !== spyBlockedUserId) {
      trappedUserId = actions.trapperTargetId;
      logs.push(`[罠師] 罠を設置しました (Target: ${trappedUserId})`);
    }

    // 4. カウンセラー（Counselor）の更生 / 殉職
    let counselorReformedUserId: string | undefined;
    let counselorDiedUserId: string | undefined;
    const counselorPlayer = alivePlayers.find(p => getRole(p.userId)?.id === 'counselor');
    if (counselorPlayer && actions.counselorTargetId && counselorPlayer.userId !== spyBlockedUserId) {
      const cTargetId = actions.counselorTargetId;
      const cTargetRole = getRole(cTargetId);

      // 人狼系なら殉職（ショック死）
      if (cTargetRole && ['werewolf', 'wolf_cub', 'berserk_wolf', 'lone_wolf'].includes(cTargetRole.id)) {
        counselorDiedUserId = counselorPlayer.userId;
        killedSet.add(counselorPlayer.userId);
        logs.push(`[カウンセラー殉職] 人狼にカウンセリングを試みたため死亡しました (Counselor: ${counselorPlayer.userId})`);
      } 
      // 裏切り者（人狼陣営の人間）なら村人に更生
      else if (cTargetRole && ['madman', 'fanatic', 'informant', 'spy', 'black_cat', 'wolf_minion'].includes(cTargetRole.id)) {
        counselorReformedUserId = cTargetId;
        const targetPl = players.find(p => p.userId === cTargetId);
        if (targetPl) {
          targetPl.role = '村人'; // 役職書き換え
        }
        logs.push(`[カウンセラー更生] 裏切り者が村人に更生しました (Target: ${cTargetId})`);
      }
    }

    // 5. 占い（通常占い師、未熟な占い師、無謀な占い師、覚醒した弟子）の解決
    const seerResults: SeerResultDetail[] = [];
    const cursedFoxSet = new Set<string>();

    const processSeer = (
      seerUserId: string, 
      targetId: string | undefined, 
      isApprentice = false, 
      prediction?: 'wolf' | 'villager'
    ) => {
      if (!targetId) return;
      const targetPlayer = alivePlayers.find(p => p.userId === targetId);
      if (!targetPlayer) return;

      // スパイ妨害チェック
      if (seerUserId === spyBlockedUserId) {
        logs.push(`[占い妨害] スパイにより占いが妨害されました (Seer: ${seerUserId})`);
        seerResults.push({ seerUserId, targetUserId: targetId, result: 'blocked', isApprentice });
        return;
      }

      // 狐憑きによる占い妨害チェック
      if (foxProtectedTargetId && targetId === foxProtectedTargetId) {
        logs.push(`[占い妨害] 狐憑きにより占いが無効化されました (Target: ${targetId})`);
        seerResults.push({ seerUserId, targetUserId: targetId, result: 'blocked', isApprentice });
        return;
      }

      const targetRole = getRole(targetId);
      // 判定: 人狼系（人狼、子ども、凶暴な狼、一匹狼）は人狼。狂人や眷属等は村人
      const isWolf = targetRole ? ['werewolf', 'wolf_cub', 'berserk_wolf', 'lone_wolf'].includes(targetRole.id) : false;
      const actualResult: 'wolf' | 'villager' = isWolf ? 'wolf' : 'villager';

      // 妖狐への呪殺判定
      if (targetRole?.id === 'fox') {
        cursedFoxSet.add(targetId);
        logs.push(`[呪殺] 妖狐が占われ、呪殺対象となりました (Target: ${targetId})`);
      }

      // 未熟な占い師の予想判定
      if (isApprentice) {
        const isCorrect = (prediction === actualResult);
        const lostAbility = !isCorrect;
        logs.push(`[未熟な占い師] 予想: ${prediction}, 実際: ${actualResult}, 的中: ${isCorrect}`);
        seerResults.push({
          seerUserId,
          targetUserId: targetId,
          result: actualResult,
          isApprentice: true,
          predictionCorrect: isCorrect,
          lostAbility
        });
      } else {
        seerResults.push({
          seerUserId,
          targetUserId: targetId,
          result: actualResult,
          isApprentice: false
        });
      }
    };

    // 通常占い師
    const normalSeer = alivePlayers.find(p => getRole(p.userId)?.id === 'seer');
    if (normalSeer && actions.seerTargetId) {
      processSeer(normalSeer.userId, actions.seerTargetId, false);
    }

    // 覚醒した占い師の弟子
    if (context.apprenticeDivinerAwakened) {
      const divinerApprentice = alivePlayers.find(p => getRole(p.userId)?.id === 'apprentice_diviner');
      if (divinerApprentice && actions.seerTargetId) {
        processSeer(divinerApprentice.userId, actions.seerTargetId, false);
      }
    }

    // 未熟な占い師（能力喪失していない場合のみ）
    const apprenticeSeer = alivePlayers.find(p => getRole(p.userId)?.id === 'apprentice_seer');
    if (apprenticeSeer && actions.apprenticeTargetId && !apprenticeStatus[apprenticeSeer.userId]) {
      processSeer(apprenticeSeer.userId, actions.apprenticeTargetId, true, actions.apprenticePrediction);
    }

    // 無謀な占い師
    const recklessSeer = alivePlayers.find(p => getRole(p.userId)?.id === 'reckless_seer');
    if (recklessSeer && actions.recklessTargetId) {
      processSeer(recklessSeer.userId, actions.recklessTargetId, false);
    }

    // 6. 人狼の襲撃解決（1回または2回襲撃）
    const targetsToAttack: string[] = [];
    if (actions.wolfTargetId) targetsToAttack.push(actions.wolfTargetId);
    if (actions.wolfSecondTargetId && actions.wolfSecondTargetId !== actions.wolfTargetId) {
      targetsToAttack.push(actions.wolfSecondTargetId);
    }

    let guardSuccess = false;
    let recklessGuardedPierceKill = false;
    let trappedWolfUserId: string | undefined;
    const toughGuyPoisonedUserIds: string[] = [];
    let targetedCivilianInfectedUserId: string | undefined;
    const hunterRevengeKilledUserIds: string[] = [];

    const aliveWolves = alivePlayers.filter(p => {
      const r = getRole(p.userId);
      return r && ['werewolf', 'wolf_cub', 'berserk_wolf'].includes(r.id);
    });

    for (const wolfTargetId of targetsToAttack) {
      const wolfTargetRole = getRole(wolfTargetId);

      // (A) 罠師の罠チェック（最優先迎撃）
      if (trappedUserId !== null && wolfTargetId === trappedUserId) {
        logs.push(`[罠師迎撃] 人狼が罠にかかりました (Target: ${wolfTargetId})`);
        if (aliveWolves.length > 0 && !trappedWolfUserId) {
          const trappedWolf = aliveWolves[Math.floor(Math.random() * aliveWolves.length)];
          trappedWolfUserId = trappedWolf.userId;
          killedSet.add(trappedWolf.userId);
          logs.push(`[罠師討伐] 襲撃した人狼が罠にかかり死亡しました (Wolf: ${trappedWolf.userId})`);
        }
        continue; // 罠により襲撃は完全阻止
      }

      // (B) 騎士の護衛チェック
      const isGuarded = (guardedUserId !== null && wolfTargetId === guardedUserId);
      if (isGuarded) {
        guardSuccess = true;
        if (wolfTargetRole?.canBeGuarded === false) {
          recklessGuardedPierceKill = true;
          killedSet.add(wolfTargetId);
          logs.push(`[無謀な占い師] 護衛されましたが、護衛貫通により死亡しました (Target: ${wolfTargetId})`);
        } else {
          logs.push(`[護衛成功] 人狼の襲撃から護衛されました (Target: ${wolfTargetId})`);
        }
        continue;
      }

      // (C) 護衛なし直撃
      if (wolfTargetRole?.id === 'fox') {
        logs.push(`[襲撃無効] 妖狐への襲撃のため死亡しませんでした (Target: ${wolfTargetId})`);
      } else if (wolfTargetRole?.id === 'targeted_civilian') {
        // 狙われる市民: 死亡せず人狼化！
        targetedCivilianInfectedUserId = wolfTargetId;
        const pObj = players.find(p => p.userId === wolfTargetId);
        if (pObj) {
          pObj.role = '人狼';
        }
        logs.push(`[狙われる市民人狼化] 襲撃により人狼に感染しました (Target: ${wolfTargetId})`);
      } else if (wolfTargetRole?.id === 'tough_guy') {
        // タフガイ: 翌朝は耐え、翌夜息絶える
        toughGuyPoisonedUserIds.push(wolfTargetId);
        logs.push(`[タフガイ耐性] 襲撃を受けましたが耐え抜きました (Target: ${wolfTargetId})`);
      } else if (wolfTargetRole?.id === 'nekomata') {
        // 猫又の道連れ
        killedSet.add(wolfTargetId);
        logs.push(`[襲撃死] 猫又が襲撃されました (Target: ${wolfTargetId})`);
        if (aliveWolves.length > 0) {
          const revengeWolf = aliveWolves[Math.floor(Math.random() * aliveWolves.length)];
          killedSet.add(revengeWolf.userId);
          logs.push(`[猫又道連れ] 襲撃した人狼が道連れになりました (Wolf: ${revengeWolf.userId})`);
        }
      } else if (wolfTargetRole?.id === 'hunter') {
        // ハンターの道連れ（事前指定があればその人、なければ生存者ランダム）
        killedSet.add(wolfTargetId);
        logs.push(`[襲撃死] ハンターが襲撃されました (Target: ${wolfTargetId})`);
        let hunterVictimId = actions.hunterRevengeTargetId;
        if (!hunterVictimId || !alivePlayers.some(p => p.userId === hunterVictimId && p.userId !== wolfTargetId)) {
          const others = alivePlayers.filter(p => p.userId !== wolfTargetId);
          if (others.length > 0) {
            hunterVictimId = others[Math.floor(Math.random() * others.length)].userId;
          }
        }
        if (hunterVictimId) {
          killedSet.add(hunterVictimId);
          hunterRevengeKilledUserIds.push(hunterVictimId);
          logs.push(`[ハンター銃殺] 襲撃されたハンターの道連れが発生しました (Victim: ${hunterVictimId})`);
        }
      } else {
        killedSet.add(wolfTargetId);
        logs.push(`[襲撃死] 人狼により襲撃されました (Target: ${wolfTargetId})`);
      }
    }

    // 7. 凶暴な狼（Berserk Wolf）の自爆死
    let berserkWolfDiedUserId: string | undefined;
    if (context.berserkWolfActive && context.berserkWolfUserId) {
      berserkWolfDiedUserId = context.berserkWolfUserId;
      killedSet.add(context.berserkWolfUserId);
      logs.push(`[凶暴な狼自爆] 2回襲撃を行なった凶暴な狼が自爆死亡しました (Wolf: ${berserkWolfDiedUserId})`);
    }

    // 8. 呪殺死の適用
    const cursedFoxUserIds: string[] = [];
    for (const foxId of cursedFoxSet) {
      killedSet.add(foxId);
      cursedFoxUserIds.push(foxId);
      logs.push(`[呪殺死] 妖狐が呪殺により死亡しました (Fox: ${foxId})`);
    }

    // 9. 恋人の後追い死
    const loversFollowerUserIds: string[] = [];
    const checkLoversPair = (u1: string, u2: string) => {
      const u1Died = killedSet.has(u1);
      const u2Died = killedSet.has(u2);
      if (u1Died && !u2Died) {
        killedSet.add(u2);
        loversFollowerUserIds.push(u2);
        logs.push(`[恋人後追い] 愛する者の死に伴い後追い死亡しました (User: ${u2})`);
      } else if (u2Died && !u1Died) {
        killedSet.add(u1);
        loversFollowerUserIds.push(u1);
        logs.push(`[恋人後追い] 愛する者の死に伴い後追い死亡しました (User: ${u1})`);
      }
    };

    if (context.loversUserIds) {
      checkLoversPair(context.loversUserIds[0], context.loversUserIds[1]);
    }
    if (context.femmeFataleData) {
      // 悪女と本命の後追い
      checkLoversPair(context.femmeFataleData.femmeFataleId, context.femmeFataleData.honeyId);
    }

    // 10. 女王崩御の市民ショック死
    let queenDied = false;
    const queenShockKilledUserIds: string[] = [];
    let livingSpiritInheritedQueenUserId: string | undefined;

    if (context.queenUserId && killedSet.has(context.queenUserId)) {
      queenDied = true;
      logs.push(`[女王崩御] 女王が死亡しました (Queen: ${context.queenUserId})`);

      // 生霊が女王に憑依していたか確認
      let hasSpiritInherited = false;
      if (context.livingSpiritData) {
        for (const [spiritId, targetId] of Object.entries(context.livingSpiritData)) {
          if (targetId === context.queenUserId && !killedSet.has(spiritId)) {
            // 生霊が新女王に昇格！
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
        // ショック死: 市民陣営全員が死亡
        const citizenRoles = [
          'villager', 'seer', 'medium', 'knight', 'apprentice_seer', 'reckless_seer',
          'mason', 'nekomata', 'baker', 'hunter', 'dictator', 'tough_guy', 'trapper',
          'counselor', 'apprentice_diviner', 'queen'
        ];
        for (const p of alivePlayers) {
          if (!killedSet.has(p.userId)) {
            const r = getRole(p.userId);
            if (r && citizenRoles.includes(r.id)) {
              killedSet.add(p.userId);
              queenShockKilledUserIds.push(p.userId);
              logs.push(`[女王ショック死] 女王崩御に伴い市民がショック死しました (User: ${p.userId})`);
            }
          }
        }
      }
    }

    // 11. 妖狐全滅時の狐憑きの後追い判定
    const foxFollowerUserIds: string[] = [];
    const remainingAliveFoxes = alivePlayers.filter(p => {
      const r = getRole(p.userId);
      return r?.id === 'fox' && !killedSet.has(p.userId);
    });

    if (remainingAliveFoxes.length === 0) {
      const aliveFoxPossessed = alivePlayers.filter(p => {
        const r = getRole(p.userId);
        return r?.id === 'fox_possessed' && !killedSet.has(p.userId);
      });
      for (const fp of aliveFoxPossessed) {
        killedSet.add(fp.userId);
        foxFollowerUserIds.push(fp.userId);
        logs.push(`[狐憑き後追い] 妖狐が全滅したため後追い死亡しました (User: ${fp.userId})`);
      }
    }

    return {
      killedUserIds: Array.from(killedSet),
      guardedUserId,
      guardSuccess,
      recklessGuardedPierceKill,
      cursedFoxUserIds,
      foxFollowerUserIds,
      seerResults,
      foxProtectedSuccess,
      foxPossessedUserId,
      logs,
      trappedWolfUserId,
      counselorReformedUserId,
      counselorDiedUserId,
      spyBlockedUserId,
      toughGuyPoisonedUserIds,
      targetedCivilianInfectedUserId,
      berserkWolfDiedUserId,
      loversFollowerUserIds,
      queenDied,
      queenShockKilledUserIds,
      livingSpiritInheritedQueenUserId,
      hunterRevengeKilledUserIds
    };
  }
}

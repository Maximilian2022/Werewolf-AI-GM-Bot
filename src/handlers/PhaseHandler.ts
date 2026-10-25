// @ts-nocheck
/**
 * src/handlers/PhaseHandler.ts
 * 命名ライフサイクル追従 ＆ プレイヤー自発入室復旧対応完全版
 */
import { 
  Client, TextChannel, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags,
  ComponentType, Guild, VoiceBasedChannel, PermissionsBitField,
  StringSelectMenuInteraction, ButtonBuilder, ButtonStyle, ButtonInteraction
} from 'discord.js';
import { StateManager } from '../state/StateManager.js';
import { ActionQueue } from '../state/ActionQueue.js';
import { TTSService } from '../services/TTSService.js';
import { VoiceService } from '../services/VoiceService.js';
import { DiscordService } from '../services/DiscordService.js';
import { WorkerManager } from '../managers/WorkerManager.js';
import { VCWatcher } from '../managers/VCWatcher.js';
import { AIService } from '../services/AIService.js';
import { RoleRegistry } from '../roles/RoleRegistry.js';
import { RegulationManager } from '../regulations/RegulationManager.js';
import { PRESET_REGULATIONS } from '../regulations/presets.js';
import { NightActionResolver } from '../engine/NightActionResolver.js';
import { ExecutionResolver } from '../engine/ExecutionResolver.js';
import { WinConditionChecker } from '../engine/WinConditionChecker.js';
import { WinningTeam } from '../engine/types.js';
import { GAME_CONSTANTS } from '../constants.js';
import { Player, GameState } from '../types.js';
import { Logger } from '../utils/logger.js';
import { MSG } from '../messages.js';
import { SettingsManager, GameSettings } from '../managers/SettingsManager.js';
import { secureShuffle, secureRandom, secureSample } from '../utils/cryptoRandom.js';

export class PhaseHandler {
  private static getSysTimeMs(settings: GameSettings) {
    return {
      LAST_WORD: settings.lastWordMin * 60 * 1000,
      CLEANUP_DELAY: settings.cleanupDelayMin * 60 * 1000
    };
  }

  private static shuffleArray<T>(array: T[]): T[] {
    return secureShuffle([...array]);
  }


  private static checkWinCondition(state: GameState, specialWin?: { undertakerWin?: boolean; foolWin?: boolean }): WinningTeam {
    return WinConditionChecker.check(state.players, specialWin, {
      loversUserIds: state.loversUserIds,
      femmeFataleData: state.femmeFataleData,
      livingSpiritData: state.livingSpiritData,
      queenUserId: state.queenUserId
    });
  }

  private static splitMessage(text: string, maxLength = 1900): string[] {
    if (text.length <= maxLength) return [text];
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      if ((current.length + line.length + 1) > maxLength) {
        chunks.push(current);
        current = line + '\n';
      } else {
        current += line + '\n';
      }
    }
    if (current.trim().length > 0) chunks.push(current);
    return chunks;
  }

  private static async sendToPersonalChannel(guild: Guild, userId: string, messageOptions: any): Promise<any> {
    const state = StateManager.getInstance().getState();
    const playerEnv = state.players.find(p => p.userId === userId);
    if (!playerEnv || !playerEnv.personalTextChannelId) return null;
    const channel = await guild.channels.fetch(playerEnv.personalTextChannelId).catch(() => null) as TextChannel;
    if (channel) return await channel.send(messageOptions).catch(() => null);
    return null;
  }

  private static async waitWithPauseAndCondition(totalMs: number, condition: () => boolean = () => false): Promise<void> {
    let elapsed = 0;
    const intervalMs = 500;
    while (elapsed < totalMs) {
      if (condition()) break;
      const state = StateManager.getInstance().getState();
      if (!state.isPaused) elapsed += intervalMs;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  private static async syncLedgerAndMove(guild: Guild, gameId: string, phaseType: 'setup' | 'day' | 'night' | 'lobby' | 'finish', killedTonightId?: string | null) {
    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();
    const expected: Record<string, string> = {};

    for (const player of state.players) {
      if (player.userId === killedTonightId) {
        expected[player.userId] = state.mainVcId;
      } else if (!player.isAlive) {
        expected[player.userId] = (phaseType === 'lobby') ? state.originalVcId : (phaseType === 'finish' ? state.mainVcId : state.ghostVcId);
      } else if (phaseType === 'setup') {
        expected[player.userId] = player.waitVcId;
      } else if (phaseType === 'day' || phaseType === 'finish') {
        expected[player.userId] = state.mainVcId;
      } else if (phaseType === 'night') {
        expected[player.userId] = player.role === '人狼' ? state.wolfVcId : player.waitVcId;
      } else if (phaseType === 'lobby') {
        expected[player.userId] = state.originalVcId;
      }
    }
    stateManager.updateState({ expectedVcIds: expected });
    
    if (state.isDebug) {
      Logger.info('PhaseHandler', `📋 [台帳更新: ${phaseType}] \n${JSON.stringify(expected, null, 2)}`, gameId);
    }

    const actionQueue = ActionQueue.getInstance();
    const workers = WorkerManager.getInstance().getWorkers();

    for (const player of state.players) {
      actionQueue.add(async () => {
        const targetVcId = expected[player.userId];
        const member = guild.members.cache.get(player.userId) || await guild.members.fetch(player.userId).catch(() => null);
        if (member) {
          // 🚨 廃村時・終了時にボットはロビーに戻さずVCから切断する
          if (phaseType === 'lobby' && member.user.bot) {
            if (member.voice.channelId) {
              await member.voice.disconnect().catch(() => {});
            }
            return;
          }

          // 🚨 修正：Discordの仕様回避。VC未接続のメンバーへのsetChannelは不発になるため、
          // デバッグ時かつ対象がプレイヤーWorkerかつ未接続なら、Bot自身から自発接続させる
          if (!member.voice.channelId && state.isDebug) {
            const workerClient = workers.find(w => w.user?.id === player.userId);
            if (workerClient) {
              const targetChannel = await guild.channels.fetch(targetVcId).catch(() => null) as VoiceBasedChannel;
              if (targetChannel && targetChannel.isVoiceBased()) {
                await VoiceService.connectWithClient(workerClient, targetChannel, gameId, `self_resume_join`);
                return;
              }
            }
          }
          // すでにどこかの部屋にいる通常ケース、または人間プレイヤーはsetChannelで移動
          if (member.voice.channelId && member.voice.channelId !== targetVcId) {
            await member.voice.setChannel(targetVcId).catch(() => {});
          }
        }
      }, `sync-move-${player.userId}`);
    }
    await actionQueue.waitForEmpty();
  }

  public static async startRoleDistribution(gmClient: Client, assistantClient: Client, gameId: string): Promise<void> {
    Logger.info('PhaseHandler', `🎭 役職配布フェーズを開始します...`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const settings = state.settingsSnapshot;

    const regMgr = RegulationManager.getInstance();
    const currentReg = (state.regulationId ? regMgr.get(state.regulationId) : null) 
      || regMgr.getByPlayerCount(state.players.length)[0] 
      || PRESET_REGULATIONS[0];

    // レギュレーション独自の時間設定があれば settingsSnapshot に反映
    let settingsSnapshot = state.settingsSnapshot;
    if (currentReg.times) {
      settingsSnapshot = { ...settingsSnapshot, ...currentReg.times };
    }

    // 📜 レギュレーション読み上げの有効化判定 (レギュレーション設定優先、なければ全体設定、デフォルトtrue)
    const sysSettings = SettingsManager.getInstance().getSystem();
    const isAnnouncementEnabled = currentReg.system?.enableRegulationAnnouncement !== undefined
      ? currentReg.system.enableRegulationAnnouncement
      : (sysSettings.enableRegulationAnnouncement !== false);

    const originalVc = await guild.channels.fetch(state.originalVcId) as VoiceBasedChannel;
    if (originalVc && originalVc.isVoiceBased()) {
      const connection = await VoiceService.connectWithClient(gmClient, originalVc, gameId, 'lobby');
      
      let greetingText: string;
      if (isAnnouncementEnabled) {
        // 役職構成サマリーの生成 (標準的な順序で並べる)
        const roleOrder = ['村人', '人狼', '占い師', '騎士', '霊媒師', '狂人', '狂信者', '共有者', '妖狐', '背徳者', '猫又', 'てるてる坊主', '棺桶屋', '未熟な占い師', '無謀な占い師', '狐憑き', 'パン屋'];
        const roleParts: string[] = [];
        
        for (const rName of roleOrder) {
          const count = currentReg.roles[rName] || 0;
          if (count > 0) roleParts.push(`${rName}${count}名`);
        }
        for (const [rName, count] of Object.entries(currentReg.roles)) {
          if (count > 0 && !roleOrder.includes(rName)) {
            roleParts.push(`${rName}${count}名`);
          }
        }
        const rolesSummary = roleParts.join('、') || '役職なし';

        // 主要ルールの要約
        const ruleParts: string[] = [];
        if (currentReg.rules) {
          if (currentReg.rules.firstNightDivination === 'white_npc') ruleParts.push('初日のお告げあり');
          else if (currentReg.rules.firstNightDivination === 'free') ruleParts.push('初日自由占いあり');
          else if (currentReg.rules.firstNightDivination === 'none') ruleParts.push('初日占いなし');

          if (currentReg.rules.consecutiveGuard) ruleParts.push('連続護衛可能');
          else ruleParts.push('連続護衛なし');
        }
        const rulesSummary = ruleParts.join('、');

        greetingText = MSG.VOICE.REGULATION_ANNOUNCE({
          playerCount: currentReg.playerCount || state.players.length,
          rolesSummary,
          rulesSummary,
          day1DiscussionMin: settingsSnapshot.day1DiscussionMin
        });
      } else {
        greetingText = MSG.VOICE.GREETING;
      }

      const audio = await TTSService.generateAudio(greetingText, gameId, isAnnouncementEnabled ? 'reg_announce' : 'greeting');
      await VoiceService.playAudio(connection, audio, gameId);
      await new Promise(resolve => setTimeout(resolve, 1000));
      connection.destroy();
      Logger.info('PhaseHandler', '🚪 GMがロビーVCから退出しました', gameId);
    }

    let updatedPlayers = state.players;
    if (state.players.some(p => p.role === null)) {
      const rolesToAssign = regMgr.expandRoleList(currentReg);
      const shuffledRoles = this.shuffleArray(rolesToAssign);
      updatedPlayers = state.players.map((player: Player, index: number) => ({
        ...player, 
        role: shuffledRoles[index] || '村人',
      }));

      const roleMapPromises = updatedPlayers.map(async p => {
        const m = guild.members.cache.get(p.userId) || await guild.members.fetch(p.userId).catch(() => null);
        return `${m?.displayName || '不明'}:${p.role}`;
      });
      const rolesStr = (await Promise.all(roleMapPromises)).join(', ');
      
      stateManager.updateState({ 
        players: updatedPlayers, 
        day: 1, 
        settingsSnapshot,
        eventLogs: [`[セットアップ] 実際の配役: ${rolesStr}`] 
      });
    } else {
      Logger.info('PhaseHandler', '🎭 役職は既に配布済みのため、再配布をスキップします', gameId);
    }

    // 🚨 プレイヤー名に依存するセリフのプリフェッチ (裏で実行)
    (async () => {
      try {
        const names = (await Promise.all(updatedPlayers.map(p => guild.members.cache.get(p.userId) || guild.members.fetch(p.userId).catch(() => null))))
          .map(m => m?.displayName)
          .filter(n => n) as string[];
        const sm = SettingsManager.getInstance();
        TTSService.prefetchDynamicAudios(names, sm.get(false), sm.get(true));
      } catch (e) {}
    })();

    // 🚨 デバッグ時：プレイヤー役に抜擢されたWorkerの名前を「人狼ゲームプレイヤーXX」に一括変更
    if (state.isDebug) {
      const wm = WorkerManager.getInstance();
      for (const p of updatedPlayers) {
        const pWorker = wm.getWorkers().find(w => w.user?.id === p.userId);
        if (pWorker) await wm.renameWorker(pWorker, state.serverId, 'プレイヤー');
      }
    }

    await this.syncLedgerAndMove(guild, gameId, 'setup');

    for (const player of state.players) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(player.userId);
          if (member.voice.channelId) await member.voice.setMute(true);
        } catch (e) {}
      }, `initial-mute-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    await voteChannel.send(MSG.CHAT.SYS_START_ROLE);

    const wolfTextCh = await guild.channels.fetch(state.wolfTextChannelId) as TextChannel;
    const wolves = updatedPlayers.filter(p => p.role === '人狼');
    for (const w of wolves) {
      await wolfTextCh.permissionOverwrites.create(w.userId, { ViewChannel: true, SendMessages: false });
    }

    // 初日占い（お告げ・白通知）の判定
    const isWhiteNpcRule = currentReg.rules?.firstNightDivination === 'white_npc';

    const seer = updatedPlayers.find(p => p.role === '占い師' || p.role === '未熟な占い師' || p.role === '無謀な占い師');
    let firstWhiteTarget: Player | null = null;
    if (seer && isWhiteNpcRule) {
      const currentState = stateManager.getState();
      if (currentState.firstWhiteTargetId) {
        firstWhiteTarget = updatedPlayers.find(p => p.userId === currentState.firstWhiteTargetId) || null;
      }
      if (!firstWhiteTarget) {
        const safeTargets = updatedPlayers.filter(p => p.role !== '人狼' && p.role !== '占い師' && p.role !== '未熟な占い師' && p.role !== '無謀な占い師');
        firstWhiteTarget = this.shuffleArray(safeTargets)[0] || null;
        if (firstWhiteTarget) {
          stateManager.updateState({ firstWhiteTargetId: firstWhiteTarget.userId });
        }
      }
    }

    // 女王の確認
    const queenPlayer = updatedPlayers.find(p => p.role === '女王');
    if (queenPlayer) {
      stateManager.updateState({ queenUserId: queenPlayer.userId });
    }
    const queenMember = queenPlayer ? await guild.members.fetch(queenPlayer.userId).catch(() => null) : null;

    // 神様への通知（全員の役職）
    const godPlayer = updatedPlayers.find(p => p.role === '神様');
    if (godPlayer) {
      (async () => {
        const allRolesText = (await Promise.all(updatedPlayers.map(async p => {
          const m = await guild.members.fetch(p.userId).catch(() => null);
          return `・${m?.displayName || '不明'}: **${p.role}**`;
        }))).join('\n');
        await this.sendToPersonalChannel(guild, godPlayer.userId, MSG.CHAT.DM_GOD_INFO(allRolesText));
      })();
    }

    // 人狼一覧の名前取得（狂信者・内通者・眷属案内用）
    const wolfNames = (await Promise.all(wolves.map(async w => {
      const m = await guild.members.fetch(w.userId).catch(() => null);
      return m?.displayName || '不明な人狼';
    }))).join('、');

    // 共有者一覧（共有者案内用）
    const masons = updatedPlayers.filter(p => p.role === '共有者');

    const roleReg = RoleRegistry.getInstance();
    const citizenRolesList = [
      '村人', '占い師', '霊媒師', '騎士', '未熟な占い師', '無謀な占い師',
      '共有者', '猫又', 'パン屋', 'ハンター', '独裁者', 'タフガイ', '罠師',
      'カウンセラー', '占い師の弟子'
    ];

    for (const player of updatedPlayers) {
      actionQueue.add(async () => {
        const roleObj = roleReg.get(player.role as string);
        let message = MSG.CHAT.DM_ROLE_HEADER + MSG.CHAT.DM_ROLE_YOUR_ROLE(player.role as string);

        if (player.role === '人狼' || player.role === '人狼の子ども' || player.role === '凶暴な狼') {
          message += MSG.CHAT.DM_ROLE_WOLF_GUIDE;
        } else if (player.role === '狂信者' || player.role === '内通者') {
          message += `\n👁️ あなたは【${player.role}】です。仲間の人狼は **${wolfNames || 'なし'}** です。\n人狼の勝利を目指して立ち回ってください。`;
        } else if (player.role === '狼の眷属') {
          message += `\n🐕 あなたは【狼の眷属】です。仲間の人狼は **${wolfNames || 'なし'}** です。\n毎晩人狼VCに入って通話・作戦会議に参加できます。`;
        } else if (player.role === '一匹狼') {
          message += `\n🐺 あなたは【一匹狼】です。通常の人狼VCには参加しません。\n通常の人狼が全滅し、かつあなたが最後まで生き残れば単独勝利となります。`;
        } else if (player.role === '共有者') {
          const partner = masons.find(m => m.userId !== player.userId);
          const partnerMember = partner ? await guild.members.fetch(partner.userId).catch(() => null) : null;
          message += `\n🤝 あなたは【共有者】です。もう1人の共有者は **${partnerMember?.displayName || 'なし'}** です。`;
        } else if ((player.role === '占い師' || player.role === '未熟な占い師' || player.role === '無謀な占い師') && firstWhiteTarget) {
          const targetMember = await guild.members.fetch(firstWhiteTarget.userId).catch(() => null);
          if (targetMember) message += MSG.CHAT.DM_ROLE_SEER_FIRST(targetMember.displayName);
        } else if (roleObj) {
          message += `\n📖 **役職説明:** ${roleObj.description}`;
        }

        // 市民陣営への女王認知通知
        if (queenMember && citizenRolesList.includes(player.role as string)) {
          message += `\n` + MSG.CHAT.DM_QUEEN_INFO(queenMember.displayName);
        }
        
        message += MSG.CHAT.DM_ROLE_WAIT;
        await this.sendToPersonalChannel(guild, player.userId, message);
      }, `distribute-role-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    await this.syncLedgerAndMove(guild, gameId, 'night');

    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const wolfVc = await assistantGuild.channels.fetch(state.wolfVcId).catch(()=>null) as VoiceBasedChannel;
    
    const playerIds = state.players.map((p: Player) => p.userId);
    const freeWorkers = await WorkerManager.getInstance().getFreeWorkers(state.serverId, playerIds, 6);
    
    const wolfWorkerClient = freeWorkers.length > 0 ? freeWorkers.shift()! : assistantClient; 
    const seerWorkerClient = freeWorkers.length > 0 ? freeWorkers.shift()! : assistantClient;
    const cupidWorkerClient = freeWorkers.length > 0 ? freeWorkers.shift()! : null;
    const femmeWorkerClient = freeWorkers.length > 0 ? freeWorkers.shift()! : null;
    const spiritWorkerClient = freeWorkers.length > 0 ? freeWorkers.shift()! : null;

    let nightWorkerConn: any = null;

    if (wolfVc) {
      Logger.info('PhaseHandler', `🐺 [初日人狼内通スタッフ配置] - 担当: ${wolfWorkerClient.user?.tag || 'なし'}`, gameId);
      nightWorkerConn = await VoiceService.connectWithClient(wolfWorkerClient, wolfVc, gameId, 'first_wolf');
      if (nightWorkerConn) nightWorkerConn._isBusy = true;
    }

    // 人狼VC参加権限: 人狼、人狼の子ども、凶暴な狼、狼の眷属（※一匹狼は除外）
    const wolfRolesForVc = ['人狼', '人狼の子ども', '凶暴な狼', '狼の眷属'];
    const aliveWolves = stateManager.getState().players.filter((p: Player) => wolfRolesForVc.includes(p.role as string) && p.isAlive);
    for (const wolf of aliveWolves) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(wolf.userId);
          if (member.voice.channelId) await member.voice.setMute(false);
        } catch (e) {}
      }, `unmute-first-wolf-${wolf.userId}`);
    }
    await actionQueue.waitForEmpty();

    if (nightWorkerConn && wolfWorkerClient) {
      await new Promise(resolve => setTimeout(resolve, 1000)); 
      const audio = await TTSService.generateAudio(MSG.VOICE.WOLF_MEET(settings.wolfMeetingMin), gameId, 'first_wolf_meet');
      await VoiceService.playAudio(nightWorkerConn, audio, gameId);
    }

    if (seer && firstWhiteTarget) {
      const seerVc = await guild.channels.fetch(seer.waitVcId).catch(()=>null) as VoiceBasedChannel;
      if (seerVc) {
        Logger.info('PhaseHandler', `🔮 [初日占い師アナウンススタッフ配置] - 担当: ${seerWorkerClient.user?.tag || 'なし'}`, gameId);
        const seerConn = await VoiceService.connectWithClient(seerWorkerClient, seerVc, gameId, 'first_seer');
        if (seerConn) seerConn._isBusy = true;
        await new Promise(r => setTimeout(r, 1000));
        const targetMember = await guild.members.fetch(firstWhiteTarget.userId).catch(()=>null);
        if (targetMember) {
          const seerAudio = await TTSService.generateAudio(MSG.VOICE.SEER_FIRST(targetMember.displayName), gameId, 'first_seer_res');
          await VoiceService.playAudio(seerConn, seerAudio, gameId);
        }
        if (seerConn) seerConn._isBusy = false;
        
        const isFree = WorkerManager.getInstance().getWorkers().some(w => w.user?.id === seerWorkerClient.user?.id && !playerIds.includes(w.user!.id));
        if (isFree) {
          try {
            VoiceService.disconnectClient(seerWorkerClient, gameId);
          } catch(e) {}
        }
      }
    }

    // キューピット、悪女、生霊の初日夜選択アクション
    const cupidPlayer = updatedPlayers.find(p => p.role === 'キューピット');
    const femmeFatalePlayer = updatedPlayers.find(p => p.role === '悪女');
    const livingSpiritPlayer = updatedPlayers.find(p => p.role === '生霊');

    const firstNightActionPromises: Promise<void>[] = [];

    if (cupidPlayer) {
      firstNightActionPromises.push((async () => {
        try {
          const cupidVc = await guild.channels.fetch(cupidPlayer.waitVcId).catch(() => null) as VoiceBasedChannel;
          let cupidConn: any = null;
          if (cupidVc && cupidWorkerClient) {
            cupidConn = await VoiceService.connectWithClient(cupidWorkerClient, cupidVc, gameId, 'first_cupid');
            if (cupidConn) cupidConn._isBusy = true;
            await new Promise(r => setTimeout(r, 1000));
            const promptAudio = await TTSService.generateAudio(MSG.VOICE.PROMPT_CUPID, gameId, 'cupid_prompt');
            await VoiceService.playAudio(cupidConn, promptAudio, gameId);
          }

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('cupid_select')
            .setPlaceholder('恋人にする2名を選択')
            .setMinValues(2)
            .setMaxValues(2);
          for (const p of updatedPlayers) {
            const m = await guild.members.fetch(p.userId).catch(() => null);
            if (m) selectMenu.addOptions({ label: m.displayName, value: p.userId });
          }
          const msg = await this.sendToPersonalChannel(guild, cupidPlayer.userId, {
            content: '💘 **【キューピットの恋人の矢】**\n運命を共にする恋人2名を選択してください：',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
          });
          if (msg) {
            const i = await msg.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: settings.wolfMeetingMin * 60000 }).catch(() => null);
            if (i) {
              const [p1Id, p2Id] = i.values;
              stateManager.updateState({ loversUserIds: [p1Id, p2Id] });
              await i.deferUpdate().catch(() => {});
              await msg.delete().catch(() => {});
              const m1 = await guild.members.fetch(p1Id).catch(() => null);
              const m2 = await guild.members.fetch(p2Id).catch(() => null);
              await this.sendToPersonalChannel(guild, p1Id, MSG.CHAT.DM_LOVERS_INFO(m2?.displayName || '不明'));
              await this.sendToPersonalChannel(guild, p2Id, MSG.CHAT.DM_LOVERS_INFO(m1?.displayName || '不明'));

              if (cupidConn) {
                const setAudio = await TTSService.generateAudio(MSG.VOICE.CUPID_TARGET_SET(m1?.displayName || '不明', m2?.displayName || '不明'), gameId, 'cupid_set');
                await VoiceService.playAudio(cupidConn, setAudio, gameId);
                cupidConn._isBusy = false;
                try { VoiceService.disconnectClient(cupidWorkerClient, gameId); } catch(e) {}
              }
            }
          }
        } catch (e) {}
      })());
    }

    if (femmeFatalePlayer) {
      firstNightActionPromises.push((async () => {
        try {
          const ffVc = await guild.channels.fetch(femmeFatalePlayer.waitVcId).catch(() => null) as VoiceBasedChannel;
          let ffConn: any = null;
          if (ffVc && femmeWorkerClient) {
            ffConn = await VoiceService.connectWithClient(femmeWorkerClient, ffVc, gameId, 'first_femme');
            if (ffConn) ffConn._isBusy = true;
            await new Promise(r => setTimeout(r, 1000));
            const promptAudio = await TTSService.generateAudio(MSG.VOICE.PROMPT_FEMME_FATALE, gameId, 'femme_prompt');
            await VoiceService.playAudio(ffConn, promptAudio, gameId);
          }

          const others = updatedPlayers.filter(p => p.userId !== femmeFatalePlayer.userId);
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('femme_fatale_select')
            .setPlaceholder('本命1名を選択')
            .setMinValues(1)
            .setMaxValues(1);
          for (const p of others) {
            const m = await guild.members.fetch(p.userId).catch(() => null);
            if (m) selectMenu.addOptions({ label: m.displayName, value: p.userId });
          }
          const msg = await this.sendToPersonalChannel(guild, femmeFatalePlayer.userId, {
            content: '💋 **【悪女の誘惑】**\nあなたの「本命」を1名選択してください：',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
          });
          if (msg) {
            const i = await msg.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: settings.wolfMeetingMin * 60000 }).catch(() => null);
            if (i) {
              const honeyId = i.values[0];
              const pawnIds = others.filter(p => p.userId !== honeyId).map(p => p.userId);
              stateManager.updateState({
                femmeFataleData: { femmeFataleId: femmeFatalePlayer.userId, honeyId, pawnIds }
              });
              await i.deferUpdate().catch(() => {});
              await msg.delete().catch(() => {});
              const ffMember = await guild.members.fetch(femmeFatalePlayer.userId).catch(() => null);
              const honeyMember = await guild.members.fetch(honeyId).catch(() => null);
              await this.sendToPersonalChannel(guild, honeyId, MSG.CHAT.DM_LOVERS_INFO(ffMember?.displayName || '悪女'));
              for (const pawnId of pawnIds) {
                await this.sendToPersonalChannel(guild, pawnId, MSG.CHAT.DM_LOVERS_INFO(ffMember?.displayName || '悪女'));
              }

              if (ffConn) {
                const setAudio = await TTSService.generateAudio(MSG.VOICE.FEMME_FATALE_TARGET_SET(honeyMember?.displayName || '本命'), gameId, 'femme_set');
                await VoiceService.playAudio(ffConn, setAudio, gameId);
                ffConn._isBusy = false;
                try { VoiceService.disconnectClient(femmeWorkerClient, gameId); } catch(e) {}
              }
            }
          }
        } catch (e) {}
      })());
    }

    if (livingSpiritPlayer) {
      firstNightActionPromises.push((async () => {
        try {
          const spiritVc = await guild.channels.fetch(livingSpiritPlayer.waitVcId).catch(() => null) as VoiceBasedChannel;
          let spiritConn: any = null;
          if (spiritVc && spiritWorkerClient) {
            spiritConn = await VoiceService.connectWithClient(spiritWorkerClient, spiritVc, gameId, 'first_spirit');
            if (spiritConn) spiritConn._isBusy = true;
            await new Promise(r => setTimeout(r, 1000));
            const promptAudio = await TTSService.generateAudio(MSG.VOICE.PROMPT_LIVING_SPIRIT, gameId, 'spirit_prompt');
            await VoiceService.playAudio(spiritConn, promptAudio, gameId);
          }

          const others = updatedPlayers.filter(p => p.userId !== livingSpiritPlayer.userId && p.role !== '生霊');
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('living_spirit_select')
            .setPlaceholder('憑依する対象を1名選択')
            .setMinValues(1)
            .setMaxValues(1);
          for (const p of others) {
            const m = await guild.members.fetch(p.userId).catch(() => null);
            if (m) selectMenu.addOptions({ label: m.displayName, value: p.userId });
          }
          const msg = await this.sendToPersonalChannel(guild, livingSpiritPlayer.userId, {
            content: '👻 **【生霊の憑依】**\n憑依する対象を1名選択してください（その人物が死亡した際、役職を引き継ぎます）：',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
          });
          if (msg) {
            const i = await msg.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: settings.wolfMeetingMin * 60000 }).catch(() => null);
            if (i) {
              const targetId = i.values[0];
              const currentSpiritData = stateManager.getState().livingSpiritData || {};
              stateManager.updateState({
                livingSpiritData: { ...currentSpiritData, [livingSpiritPlayer.userId]: targetId }
              });
              await i.deferUpdate().catch(() => {});
              await msg.delete().catch(() => {});
              const tMember = await guild.members.fetch(targetId).catch(() => null);
              await this.sendToPersonalChannel(guild, livingSpiritPlayer.userId, `✅ **${tMember?.displayName || '対象'}** に憑依しました。対象が死亡した瞬間に能力を引き継ぎます。`);

              if (spiritConn) {
                const setAudio = await TTSService.generateAudio(MSG.VOICE.LIVING_SPIRIT_TARGET_SET(tMember?.displayName || '対象'), gameId, 'spirit_set');
                await VoiceService.playAudio(spiritConn, setAudio, gameId);
                spiritConn._isBusy = false;
                try { VoiceService.disconnectClient(spiritWorkerClient, gameId); } catch(e) {}
              }
            }
          }
        } catch (e) {}
      })());
    }

    let firstNightTargetUnixTime = Math.floor(Date.now() / 1000) + (settings.wolfMeetingMin * 60);
    const firstNightTimerMsg = await wolfTextCh.send(MSG.CHAT.NIGHT_WOLF_TIMER_START(firstNightTargetUnixTime));

    const firstNightInterval = setInterval(async () => {
        const currentState = StateManager.getInstance().getState();
        if (currentState.isPaused) {
            firstNightTargetUnixTime += 2;
        } else {
            const remainSec = Math.max(0, firstNightTargetUnixTime - Math.floor(Date.now() / 1000));
            const m = Math.floor(remainSec / 60);
            const sStr = (remainSec % 60).toString().padStart(2, '0');
            const progress = Math.floor((remainSec / (settings.wolfMeetingMin * 60)) * 20);
            const bar = '█'.repeat(progress) + '░'.repeat(20 - progress);
            const timeText = remainSec > 0 ? `<t:${firstNightTargetUnixTime}:R>` : `**【終了済】**`;
            await firstNightTimerMsg.edit(MSG.CHAT.NIGHT_WOLF_TIMER_UPDATE(timeText, bar, m, sStr)).catch(()=>{});
        }
    }, 5000);

    let wolfElapsed = 0;
    const wolfTotal = settings.wolfMeetingMin * 60000;
    while(wolfElapsed < wolfTotal) {
        const currentState = StateManager.getInstance().getState();
        if (!currentState.isPaused) wolfElapsed += 1000;
        await new Promise(r => setTimeout(r, 1000));
    }
    clearInterval(firstNightInterval);
    await firstNightTimerMsg.edit(MSG.CHAT.NIGHT_WOLF_TIMER_UPDATE(`**【終了済】**`, '░'.repeat(20), 0, '00')).catch(()=>{});

    for (const wolf of aliveWolves) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(wolf.userId);
          if (member.voice.channelId) await member.voice.setMute(true);
        } catch (e) {}
      }, `mute-first-wolf-${wolf.userId}`);
    }
    await actionQueue.waitForEmpty();

    if (nightWorkerConn && wolfWorkerClient) {
      const endAudio = await TTSService.generateAudio(MSG.VOICE.WOLF_MEET_END, gameId, 'first_wolf_meet_end');
      await VoiceService.playAudio(nightWorkerConn, endAudio, gameId);
      nightWorkerConn._isBusy = false;

      const isFree = WorkerManager.getInstance().getWorkers().some(w => w.user?.id === wolfWorkerClient.user?.id && !playerIds.includes(w.user!.id));
      if (isFree) {
        try {
          VoiceService.disconnectClient(wolfWorkerClient, gameId);
        } catch(e) {}
      }
    }
    
    await this.waitWithPauseAndCondition(1000, () => false);

    stateManager.nextPhase('day_discussion');
    await this.startDayDiscussion(gmClient, assistantClient, gameId);
  }

  public static async startDayDiscussion(gmClient: Client, assistantClient: Client, gameId: string): Promise<void> {
    Logger.info('PhaseHandler', `☀️ 昼議論フェーズを開始します...`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    const settings = state.settingsSnapshot;

    await this.syncLedgerAndMove(guild, gameId, 'day');

    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    for (const player of alivePlayers) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(player.userId);
          if (member.voice.channelId) await member.voice.setMute(false);
        } catch (e) {}
      }, `unmute-main-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    try {
      const mainVc = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
      const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
      const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;

      if (mainVc && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVc, gameId, 'main');
        await new Promise(r => setTimeout(r, 500)); 

        const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
        await new Promise(r => setTimeout(r, 500)); 

        const broadcastConns = [gmConnection, assistantConnection];

        const wm = WorkerManager.getInstance();
        const workers = wm.getWorkers();
        let recordClient = state.recorderWorkerId ? workers.find(w => w.user?.id === state.recorderWorkerId) : null;

        if (!recordClient) {
          const playerIds = state.players.map((p: Player) => p.userId);
          const freeWorkers = await wm.getFreeWorkers(state.serverId, playerIds, 1);
          
          if (freeWorkers.length > 0) recordClient = freeWorkers.shift();
          
          stateManager.updateState({
            recorderWorkerId: recordClient?.user?.id
          });
          Logger.info('PhaseHandler', `👷 [スタッフ雇用] 録音/中継: ${recordClient?.user?.tag || 'なし'}`, gameId);
        }

        // 常に中継機能をセットアップする
        VoiceService.setupDynamicRelay(state.ghostVcId, gameId);

        if (recordClient) {
          const recordConn = await VoiceService.connectWithClient(recordClient, mainVc, gameId, 'recorder');
          await new Promise(r => setTimeout(r, 500)); 
          VoiceService.startRecording(recordConn, gameId);
          
          // 🚨 日数に関わらず、アサインされたタイミングで即「書記」にリネーム
          await wm.renameWorker(recordClient, state.serverId, '書記');
        } else {
          VoiceService.startRecording(gmConnection, gameId);
        }

        let dayTimeMinutes = state.day === 1 
            ? settings.day1DiscussionMin 
            : Math.max(settings.day2DiscussionMin - (state.day - 2) * settings.dayDecreaseMin, state.isDebug ? 0.166 : 1);
        
        if (state.isResumedBonus) {
            dayTimeMinutes += 1;
            state.isResumedBonus = false; 
            stateManager.updateState(state);
        }

        const totalDiscussionMs = dayTimeMinutes * 60 * 1000;
        let targetUnixTime = Math.floor((Date.now() + totalDiscussionMs) / 1000);

        const startAudio = await TTSService.generateAudio(MSG.VOICE.DAY_START(state.day, dayTimeMinutes), gameId, `day_start_${state.day}`);
        await VoiceService.broadcastAudio(broadcastConns, startAudio, gameId);

        const timerMsg = await voteChannel.send(MSG.CHAT.DAY_TIMER_START(state.day, targetUnixTime));

        // 独裁者COボタンのセットアップ
        let dictatorTriggered = false;
        let dictatorTargetId: string | null = null;
        let dictatorMsg: any = null;

        const dictatorPlayer = alivePlayers.find(p => p.role === '独裁者');
        if (dictatorPlayer && !state.dictatorUsed) {
          const dictatorBtn = new ButtonBuilder()
            .setCustomId('dictator_co_btn')
            .setLabel(MSG.CHAT.DICTATOR_BUTTON_LABEL)
            .setStyle(ButtonStyle.Danger);
          dictatorMsg = await this.sendToPersonalChannel(guild, dictatorPlayer.userId, {
            content: '👑 **【独裁者CO】**\nこのボタンを押すと、昼の議論を強制終了し、独断で即時処刑を実行できます（ゲーム中1回のみ）：',
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(dictatorBtn)]
          });
          if (dictatorMsg) {
            const collector = dictatorMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: totalDiscussionMs });
            collector.on('collect', async (btnInt: ButtonInteraction) => {
              if (btnInt.user.id !== dictatorPlayer.userId) return;
              dictatorTriggered = true;
              stateManager.updateState({ dictatorUsed: true });
              await btnInt.deferUpdate().catch(() => {});
              await dictatorMsg.delete().catch(() => {});
              collector.stop();

              // 全員ミュート
              for (const player of alivePlayers) {
                try {
                  const m = await guild.members.fetch(player.userId);
                  if (m.voice.channelId) await m.voice.setMute(true);
                } catch(e) {}
              }

              // メインチャット通知 & GM音声
              const dictatorMember = await guild.members.fetch(dictatorPlayer.userId).catch(() => null);
              await voteChannel.send(MSG.CHAT.DICTATOR_CO_ANNOUNCE(dictatorMember?.displayName || '独裁者'));
              const dictatorAudio = await TTSService.generateAudio(MSG.VOICE.DICTATOR_CO, gameId, 'dictator_co');
              await VoiceService.broadcastAudio(broadcastConns, dictatorAudio, gameId);

              // 独裁者処刑選択UI
              const others = alivePlayers.filter(p => p.userId !== dictatorPlayer.userId);
              const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('dictator_exec_select')
                .setPlaceholder('処刑する対象を選択');
              for (const target of others) {
                const targetM = await guild.members.fetch(target.userId).catch(() => null);
                if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
              }
              const selectMsg = await this.sendToPersonalChannel(guild, dictatorPlayer.userId, {
                content: '👑 **【独裁処刑】** 処刑するプレイヤーを選択してください：',
                components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
              });
              if (selectMsg) {
                const selectInt = await selectMsg.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: 60000 }).catch(() => null);
                if (selectInt) {
                  dictatorTargetId = selectInt.values[0];
                  await selectInt.deferUpdate().catch(() => {});
                  await selectMsg.delete().catch(() => {});
                } else {
                  dictatorTargetId = secureSample(others).userId;
                }
              }
            });
          }
        }

        let remainAnnounced = false;
        const intervalMs = 10000; 
        let elapsed = 0;

        while (elapsed < totalDiscussionMs) {
          if (dictatorTriggered) break;
          let currentState: GameState;
          try {
            currentState = StateManager.getInstance().getState();
          } catch {
            break; // 廃村等でStateが破棄された場合は即座にループ脱出
          }
          if (currentState.phase !== 'day_discussion') break;

          if (currentState.isPaused) {
              await timerMsg.edit(MSG.CHAT.DAY_TIMER_PAUSED(state.day)).catch(() => {});
              await new Promise(r => setTimeout(r, 2000));
              targetUnixTime += 2;
              continue;
          }

          const aliveWorkerPlayers = alivePlayers.filter(p => workers.some(w => w.user?.id === p.userId));
          for (const workerPlayer of aliveWorkerPlayers) {
            if (secureRandom() < 0.70) {
              const workerClient = workers.find(w => w.user?.id === workerPlayer.userId);
              if (workerClient) {
                const phrase = secureSample(MSG.VOICE.WORKER_PHRASES);
                
                (async () => {
                  try {
                    const workerConn = await VoiceService.connectWithClient(workerClient, mainVc, gameId, 'worker');
                    const audio = await TTSService.generateAudio(phrase, gameId, `worker_${Date.now()}_${workerPlayer.userId}`);
                    VoiceService.playAudio(workerConn, audio, gameId).catch(()=>{});
                  } catch (e) {
                    Logger.warn('PhaseHandler', 'バイト君の発声に失敗しました', gameId);
                  }
                })();
              }
            }
          }
          await new Promise(r => setTimeout(r, intervalMs));
          elapsed += intervalMs;
          
          const remainMs = Math.max(0, totalDiscussionMs - elapsed);
          const remainSec = Math.floor(remainMs / 1000);
          const m = Math.floor(remainSec / 60);
          const sStr = (remainSec % 60).toString().padStart(2, '0');
          const progress = Math.floor((remainMs / totalDiscussionMs) * 20);
          const bar = '█'.repeat(progress) + '░'.repeat(20 - progress);

          const timeText = remainMs > 0 ? `<t:${targetUnixTime}:T> (<t:${targetUnixTime}:R>)` : `**【終了済】**`;
          await timerMsg.edit(MSG.CHAT.DAY_TIMER_UPDATE(state.day, timeText, bar, m, sStr)).catch(() => {});

          if (guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
            try { await (mainVc as any).setVoiceStatus?.(MSG.CHAT.VOICE_STATUS_DISCUSSING(m, sStr)); } catch(e) {}
          }

          if (dayTimeMinutes > 1 && !remainAnnounced && remainMs <= 60000) {
              remainAnnounced = true;
              await voteChannel.send(MSG.CHAT.DAY_REMAIN_1M);
          }
        }

        if (dictatorMsg) await dictatorMsg.delete().catch(() => {});

        // 独裁処刑が発動した場合は、投票フェーズをスキップして即座に処刑フェーズへ遷移
        if (dictatorTriggered && dictatorTargetId) {
          stateManager.updateState({ executedUserId: dictatorTargetId });
          stateManager.nextPhase('execution');
          VoiceService.handlePhaseTransition(gameId, 'execution');
          await this.handleExecutionPhase(gmClient, assistantClient as Client, gameId, dictatorTargetId);
          return;
        }

        const endAudio = await TTSService.generateAudio(MSG.VOICE.DAY_END, gameId, `day_end_${state.day}`);
        await VoiceService.broadcastAudio(broadcastConns, endAudio, gameId);

        if (guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
          try { await (mainVc as any).setVoiceStatus?.(''); } catch(e) {}
        }

        for (const player of alivePlayers) {
          actionQueue.add(async () => {
            try {
              const member = await guild.members.fetch(player.userId);
              if (member.voice.channelId) await member.voice.setMute(true);
            } catch (e) {}
          }, `mute-main-${player.userId}`);
        }
        await actionQueue.waitForEmpty();
        
        stateManager.nextPhase('voting');
        VoiceService.handlePhaseTransition(gameId, 'voting');
        await this.startVotingPhase(gmClient, assistantClient, gameId);
      }
    } catch (error) {
      Logger.error('PhaseHandler', '議論フェーズエラー', error, gameId);
    }
  }

  public static async startVotingPhase(gmClient: Client, assistantClient: string | Client, gameId: string): Promise<void> {
    Logger.info('PhaseHandler', `🗳️ 投票フェーズを開始します。`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    const settings = state.settingsSnapshot;

    const speechSec = Math.round(settings.speechMin * 60); 
    const voteSec = Math.round(settings.actionTimeoutMin * 60);
    const handRaiseTimeoutSec = settings.handRaiseTimeoutSec || (state.isDebug ? 2 : 15);

    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    
    // 再開時などを考慮し、投票開始時に生存プレイヤー全員を一旦ミュートにする
    for (const player of alivePlayers) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(player.userId);
          if (member.voice.channelId) await member.voice.setMute(true);
        } catch (e) {}
      }, `mute-voting-init-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    let unvotedPlayers = [...alivePlayers];
    const votedPlayers: any[] = [];
    const waitQueue: Player[] = [];
    const randomVoterIds: string[] = [];
    const randomlyAssignedSpeakerIds: string[] = [];
    
    stateManager.updateState({ currentVotes: {} });
    await voteChannel.send(MSG.CHAT.SYS_VOTE_START(state.day));
    
    const handRaiseButton = new ButtonBuilder().setCustomId('hand_raise').setLabel('✋ 発言順を予約').setStyle(ButtonStyle.Primary);
    const cancelHandRaiseButton = new ButtonBuilder().setCustomId('cancel_hand_raise').setLabel('✋ 挙手キャンセル').setStyle(ButtonStyle.Secondary);
    const endTurnButton = new ButtonBuilder().setCustomId('end_turn').setLabel('🎤 発言終了').setStyle(ButtonStyle.Danger);
    const handRaiseRow = new ActionRowBuilder<ButtonBuilder>().addComponents(handRaiseButton, cancelHandRaiseButton, endTurnButton);

    const voteSelect = new StringSelectMenuBuilder().setCustomId('vote_select').setPlaceholder('処刑対象を選択');
    for (const target of alivePlayers) {
      const targetMember = guild.members.cache.get(target.userId) || await guild.members.fetch(target.userId).catch(() => null);
      if (targetMember) voteSelect.addOptions({ label: targetMember.displayName, value: target.userId });
    }
    const voteRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(voteSelect);

    const handRaiseMsg = await voteChannel.send({ content: MSG.CHAT.VOTE_BUTTON_PROMPT, components: [handRaiseRow, voteRow] });
    const statusMsg = await voteChannel.send(MSG.CHAT.VOTE_LOADING);

    let currentSpeaker: Player | null = null;
    let turnEndedEarly = false;
    
    const collector = handRaiseMsg.createMessageComponentCollector({ time: 24 * 60 * 60 * 1000 });
    collector.on('collect', async (interaction: any) => {
      const user = interaction.user;
      if (interaction.customId === 'hand_raise') {
        const p = unvotedPlayers.find((up: Player) => up.userId === user.id);
        if (p) {
          if (!waitQueue.find((q: Player) => q.userId === p.userId) && currentSpeaker?.userId !== p.userId) {
            waitQueue.push(p);
            await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_SUCCESS, flags: MessageFlags.Ephemeral }).catch(()=>{});
          } else {
            await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_DUPLICATE, flags: MessageFlags.Ephemeral }).catch(()=>{});
          }
        } else {
          await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_INVALID, flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      } else if (interaction.customId === 'cancel_hand_raise') {
        const qIndex = waitQueue.findIndex((q: Player) => q.userId === user.id);
        if (qIndex !== -1) {
            waitQueue.splice(qIndex, 1);
            await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_CANCEL, flags: MessageFlags.Ephemeral }).catch(()=>{});
        } else {
            await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_NOT_FOUND, flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      } else if (interaction.customId === 'end_turn') {
        if (currentSpeaker?.userId === user.id) {
            turnEndedEarly = true;
            await interaction.reply({ content: MSG.CHAT.VOTE_END_TURN_SUCCESS, flags: MessageFlags.Ephemeral }).catch(()=>{});
        } else {
            await interaction.reply({ content: MSG.CHAT.VOTE_NOT_YOUR_TURN, flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      } else if (interaction.customId === 'vote_select' && interaction.isStringSelectMenu()) {
        const targetId = interaction.values[0];

        if (user.id === targetId) {
            await interaction.reply({ content: '❌ 自分には投票できません。', flags: MessageFlags.Ephemeral }).catch(()=>{});
            return;
        }

        const isAlive = alivePlayers.some((p: Player) => p.userId === user.id);
        if (!isAlive) {
            await interaction.reply({ content: '❌ あなたは既に死亡しているため、投票できません。', flags: MessageFlags.Ephemeral }).catch(()=>{});
            return;
        }

        const isDone = votedPlayers.some(p => p.id === user.id);
        if (isDone) {
            await interaction.reply({ content: '❌ あなたの投票は既に締め切られています。', flags: MessageFlags.Ephemeral }).catch(()=>{});
            return;
        }

        const targetName = (await guild.members.fetch(targetId)).displayName;
        const newVotes = { ...stateManager.getState().currentVotes, [user.id]: targetId };
        stateManager.updateState({ currentVotes: newVotes });

        await interaction.reply({ content: MSG.CHAT.DM_VOTED(targetName), flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
    });  

    const mainVc = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await (assistantClient as Client).guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
    
    let gmConn: any, astConn: any;
    if (mainVc) gmConn = await VoiceService.connectWithClient(gmClient, mainVc, gameId, 'main');
    if (ghostVc) astConn = await VoiceService.connectWithClient(assistantClient as Client, ghostVc, gameId, 'ghost');
    
    const broadcastConns = [gmConn, astConn];

    while (unvotedPlayers.length > 0) {
      turnEndedEarly = false;
      let speaker = waitQueue.shift();

      if (!speaker) {
        await this.waitWithPauseAndCondition(handRaiseTimeoutSec * 1000, () => waitQueue.length > 0);
        if (waitQueue.length > 0) {
          speaker = waitQueue.shift();
        } else {
          for (let i = 0; i < 2; i++) {
              if (gmConn) {
                  const warnAudio = await TTSService.generateAudio(MSG.VOICE.HAND_RAISE_WARNING, gameId, `hand_warn_${state.day}_${Date.now()}`);
                  await VoiceService.broadcastAudio(broadcastConns, warnAudio, gameId);
              }
              if (waitQueue.length > 0) break;
          }
          if (waitQueue.length > 0) {
              speaker = waitQueue.shift();
          } else {
              speaker = secureSample(unvotedPlayers);
              randomlyAssignedSpeakerIds.push(speaker.userId);
          }
        }
      }

      currentSpeaker = speaker!;
      const qIndex = waitQueue.findIndex(q => q.userId === currentSpeaker!.userId);
      if (qIndex !== -1) waitQueue.splice(qIndex, 1);

      const speakerMember = await guild.members.fetch(currentSpeaker.userId).catch(() => null);
      if (!speakerMember) {
        unvotedPlayers = unvotedPlayers.filter(p => p.userId !== currentSpeaker!.userId);
        currentSpeaker = null;
        continue;
      }

      let targetUnixTime = Math.floor(Date.now() / 1000) + speechSec + voteSec;

      const uiUpdateInterval = setInterval(async () => {
        const currentState = StateManager.getInstance().getState();
        if (currentState.isPaused) {
           targetUnixTime += 2;
           await statusMsg.edit(MSG.CHAT.VOTE_UI_HEADER + MSG.CHAT.VOTE_UI_PAUSED).catch(()=>{});
           return;
        }

        let uiText = MSG.CHAT.VOTE_UI_HEADER;
        for (const vp of votedPlayers) uiText += MSG.CHAT.VOTE_UI_DONE(vp.displayName);
        
        const isRandomSpeaker = randomlyAssignedSpeakerIds.includes(currentSpeaker!.userId);
        const speakerNote = isRandomSpeaker ? 'ランダム指名' : '挙手';
        const timeText = (targetUnixTime * 1000) > Date.now() ? `<t:${targetUnixTime}:R>` : `**【終了済】**`;
        uiText += MSG.CHAT.VOTE_UI_NOW(speakerMember.displayName, speakerNote, timeText);
        
        for (const qp of waitQueue) {
           const qm = guild.members.cache.get(qp.userId) || await guild.members.fetch(qp.userId).catch(() => null);
           uiText += MSG.CHAT.VOTE_UI_WAITING(qm?.displayName || '不明');
        }

        for (const up of unvotedPlayers) {
           if (up.userId !== currentSpeaker!.userId && !waitQueue.find(q => q.userId === up.userId)) {
             const um = guild.members.cache.get(up.userId) || await guild.members.fetch(up.userId).catch(() => null);
             uiText += MSG.CHAT.VOTE_UI_PENDING(um?.displayName || '不明');
           }
        }
        
        uiText += MSG.CHAT.VOTE_UI_RESULT_HEADER;
        const currentVotes = currentState.currentVotes;
        const counts: Record<string, string[]> = {};
        for (const [vId, tId] of Object.entries(currentVotes)) {
          if (!counts[tId]) counts[tId] = [];
          const voterM = guild.members.cache.get(vId) || await guild.members.fetch(vId).catch(() => null);
          const suffix = randomVoterIds.includes(vId) ? ' (ランダム)' : '';
          counts[tId].push(`${voterM?.displayName || '不明'}${suffix}`);
        }

        if (Object.keys(counts).length === 0) uiText += MSG.CHAT.VOTE_UI_NO_VOTES;
        else {
          for (const [tId, voters] of Object.entries(counts)) {
            const targetM = guild.members.cache.get(tId) || await guild.members.fetch(tId).catch(() => null);
            uiText += MSG.CHAT.VOTE_UI_VOTE_ITEM(targetM?.displayName || '不明', voters.length, voters.join(', '));
          }
        }
        await statusMsg.edit(uiText).catch(() => {});
      }, 2000);

      actionQueue.add(async () => {
        try { if (speakerMember.voice.channelId) await speakerMember.voice.setMute(false); } catch (e) {}
      }, `unmute-${currentSpeaker!.userId}`);
      await actionQueue.waitForEmpty();

      if (gmConn) {
        await new Promise(r => setTimeout(r, 500)); 
        const timeStr = speechSec >= 60 ? `${Math.floor(speechSec / 60)}分` : `${speechSec}秒`;
        const speakerAudio = await TTSService.generateAudio(MSG.VOICE.VOTE_START(speakerMember.displayName, timeStr), gameId, `vote_start_${currentSpeaker!.userId}`);
        await VoiceService.broadcastAudio(broadcastConns, speakerAudio, gameId);
      }

      await this.waitWithPauseAndCondition((speechSec + voteSec) * 1000, () => turnEndedEarly);
      clearInterval(uiUpdateInterval);

      actionQueue.add(async () => {
        try { if (speakerMember.voice.channelId) await speakerMember.voice.setMute(true); } catch (e) {}
      }, `mute-${currentSpeaker!.userId}`);
      await actionQueue.waitForEmpty();
      
      let currentVote = stateManager.getState().currentVotes[currentSpeaker!.userId];
      if (!currentVote) {
          for (let i = 0; i < 2; i++) {
              if (gmConn) {
                  const warnAudio = await TTSService.generateAudio(MSG.VOICE.VOTE_TIMEOUT_WARNING, gameId, `vote_warn_${state.day}_${Date.now()}`);
                  await VoiceService.broadcastAudio(broadcastConns, warnAudio, gameId);
              }
              currentVote = stateManager.getState().currentVotes[currentSpeaker!.userId];
              if (currentVote) break;
          }
      }

      if (!currentVote) {
          const candidates = alivePlayers.filter((p: Player) => p.userId !== currentSpeaker!.userId);
          const randomTargetId = secureSample(candidates).userId;
          randomVoterIds.push(currentSpeaker!.userId);
          const targetName = (guild.members.cache.get(randomTargetId) || await guild.members.fetch(randomTargetId)).displayName;
          await this.sendToPersonalChannel(guild, currentSpeaker!.userId, MSG.CHAT.DM_TIMEOUT_VOTE(targetName));
          
          const newVotes = { ...stateManager.getState().currentVotes, [currentSpeaker!.userId]: randomTargetId };
          stateManager.updateState({ currentVotes: newVotes });
      }

      votedPlayers.push(speakerMember);
      unvotedPlayers = unvotedPlayers.filter((p: Player) => p.userId !== currentSpeaker!.userId);
      currentSpeaker = null;
    }

    collector.stop();

    let finalUiText = MSG.CHAT.VOTE_UI_HEADER;
    for (const vp of votedPlayers) finalUiText += MSG.CHAT.VOTE_UI_DONE(vp.displayName);
    finalUiText += MSG.CHAT.VOTE_UI_RESULT_FINAL_HEADER;
    
    const finalVotes = stateManager.getState().currentVotes;
    const finalCounts: Record<string, string[]> = {};
    for (const [vId, tId] of Object.entries(finalVotes)) {
      if (!finalCounts[tId]) finalCounts[tId] = [];
      const voterM = guild.members.cache.get(vId) || await guild.members.fetch(vId).catch(() => null);
      const suffix = randomVoterIds.includes(vId) ? ' (ランダム)' : '';
      finalCounts[tId].push(`${voterM?.displayName || '不明'}${suffix}`);
    }
    for (const [tId, voters] of Object.entries(finalCounts)) {
      const targetM = guild.members.cache.get(tId) || await guild.members.fetch(tId).catch(() => null);
      finalUiText += MSG.CHAT.VOTE_UI_VOTE_ITEM(targetM?.displayName || '不明', voters.length, voters.join(', '));
    }
    await statusMsg.edit(finalUiText).catch(() => {});

    if (gmConn) {
      await new Promise(r => setTimeout(r, 500));
      const endAudio = await TTSService.generateAudio(MSG.VOICE.VOTE_END, gameId, `vote_end_${state.day}`);
      await VoiceService.broadcastAudio(broadcastConns, endAudio, gameId);
      await new Promise(r => setTimeout(r, 3000)); 
    }

    const counts: Record<string, number> = {};
    Object.values(finalVotes).forEach(id => counts[id] = (counts[id] || 0) + 1);
    const maxVotes = Math.max(...Object.values(counts), 0);
    const executionTargets = Object.keys(counts).filter(id => counts[id] === maxVotes);

    if (maxVotes === 0 || executionTargets.length === 0) {
        stateManager.updateState({ executedUserId: null });
        stateManager.nextPhase('execution');
        VoiceService.handlePhaseTransition(gameId, 'execution'); 
        await this.handleExecutionPhase(gmClient, assistantClient as Client, gameId, null);
    } else if (executionTargets.length > 1) {
        stateManager.updateState({ runoffTargets: executionTargets });
        stateManager.nextPhase('runoff_voting');
        VoiceService.handlePhaseTransition(gameId, 'runoff_voting'); 
        await this.handleRunoffVotingPhase(gmClient, assistantClient as Client, gameId, executionTargets);
    } else {
        stateManager.updateState({ executedUserId: executionTargets[0] });
        stateManager.nextPhase('execution');
        VoiceService.handlePhaseTransition(gameId, 'execution'); 
        await this.handleExecutionPhase(gmClient, assistantClient as Client, gameId, executionTargets[0]);
    }
  }

  public static async handleRunoffVotingPhase(gmClient: Client, assistantClient: Client, gameId: string, tiedUserIds: string[]): Promise<void> {
    Logger.info('PhaseHandler', `⚖️ 決選投票フェーズを開始します。対象: ${tiedUserIds.length}名`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
    const settings = state.settingsSnapshot;

    const defenseMs = settings.runoffDefenseMin * 60000;
    const voteTimeoutMs = settings.runoffVoteTimeoutMin * 60000;

    let gmConn: any, astConn: any;
    if (mainVcChannel) gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
    if (ghostVc) astConn = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
    
    const broadcastConns = [gmConn, astConn];

    if (gmConn) {
        const startAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_START, gameId, `runoff_start_${state.day}`);
        await VoiceService.broadcastAudio(broadcastConns, startAudio, gameId);
    }

    const handRaiseButton = new ButtonBuilder().setCustomId('hand_raise_runoff').setLabel('✋ 弁明順を予約').setStyle(ButtonStyle.Primary);
    const cancelHandRaiseButton = new ButtonBuilder().setCustomId('cancel_hand_raise_runoff').setLabel('✋ 挙手キャンセル').setStyle(ButtonStyle.Secondary);
    const endTurnButton = new ButtonBuilder().setCustomId('end_turn_runoff').setLabel('🎤 弁明終了').setStyle(ButtonStyle.Danger);
    const handRaiseRow = new ActionRowBuilder<ButtonBuilder>().addComponents(handRaiseButton, cancelHandRaiseButton, endTurnButton);

    const handRaiseMsg = await voteChannel.send({ content: MSG.CHAT.SYS_RUNOFF_START, components: [handRaiseRow] });

    let undefensedTargets = [...tiedUserIds];
    const defenseWaitQueue: string[] = [];
    let currentDefender: string | null = null;
    let runoffTurnEndedEarly = false;
    const handRaiseTimeoutSec = state.isDebug ? 2 : 15;

    const collector = handRaiseMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 24 * 60 * 60 * 1000 });
    collector.on('collect', async (interaction: any) => {
        const user = interaction.user;
        if (interaction.customId === 'hand_raise_runoff') {
            if (undefensedTargets.includes(user.id)) {
                if (!defenseWaitQueue.includes(user.id) && currentDefender !== user.id) {
                    defenseWaitQueue.push(user.id);
                    await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_SUCCESS, flags: MessageFlags.Ephemeral }).catch(()=>{});
                } else {
                    await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_DUPLICATE, flags: MessageFlags.Ephemeral }).catch(()=>{});
                }
            } else {
                await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_INVALID, flags: MessageFlags.Ephemeral }).catch(()=>{});
            }
        } else if (interaction.customId === 'cancel_hand_raise_runoff') {
            const qIndex = defenseWaitQueue.indexOf(user.id);
            if (qIndex !== -1) {
                defenseWaitQueue.splice(qIndex, 1);
                await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_CANCEL, flags: MessageFlags.Ephemeral }).catch(()=>{});
            } else {
                await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_NOT_FOUND, flags: MessageFlags.Ephemeral }).catch(()=>{});
            }
        } else if (interaction.customId === 'end_turn_runoff') {
            if (currentDefender === user.id) {
                runoffTurnEndedEarly = true;
                await interaction.reply({ content: MSG.CHAT.VOTE_END_TURN_SUCCESS, flags: MessageFlags.Ephemeral }).catch(()=>{});
            } else {
                await interaction.reply({ content: MSG.CHAT.VOTE_NOT_YOUR_TURN, flags: MessageFlags.Ephemeral }).catch(()=>{});
            }
        }
    });

    const alivePlayers = state.players.filter((p: Player) => p.isAlive);

    for (const p of alivePlayers) {
        actionQueue.add(async () => {
            try { const m = await guild.members.fetch(p.userId); if (m.voice.channelId) await m.voice.setMute(true); } catch(e){}
        }, `mute-all-runoff-${p.userId}`);
    }
    await actionQueue.waitForEmpty();

    const defTimeStr = defenseMs >= 60000 ? `${settings.runoffDefenseMin}分間` : `${Math.round(defenseMs / 1000)}秒間`;

    while (undefensedTargets.length > 0) {
        runoffTurnEndedEarly = false;
        let targetId = defenseWaitQueue.shift();

        if (!targetId) {
            await this.waitWithPauseAndCondition(handRaiseTimeoutSec * 1000, () => defenseWaitQueue.length > 0);
            if (defenseWaitQueue.length > 0) {
                targetId = defenseWaitQueue.shift();
            } else {
                for (let i = 0; i < 2; i++) {
                    if (gmConn) {
                        const warnAudio = await TTSService.generateAudio(MSG.VOICE.HAND_RAISE_WARNING, gameId, `runoff_hand_warn_${state.day}_${Date.now()}`);
                        await VoiceService.broadcastAudio(broadcastConns, warnAudio, gameId);
                    }
                    if (defenseWaitQueue.length > 0) break;
                }
                if (defenseWaitQueue.length > 0) {
                    targetId = defenseWaitQueue.shift();
                } else {
                    targetId = secureSample(undefensedTargets);
                }
            }
        }

        currentDefender = targetId!;
        const targetMember = await guild.members.fetch(targetId).catch(()=>null);
        if (!targetMember) {
            undefensedTargets = undefensedTargets.filter(id => id !== currentDefender);
            currentDefender = null;
            continue;
        }

        actionQueue.add(async () => {
            try { if (targetMember.voice.channelId) await targetMember.voice.setMute(false); } catch(e){}
        }, `unmute-runoff-${targetId}`);
        await actionQueue.waitForEmpty();

        if (gmConn) {
            const defenseStartAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_DEFENSE_START(targetMember.displayName, defTimeStr), gameId, `runoff_def_start_${targetId}`);
            await VoiceService.broadcastAudio(broadcastConns, defenseStartAudio, gameId);
        }

        let targetUnixTime = Math.floor(Date.now() / 1000) + Math.round(defenseMs / 1000);
        const defMsg = await voteChannel.send(MSG.CHAT.RUNOFF_DEFENSE_START(targetMember.displayName, targetUnixTime));

        const uiUpdateInterval = setInterval(async () => {
            if (StateManager.getInstance().getState().isPaused) {
                targetUnixTime += 2;
                await defMsg.edit(MSG.CHAT.RUNOFF_DEFENSE_PAUSED(targetMember.displayName)).catch(()=>{});
            } else {
                const timeText = (targetUnixTime * 1000) > Date.now() ? `（終了まで <t:${targetUnixTime}:R>）` : `**【終了済】**`;
                await defMsg.edit(MSG.CHAT.RUNOFF_DEFENSE_UPDATE(targetMember.displayName, timeText)).catch(()=>{});
            }
        }, 2000);

        await this.waitWithPauseAndCondition(defenseMs, () => runoffTurnEndedEarly);
        clearInterval(uiUpdateInterval);
        await defMsg.edit(MSG.CHAT.RUNOFF_DEFENSE_UPDATE(targetMember.displayName, `**【終了済】**`)).catch(()=>{});

        if (gmConn) {
            const defenseEndAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_DEFENSE_END, gameId, `runoff_def_end_${targetId}`);
            await VoiceService.broadcastAudio(broadcastConns, defenseEndAudio, gameId);
        }

        actionQueue.add(async () => {
            try { if (targetMember.voice.channelId) await targetMember.voice.setMute(true); } catch(e){}
        }, `mute-runoff-${targetId}`);
        await actionQueue.waitForEmpty();

        undefensedTargets = undefensedTargets.filter(id => id !== currentDefender);
        currentDefender = null;
    }
    collector.stop();

    const voteTimeStr = voteTimeoutMs >= 60000 ? `${settings.runoffVoteTimeoutMin}分` : `${Math.round(voteTimeoutMs / 1000)}秒`;
    if (gmConn) {
        const votePromptAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_VOTE_PROMPT(voteTimeStr), gameId, `runoff_prompt_${state.day}`);
        await VoiceService.broadcastAudio(broadcastConns, votePromptAudio, gameId);
    }

    let voteTargetUnixTime = Math.floor(Date.now() / 1000) + Math.round(voteTimeoutMs / 1000);
    await voteChannel.send(MSG.CHAT.SYS_RUNOFF_VOTE_START(voteTargetUnixTime));

    const voters = alivePlayers.filter(p => !tiedUserIds.includes(p.userId));
    const runoffVotes: Record<string, string> = {};
    const randomRunoffVoterIds: string[] = [];

    const votePromises = voters.map(async (voter) => {
        const selectMenu = new StringSelectMenuBuilder().setCustomId('runoff_vote').setPlaceholder('決選投票先を選択');
        for (const tId of tiedUserIds) {
            const tM = await guild.members.fetch(tId).catch(()=>null);
            if (tM) selectMenu.addOptions({ label: tM.displayName, value: tId });
        }
        const pMsg = await this.sendToPersonalChannel(guild, voter.userId, {
            content: MSG.CHAT.DM_RUNOFF_VOTE_PROMPT,
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        if (!pMsg) return;
        const compCollector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect });
        let resolved = false;

        compCollector.on('collect', async (i: StringSelectMenuInteraction) => {
            if (i.user.id !== voter.userId) return;
            const selectedId = i.values[0];
            runoffVotes[voter.userId] = selectedId;
            const selectedName = (await guild.members.fetch(selectedId)).displayName;
            await i.deferUpdate();
            await pMsg.delete().catch(()=>{});
            await this.sendToPersonalChannel(guild, voter.userId, MSG.CHAT.DM_VOTED(selectedName));
            resolved = true;
            compCollector.stop();
        });

        await this.waitWithPauseAndCondition(voteTimeoutMs, () => resolved);
        if (!resolved) {
            if (pMsg) await pMsg.delete().catch(()=>{});
            const randomTarget = secureSample(tiedUserIds);
            runoffVotes[voter.userId] = randomTarget;
            randomRunoffVoterIds.push(voter.userId);
            const selectedName = (await guild.members.fetch(randomTarget)).displayName;
            await this.sendToPersonalChannel(guild, voter.userId, MSG.CHAT.DM_TIMEOUT_VOTE(selectedName));
        }
    });

    await Promise.all(votePromises);

    let resultUiText = MSG.CHAT.RUNOFF_UI_RESULT_FINAL_HEADER;
    const resultCounts: Record<string, string[]> = {};
    for (const [vId, tId] of Object.entries(runoffVotes)) {
        if (!resultCounts[tId]) resultCounts[tId] = [];
        const voterM = await guild.members.fetch(vId).catch(() => null);
        const suffix = randomRunoffVoterIds.includes(vId) ? ' (ランダム)' : '';
        resultCounts[tId].push(`${voterM?.displayName || '不明'}${suffix}`);
    }
    
    if (Object.keys(resultCounts).length === 0) {
        resultUiText += `(有効な投票がありませんでした。全員タイムアウトのため対象者からランダム処刑を行います)\n`;
    } else {
        for (const [tId, votersList] of Object.entries(resultCounts)) {
            const targetM = await guild.members.fetch(tId).catch(() => null);
            resultUiText += MSG.CHAT.VOTE_UI_VOTE_ITEM(targetM?.displayName || '不明', votersList.length, votersList.join(', '));
        }
    }
    await voteChannel.send(resultUiText).catch(() => {});

    const runoffCounts: Record<string, number> = {};
    Object.values(runoffVotes).forEach(id => runoffCounts[id] = (runoffCounts[id] || 0) + 1);
    const maxRunoffVotes = Math.max(...Object.values(runoffCounts), 0);
    let finalExecutionTargets = Object.keys(runoffCounts).filter(id => runoffCounts[id] === maxRunoffVotes);

    if (finalExecutionTargets.length === 0 || maxRunoffVotes === 0) finalExecutionTargets = tiedUserIds;
    const executedUserId = secureSample(finalExecutionTargets);

    stateManager.updateState({ executedUserId, runoffTargets: undefined });
    stateManager.nextPhase('execution');
    await this.handleExecutionPhase(gmClient, assistantClient, gameId, executedUserId);
  }

  public static async handleExecutionPhase(gmClient: Client, assistantClient: Client, gameId: string, executedUserId: string | null): Promise<void> {
    Logger.info('PhaseHandler', `⚖️ 処刑フェーズを開始します。`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    const settings = state.settingsSnapshot;
    const sysTimeMs = this.getSysTimeMs(settings);

    // 再開時などを考慮し、処刑フェーズ開始時に生存プレイヤー全員を一旦ミュートにする
    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    for (const p of alivePlayers) {
      actionQueue.add(async () => {
        try {
          const m = await guild.members.fetch(p.userId);
          if (m.voice.channelId) await m.voice.setMute(true);
        } catch (e) {}
      }, `mute-execution-init-${p.userId}`);
    }
    await actionQueue.waitForEmpty();

    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;

    if (!executedUserId) {
      if (mainVcChannel && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        await new Promise(r => setTimeout(r, 1000));
        const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
        
        const executionAudio = await TTSService.generateAudio(MSG.VOICE.EXEC_NONE, gameId, `exec_none_${state.day}`);
        await VoiceService.broadcastAudio([gmConnection, assistantConnection], executionAudio, gameId);
      }

      await voteChannel.send(MSG.CHAT.SYS_EXECUTION_NONE);

      // 処刑なしの場合は遺言タイムをスキップし、3秒だけ待つ
      await this.waitWithPauseAndCondition(3000);

      state.eventLogs.push(`[第${state.day}日 昼] 誰も処刑されなかった`);
      stateManager.updateState({ eventLogs: state.eventLogs });

      if (mainVcChannel && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        const introAudio = await TTSService.generateAudio(MSG.VOICE.NIGHT_INTRO_NONE, gameId, `night_intro_none_${state.day}`);
        await VoiceService.playAudio(gmConnection, introAudio, gameId);
      }
    } else {
      const executedMember = await guild.members.fetch(executedUserId).catch(() => null);
      const executedName = executedMember?.displayName || '不明なプレイヤー';

      if (mainVcChannel && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        await new Promise(r => setTimeout(r, 1000));
        const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
        
        const isDictatorExec = !!(state.dictatorUsed && state.executedUserId === executedUserId);
        const execVoiceText = isDictatorExec 
          ? MSG.VOICE.DICTATOR_EXEC(executedName)
          : MSG.VOICE.EXEC_START(executedName);
        const executionAudio = await TTSService.generateAudio(execVoiceText, gameId, `exec_${executedUserId}`);
        await VoiceService.broadcastAudio([gmConnection, assistantConnection], executionAudio, gameId);
      }

      await voteChannel.send(MSG.CHAT.SYS_EXECUTION(executedUserId));

      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(executedUserId);
          if (member.voice.channelId) await member.voice.setMute(false);
        } catch (e) {}
      }, `unmute-lastword-${executedUserId}`);
      await actionQueue.waitForEmpty();

      // ハンター処刑時の道連れ選択UI
      let hunterRevengeTargetId: string | undefined;
      const isHunterExecuted = state.players.find(p => p.userId === executedUserId)?.role === 'ハンター';
      let hMsg: any = null;
      if (isHunterExecuted) {
        const remainingAlive = state.players.filter(p => p.isAlive && p.userId !== executedUserId);
        const hunterMenu = new StringSelectMenuBuilder().setCustomId('hunter_exec').setPlaceholder('道連れにする対象を選択');
        for (const t of remainingAlive) {
          const tm = await guild.members.fetch(t.userId).catch(() => null);
          if (tm) hunterMenu.addOptions({ label: tm.displayName, value: t.userId });
        }
        hMsg = await this.sendToPersonalChannel(guild, executedUserId, {
          content: MSG.CHAT.HUNTER_EXEC_PROMPT,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(hunterMenu)]
        });
        if (hMsg) {
          hMsg.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: sysTimeMs.LAST_WORD }).then(async (hi: any) => {
            hunterRevengeTargetId = hi.values[0];
            await hi.deferUpdate().catch(() => {});
            await hMsg.delete().catch(() => {});
          }).catch(() => {});
        }
      }

      let targetUnixTime = Math.floor(Date.now() / 1000) + (sysTimeMs.LAST_WORD / 1000);
      const lwMsg = await voteChannel.send(MSG.CHAT.EXEC_LAST_WORD_START(executedName, targetUnixTime));
      
      const uiUpdateInterval = setInterval(async () => {
          const currentState = StateManager.getInstance().getState();
          if (currentState.isPaused) {
             targetUnixTime += 2;
             await lwMsg.edit(MSG.CHAT.EXEC_LAST_WORD_PAUSED(executedName)).catch(()=>{});
          } else {
             const timeText = (targetUnixTime * 1000) > Date.now() ? `（終了まで <t:${targetUnixTime}:R>）` : `**【終了済】**`; 
             await lwMsg.edit(MSG.CHAT.EXEC_LAST_WORD_UPDATE(executedName, timeText)).catch(()=>{}); 
            }
      }, 2000);

      await this.waitWithPauseAndCondition(sysTimeMs.LAST_WORD);
      clearInterval(uiUpdateInterval);
      if (hMsg) await hMsg.delete().catch(() => {});
      await lwMsg.edit(MSG.CHAT.EXEC_LAST_WORD_END(executedName)).catch(()=>{});

      const updatedPlayers = state.players.map((p: Player) => p.userId === executedUserId ? { ...p, isAlive: false } : p);
      state.eventLogs.push(`[第${state.day}日 昼] ${executedName} が処刑された`);
      stateManager.updateState({ players: updatedPlayers, eventLogs: state.eventLogs });

      // 処刑フェーズの能力解決 (棺桶屋、てるてる坊主、猫又、黒猫、ハンター、人狼の子ども、恋人、女王)
      const execResult = ExecutionResolver.resolve(stateManager.getState().players, {
        executedUserId,
        undertakerTargetId: stateManager.getState().nightActions.undertakerTargetId,
        undertakerHitCount: stateManager.getState().undertakerHitCount || 0,
        hunterRevengeTargetId
      }, {
        loversUserIds: stateManager.getState().loversUserIds,
        femmeFataleData: stateManager.getState().femmeFataleData,
        livingSpiritData: stateManager.getState().livingSpiritData,
        queenUserId: stateManager.getState().queenUserId
      });

      if (execResult.undertakerHit) {
        stateManager.updateState({ undertakerHitCount: execResult.undertakerNewHitCount });
        if (execResult.undertakerAnnouncement) {
          await voteChannel.send(`⚰️ **棺桶屋の噂:** ${execResult.undertakerAnnouncement}`);
          if (mainVcChannel) {
            const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'undertaker');
            const audio = await TTSService.generateAudio(execResult.undertakerAnnouncement, gameId, `undertaker_announce_${state.day}`);
            await VoiceService.playAudio(gmConnection, audio, gameId).catch(() => {});
          }
        }
      }

      if (execResult.wolfCubKilled) {
        stateManager.updateState({ wolfCubRevenge: true });
        await voteChannel.send(`🐺 **人狼の子どもの死:** 人狼たちが激怒し、今夜の襲撃が2回になります！`);
        if (mainVcChannel) {
          const gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'wolf_cub');
          const audio = await TTSService.generateAudio(MSG.VOICE.WOLF_CUB_ENRAGED, gameId, `wolf_cub_${state.day}`);
          await VoiceService.playAudio(gmConn, audio, gameId).catch(() => {});
        }
      }

      if (execResult.blackCatRevengeKilledUserId) {
        const bcVictim = await guild.members.fetch(execResult.blackCatRevengeKilledUserId).catch(() => null);
        await voteChannel.send(`🐈‍⬛ **黒猫の呪い:** ${bcVictim?.displayName || '誰か'} が道連れとなり死亡しました！`);
        if (mainVcChannel) {
          const gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'black_cat');
          const audio = await TTSService.generateAudio(MSG.VOICE.BLACK_CAT_REVENGE(bcVictim?.displayName || 'プレイヤー'), gameId, `bc_${state.day}`);
          await VoiceService.playAudio(gmConn, audio, gameId).catch(() => {});
        }
      }

      if (execResult.hunterRevengeKilledUserId) {
        const hVictim = await guild.members.fetch(execResult.hunterRevengeKilledUserId).catch(() => null);
        await voteChannel.send(`🏹 **ハンターの道連れ:** 銃声が響き渡り、${hVictim?.displayName || '誰か'} が道連れとなりました！`);
        if (mainVcChannel) {
          const gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'hunter');
          const audio = await TTSService.generateAudio(MSG.VOICE.HUNTER_SHOOT(hVictim?.displayName || 'プレイヤー'), gameId, `hunter_${state.day}`);
          await VoiceService.playAudio(gmConn, audio, gameId).catch(() => {});
        }
      }

      if (execResult.loversFollowerUserIds.length > 0) {
        for (const loverId of execResult.loversFollowerUserIds) {
          const loverM = await guild.members.fetch(loverId).catch(() => null);
          await voteChannel.send(`💕 **恋人の後追い死:** 愛する者の死に伴い、${loverM?.displayName || '恋人'} が息絶えました...`);
          if (mainVcChannel) {
            const gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'lovers');
            const audio = await TTSService.generateAudio(MSG.VOICE.LOVERS_FOLLOW(loverM?.displayName || '恋人'), gameId, `lover_${loverId}`);
            await VoiceService.playAudio(gmConn, audio, gameId).catch(() => {});
          }
        }
      }

      if (execResult.queenDied) {
        if (execResult.livingSpiritInheritedQueenUserId) {
          const newQueenM = await guild.members.fetch(execResult.livingSpiritInheritedQueenUserId).catch(() => null);
          await voteChannel.send(`👑 **生霊が新女王に即位:** 生霊が女王の遺志を継ぎ、${newQueenM?.displayName || '新女王'} が新たな女王となりました！市民のショック死は回避されました。`);
          stateManager.updateState({ queenUserId: execResult.livingSpiritInheritedQueenUserId });
          if (mainVcChannel) {
            const gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'queen_inherit');
            const audio = await TTSService.generateAudio(MSG.VOICE.QUEEN_INHERITED(newQueenM?.displayName || '新女王'), gameId, `qi_${state.day}`);
            await VoiceService.playAudio(gmConn, audio, gameId).catch(() => {});
          }
        } else {
          await voteChannel.send(`👑 **女王崩御:** 女王が死亡したため、市民陣営の全員がショック死しました...`);
          if (mainVcChannel) {
            const gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'queen_dead');
            const audio = await TTSService.generateAudio(MSG.VOICE.QUEEN_DIED, gameId, `qd_${state.day}`);
            await VoiceService.playAudio(gmConn, audio, gameId).catch(() => {});
          }
        }
      }

      if (execResult.additionalKilledUserIds.length > 0) {
        for (const kid of execResult.additionalKilledUserIds) {
          const victimMember = await guild.members.fetch(kid).catch(() => null);
          const victimName = victimMember?.displayName || '不明なプレイヤー';
          const currentPlayers = stateManager.getState().players.map(p => p.userId === kid ? { ...p, isAlive: false } : p);
          stateManager.updateState({
            players: currentPlayers,
            eventLogs: [...stateManager.getState().eventLogs, `[処刑連鎖死亡] ${victimName} が死亡した`]
          });
        }
      }

      if (mainVcChannel && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        const introAudio = await TTSService.generateAudio(MSG.VOICE.NIGHT_INTRO(executedName), gameId, `night_intro_${state.day}`);
        await VoiceService.playAudio(gmConnection, introAudio, gameId);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 単独勝利（棺桶屋、てるてる坊主）または通常陣営勝利判定
    const currentLatestState = stateManager.getState();
    const winningTeam = this.checkWinCondition(currentLatestState, {
      undertakerWin: executedUserId ? (currentLatestState.undertakerHitCount || 0) >= 2 : false,
      foolWin: executedUserId ? (currentLatestState.players.find(p => p.userId === executedUserId)?.role === 'てるてる坊主') : false
    });

    if (winningTeam) {
      stateManager.updateState({ executedUserId: undefined });
      stateManager.nextPhase('finished');
      VoiceService.handlePhaseTransition(gameId, 'finished'); 
      await this.finishGame(gmClient, assistantClient, gameId, winningTeam, 'execution');
    } else {
      stateManager.nextPhase('night');
      VoiceService.handlePhaseTransition(gameId, 'night'); 
      await this.startNightPhase(gmClient, assistantClient, gameId);
    }
  }

public static async startNightPhase(gmClient: Client, assistantClient: Client, gameId: string): Promise<void> {
    Logger.info('PhaseHandler', `🌙 夜フェーズを開始します。`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const settings = state.settingsSnapshot;
    
    let nightBonusMs = 0;
    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
    
    if (mainVcChannel && ghostVc) {
      const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      await new Promise(r => setTimeout(r, 1000));
      const astConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');

      let nightText = MSG.VOICE.NIGHT_ARRIVE;
      if (state.isResumedBonus) {
          nightText = MSG.VOICE.NIGHT_ARRIVE_RESUMED;
          nightBonusMs = 60 * 1000; 
          state.isResumedBonus = false;
          stateManager.updateState(state);
      }
      const nightAudio = await TTSService.generateAudio(nightText, gameId, `night_arrive_${state.day}`);
      await VoiceService.broadcastAudio([gmConnection, astConnection], nightAudio, gameId);
    }

    // 🚨 修正：昼の書記を強制破壊し、物理的に盗聴(録音)を不可能にする
    const wm = WorkerManager.getInstance();
    const workers = wm.getWorkers();
    const recordClient = state.recorderWorkerId ? workers.find(w => w.user?.id === state.recorderWorkerId) : null;
    
    if (recordClient) {
        await wm.renameWorker(recordClient, state.serverId, null);
        VoiceService.disconnectClient(recordClient, gameId); // 強制破棄
    }
    stateManager.updateState({ recorderWorkerId: undefined });

    await this.syncLedgerAndMove(guild, gameId, 'night');
    stateManager.updateState({ nightActions: {} });

    // タフガイの夜息絶え処理（前夜に襲撃されて毒を受けたタフガイ）
    const toughGuyPoisoned = stateManager.getState().toughGuyPoisoned || {};
    for (const [tgUserId, isPoisoned] of Object.entries(toughGuyPoisoned)) {
      if (isPoisoned) {
        const tgPlayer = stateManager.getState().players.find(p => p.userId === tgUserId && p.isAlive);
        if (tgPlayer) {
          tgPlayer.isAlive = false;
          stateManager.getState().eventLogs.push(`[タフガイ死亡] 前日の襲撃の傷により息絶えた (User: ${tgUserId})`);
        }
        delete toughGuyPoisoned[tgUserId];
      }
    }

    // 生霊の引き継ぎチェック（憑依先が昼に死亡していた場合、役職を引き継ぐ）
    const spiritData = stateManager.getState().livingSpiritData || {};
    for (const [spiritId, targetId] of Object.entries(spiritData)) {
      const spiritPlayer = stateManager.getState().players.find(p => p.userId === spiritId && p.isAlive);
      const targetPlayer = stateManager.getState().players.find(p => p.userId === targetId);
      if (spiritPlayer && targetPlayer && !targetPlayer.isAlive && targetPlayer.role && targetPlayer.role !== '生霊') {
        const inheritedRole = targetPlayer.role;
        spiritPlayer.role = inheritedRole;
        stateManager.getState().eventLogs.push(`[生霊引き継ぎ] 憑依先の死亡により【${inheritedRole}】を引き継いだ (User: ${spiritId})`);
        await this.sendToPersonalChannel(guild, spiritId, MSG.CHAT.DM_LIVING_SPIRIT_INHERITED(inheritedRole));
      }
    }

    // 占い師の弟子の覚醒判定（本物の占い師が死亡しているか）
    const seerPlayer = stateManager.getState().players.find(p => p.role === '占い師');
    if (seerPlayer && !seerPlayer.isAlive) {
      stateManager.updateState({ apprenticeDivinerAwakened: true });
    }
    stateManager.updateState({ toughGuyPoisoned, players: stateManager.getState().players, eventLogs: stateManager.getState().eventLogs });

    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    const awayButton = new ButtonBuilder().setCustomId('night_away').setLabel('☕ 退席する').setStyle(ButtonStyle.Secondary);
    const returnButton = new ButtonBuilder().setCustomId('night_return').setLabel('🏠 帰還する').setStyle(ButtonStyle.Success);
    
    const updateAwayMsg = async (msg: any) => {
        const currentAway = StateManager.getInstance().getState().awayPlayerIds || [];
        const components = currentAway.length > 0 
            ? [new ActionRowBuilder<ButtonBuilder>().addComponents(awayButton, returnButton)]
            : [new ActionRowBuilder<ButtonBuilder>().addComponents(awayButton)];
        await msg.edit({ components }).catch(() => {});
    };

    const awayMsg = await voteChannel.send({ content: MSG.CHAT.NIGHT_AWAY_PROMPT, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(awayButton)] });
    
    const awayIntervals = new Map<string, NodeJS.Timeout>();
    const awayCollector = awayMsg.createMessageComponentCollector({ time: 24 * 60 * 60 * 1000 });
    
    awayCollector.on('collect', async (interaction: any) => {
        const user = interaction.user;
        const currentAway = StateManager.getInstance().getState().awayPlayerIds || [];
        
        if (interaction.customId === 'night_away') {
            if (!currentAway.includes(user.id)) {
                const newAway = [...currentAway, user.id];
                StateManager.getInstance().updateState({ awayPlayerIds: newAway });
                await interaction.reply({ content: MSG.CHAT.NIGHT_AWAY_SUCCESS, flags: MessageFlags.Ephemeral }).catch(() => {});
                updateAwayMsg(awayMsg);
                
                const interval = setInterval(async () => {
                    const latestState = StateManager.getInstance().getState();
                    if (!latestState.awayPlayerIds?.includes(user.id)) return;
                    
                    const p = latestState.players.find((pl: Player) => pl.userId === user.id);
                    if (p && p.personalTextChannelId) {
                        const pChannel = await guild.channels.fetch(p.personalTextChannelId).catch(() => null) as TextChannel;
                        if (pChannel) {
                            const dmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                                new ButtonBuilder().setCustomId('night_dm_return').setLabel('🏠 帰還する').setStyle(ButtonStyle.Success)
                            );
                            const dmMsg = await pChannel.send({ content: MSG.CHAT.DM_AWAY_REMINDER, components: [dmRow] }).catch(() => null);
                            if (dmMsg) {
                                const dmCollector = dmMsg.createMessageComponentCollector({ time: 60 * 1000 });
                                dmCollector.on('collect', async (dmInteraction: any) => {
                                    if (dmInteraction.user.id !== user.id) return;
                                    if (dmInteraction.customId === 'night_dm_return') {
                                        const latestAway = StateManager.getInstance().getState().awayPlayerIds || [];
                                        if (latestAway.includes(user.id)) {
                                            const updatedAway = latestAway.filter(id => id !== user.id);
                                            StateManager.getInstance().updateState({ awayPlayerIds: updatedAway });
                                            await dmInteraction.reply({ content: MSG.CHAT.NIGHT_AWAY_RETURN_SUCCESS, flags: MessageFlags.Ephemeral }).catch(() => {});
                                            const storedInterval = awayIntervals.get(user.id);
                                            if (storedInterval) { clearInterval(storedInterval); awayIntervals.delete(user.id); }
                                            updateAwayMsg(awayMsg);
                                            dmCollector.stop();
                                            await dmMsg.delete().catch(()=>{});
                                        }
                                    }
                                });
                            }
                        }
                    }
                }, 60 * 1000);
                awayIntervals.set(user.id, interval);
            } else {
                await interaction.reply({ content: '既に退席中です。', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        } else if (interaction.customId === 'night_return') {
            if (currentAway.includes(user.id)) {
                const updatedAway = currentAway.filter(id => id !== user.id);
                StateManager.getInstance().updateState({ awayPlayerIds: updatedAway });
                await interaction.reply({ content: MSG.CHAT.NIGHT_AWAY_RETURN_SUCCESS, flags: MessageFlags.Ephemeral }).catch(() => {});
                
                const storedInterval = awayIntervals.get(user.id);
                if (storedInterval) { clearInterval(storedInterval); awayIntervals.delete(user.id); }
                updateAwayMsg(awayMsg);
            } else {
                await interaction.reply({ content: MSG.CHAT.NIGHT_AWAY_NOT_AWAY, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    });

    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    const aliveWolves = alivePlayers.filter((p: Player) => p.role === '人狼');
    const wolfTargets = alivePlayers.filter((p: Player) => p.role !== '人狼');

    for (const player of alivePlayers) {
      actionQueue.add(async () => {
        try {
          const m = await guild.members.fetch(player.userId);
          if (m.voice.channelId) {
            const isWolf = player.role === '人狼';
            await m.voice.setMute(!isWolf);
          }
        } catch (e) {}
      }, `set-mute-night-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    const targetGhostWorkerCount = Math.min(alivePlayers.length, 8); 
    const ghostVcForWorker = await guild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
    
    // 🚨 修正：必ず await を付けて競合バグ（レースコンディション）を防止する
    if (ghostVcForWorker) {
        await wm.adjustGhostWorkers(gameId, ghostVcForWorker, targetGhostWorkerCount, state.players.map(p=>p.userId));
    }
   
    const playerIds = state.players.map((p: Player) => p.userId);
    const freeWorkers = await wm.getFreeWorkers(state.serverId, playerIds, 12);
    
    // 🚨 ユーザー側での実装修正：アシスタントは絶対に個室へ派遣せず完全に隔離
    const getWorker = (index: number) => freeWorkers.length > 0 ? freeWorkers[index % freeWorkers.length] : null;
    
    const workerLocks = new Map<string, Promise<void>>();

    const playVoiceTask = (worker: Client | null, channel: VoiceBasedChannel, text: string, id: string) => {
      if (!worker) return; // 空きがなければ無言(スキップ)で安全に進行
      const workerId = worker.user!.id;
      const prevTask = workerLocks.get(workerId) || Promise.resolve();
      const nextTask = prevTask.then(async () => {
        let conn: any = null;
        try {
          conn = await VoiceService.connectWithClient(worker, channel, gameId, id);
          if (conn) conn._isBusy = true;
          await new Promise(r => setTimeout(r, 1000)); 
          const audio = await TTSService.generateAudio(text, gameId, id);
          await VoiceService.playAudio(conn, audio, gameId);
        } catch (e) {
        } finally {
          if (conn) conn._isBusy = false;
        }
      });
      workerLocks.set(workerId, nextTask);
    };
    
    const medium = alivePlayers.find((p: Player) => p.role === '霊媒師');
    const executedPlayer = state.executedUserId ? state.players.find(p => p.userId === state.executedUserId) : undefined;
    if (medium && executedPlayer) {
      const mediumVc = await guild.channels.fetch(medium.waitVcId) as VoiceBasedChannel;
      if (mediumVc) {
        const executedMember = await guild.members.fetch(executedPlayer.userId).catch(()=>null);
        const executedName = executedMember?.displayName || '不明なプレイヤー';
        const isWolf = executedPlayer.role === '人狼';
        await this.sendToPersonalChannel(guild, medium.userId, MSG.CHAT.DM_MEDIUM_RESULT(executedName, isWolf));
        playVoiceTask(getWorker(0), mediumVc, MSG.VOICE.MEDIUM_RESULT(executedName, isWolf), 'medium_res');
      }
    }

    const wolfVc = await assistantGuild.channels.fetch(state.wolfVcId) as VoiceBasedChannel;
    if (wolfVc) {
      const isWolfDoubleAttack = !!(stateManager.getState().wolfCubRevenge);
      const wolfPrompt = isWolfDoubleAttack ? MSG.VOICE.PROMPT_WOLF_DOUBLE : MSG.VOICE.PROMPT_WOLF;
      playVoiceTask(getWorker(1), wolfVc, wolfPrompt, 'wolf_prompt');
    }

    const seer = alivePlayers.find((p: Player) => p.role === '占い師');
    if (seer) {
      const seerVc = await guild.channels.fetch(seer.waitVcId) as VoiceBasedChannel;
      if (seerVc) {
        playVoiceTask(getWorker(2), seerVc, MSG.VOICE.PROMPT_SEER, 'seer_prompt');
      }
    }

    const knight = alivePlayers.find((p: Player) => p.role === '騎士');
    if (knight) {
      const knightVc = await guild.channels.fetch(knight.waitVcId) as VoiceBasedChannel;
      if (knightVc) {
        playVoiceTask(getWorker(3), knightVc, MSG.VOICE.PROMPT_KNIGHT, 'knight_prompt');
      }
    }

    const apprentice = alivePlayers.find((p: Player) => p.role === '未熟な占い師');
    const isApprenticeLost = apprentice ? stateManager.getState().apprenticeStatus?.[apprentice.userId] : true;
    if (apprentice && !isApprenticeLost) {
      const apprenticeVc = await guild.channels.fetch(apprentice.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (apprenticeVc) {
        playVoiceTask(getWorker(4), apprenticeVc, MSG.VOICE.PROMPT_APPRENTICE_SEER, 'apprentice_prompt');
      }
    }

    const reckless = alivePlayers.find((p: Player) => p.role === '無謀な占い師');
    if (reckless) {
      const recklessVc = await guild.channels.fetch(reckless.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (recklessVc) {
        playVoiceTask(getWorker(5), recklessVc, MSG.VOICE.PROMPT_RECKLESS_SEER, 'reckless_prompt');
      }
    }

    const foxPossessed = alivePlayers.find((p: Player) => p.role === '狐憑き');
    if (foxPossessed) {
      const foxVc = await guild.channels.fetch(foxPossessed.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (foxVc) {
        playVoiceTask(getWorker(6), foxVc, MSG.VOICE.PROMPT_FOX_POSSESSED, 'fox_prompt');
      }
    }

    const undertaker = alivePlayers.find((p: Player) => p.role === '棺桶屋');
    if (undertaker) {
      const undertakerVc = await guild.channels.fetch(undertaker.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (undertakerVc) {
        playVoiceTask(getWorker(7), undertakerVc, MSG.VOICE.PROMPT_UNDERTAKER, 'undertaker_prompt');
      }
    }

    const trapper = alivePlayers.find((p: Player) => p.role === '罠師');
    if (trapper) {
      const trapperVc = await guild.channels.fetch(trapper.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (trapperVc) {
        playVoiceTask(getWorker(8), trapperVc, MSG.VOICE.PROMPT_TRAPPER, 'trapper_prompt');
      }
    }

    const counselor = alivePlayers.find((p: Player) => p.role === 'カウンセラー');
    if (counselor) {
      const counselorVc = await guild.channels.fetch(counselor.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (counselorVc) {
        playVoiceTask(getWorker(9), counselorVc, MSG.VOICE.PROMPT_COUNSELOR, 'counselor_prompt');
      }
    }

    const spy = alivePlayers.find((p: Player) => p.role === 'スパイ');
    if (spy) {
      const spyVc = await guild.channels.fetch(spy.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (spyVc) {
        playVoiceTask(getWorker(10), spyVc, MSG.VOICE.PROMPT_SPY, 'spy_prompt');
      }
    }

    const hunter = alivePlayers.find((p: Player) => p.role === 'ハンター');
    if (hunter) {
      const hunterVc = await guild.channels.fetch(hunter.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (hunterVc) {
        playVoiceTask(getWorker(11), hunterVc, MSG.VOICE.PROMPT_HUNTER, 'hunter_prompt');
      }
    }

    const apprenticeDiviner = alivePlayers.find((p: Player) => p.role === '占い師の弟子');
    if (apprenticeDiviner && stateManager.getState().apprenticeDivinerAwakened) {
      const adVc = await guild.channels.fetch(apprenticeDiviner.waitVcId).catch(() => null) as VoiceBasedChannel;
      if (adVc) {
        playVoiceTask(getWorker(12), adVc, MSG.VOICE.PROMPT_APPRENTICE_DIVINER_AWAKENED, 'ad_prompt');
      }
    }

    const wolfTextCh = await guild.channels.fetch(state.wolfTextChannelId) as TextChannel;
    let nightTargetUnixTime = Math.floor(Date.now() / 1000) + (settings.actionTimeoutMin * 60);
    const nightTimerMsg = await wolfTextCh.send(MSG.CHAT.NIGHT_WOLF_TIMER_START(nightTargetUnixTime));

    const nightTimerInterval = setInterval(async () => {
        const currentState = StateManager.getInstance().getState();
        if (currentState.isPaused) {
            nightTargetUnixTime += 2;
        } else {
            const remainSec = Math.max(0, nightTargetUnixTime - Math.floor(Date.now() / 1000));
            const m = Math.floor(remainSec / 60);
            const sStr = (remainSec % 60).toString().padStart(2, '0');
            const progress = Math.floor((remainSec / (settings.actionTimeoutMin * 60)) * 20);
            const bar = '█'.repeat(progress) + '░'.repeat(20 - progress);
            const timeText = remainSec > 0 ? `<t:${nightTargetUnixTime}:R>` : `**【終了済】**`;
            await nightTimerMsg.edit(MSG.CHAT.NIGHT_WOLF_TIMER_UPDATE(timeText, bar, m, sStr)).catch(()=>{});
        }
    }, 5000);

    const wolfPromise = (async () => {
      if (aliveWolves.length === 0) return;
      try {
        const isDoubleAttack = (stateManager.getState().wolfCubRevenge === true);
        const maxSelect = isDoubleAttack ? Math.min(2, wolfTargets.length) : 1;
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('w')
          .setPlaceholder(isDoubleAttack ? '襲撃先を最大2名選択' : '襲撃先を選択')
          .setMinValues(1)
          .setMaxValues(maxSelect);
        for (const target of wolfTargets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        
        const wolfPromptText = isDoubleAttack ? `🐺 **【2回襲撃発動中】**\n今夜は最大2名を襲撃できます！対象を選択してください：` : MSG.CHAT.WOLF_PROMPT;
        const wolfMsg = await wolfTextCh.send({ 
          content: wolfPromptText, 
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] 
        }).catch(() => null);
        
        if (!wolfMsg) return;
        const compCollector = wolfMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect });

        compCollector.on('collect', async (i: StringSelectMenuInteraction) => {
          const isAliveWolf = aliveWolves.some((w: Player) => w.userId === i.user.id);
          if (!isAliveWolf) {
            await i.reply({ content: '人狼以外は操作できません。', ephemeral: true }).catch(() => {});
            return;
          }
          
          const targetId = i.values[0];
          const secondTargetId = i.values[1];
          const targetName = (await guild.members.fetch(targetId)).displayName;
          const secondTargetName = secondTargetId ? (await guild.members.fetch(secondTargetId)).displayName : '';
          
          await i.deferUpdate().catch(() => {});
          
          // 最後に選択された襲撃対象を上書き
          stateManager.updateState({ 
            nightActions: { 
              ...stateManager.getState().nightActions, 
              wolfTargetId: targetId,
              wolfSecondTargetId: secondTargetId 
            },
            wolfCubRevenge: false
          });
          
          // 人狼チャットへの通知
          const displayNames = secondTargetName ? `${targetName}、${secondTargetName}` : targetName;
          await wolfTextCh.send(MSG.CHAT.WOLF_TARGET_SET(i.user.id, displayNames)).catch(() => {});
          
          // 人狼VCへの音声再生
          if (wolfVc) {
            const voiceText = secondTargetName 
              ? MSG.VOICE.WOLF_TARGET_SET_DOUBLE(targetName, secondTargetName)
              : MSG.VOICE.WOLF_TARGET_SET(targetName);
            playVoiceTask(getWorker(1), wolfVc, voiceText, 'wolf_res');
          }
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => false);
        compCollector.stop();
        await wolfMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    const seerPromise = (async () => {
      if (!seer) return;
      try {
        const targets = alivePlayers.filter((p: Player) => p.userId !== seer.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('s').setPlaceholder('占う対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        
        const pMsg = await this.sendToPersonalChannel(guild, seer.userId, { 
          content: MSG.CHAT.DM_SEER_PROMPT, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] 
        });
        
        if (!pMsg) return;
        const compCollector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect });
        let resolved = false;
        let targetId = '';

        compCollector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== seer.userId) return;
          targetId = i.values[0];
          const targetPlayer = stateManager.getState().players.find((p: Player) => p.userId === targetId)!;
          
          await i.deferUpdate();
          await pMsg.delete().catch(()=>{});
          await this.sendToPersonalChannel(guild, seer.userId, MSG.CHAT.DM_SEER_RESULT(targetPlayer.role === '人狼'));
          
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, seerTargetId: targetId } });
          resolved = true;
          compCollector.stop();
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        
        if (!resolved) {
          if (pMsg) await pMsg.delete().catch(()=>{});
          targetId = secureSample(targets).userId;
          const targetPlayer = stateManager.getState().players.find((p: Player) => p.userId === targetId)!;
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, seerTargetId: targetId } });
          const targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, seer.userId, MSG.CHAT.DM_TIMEOUT_SEER(targetName, targetPlayer.role === '人狼'));
        }

        const targetPlayerForAudio = stateManager.getState().players.find((p: Player) => p.userId === targetId)!;
        const seerVc = await guild.channels.fetch(seer.waitVcId) as VoiceBasedChannel;
        if (seerVc) playVoiceTask(getWorker(2), seerVc, MSG.VOICE.SEER_RESULT(targetPlayerForAudio.role === '人狼'), 'seer_res');

      } catch (e) {}
    })();
    
    const knightPromise = (async () => {
      if (!knight) return;
      try {
        const targets = alivePlayers.filter((p: Player) => p.userId !== knight.userId && p.userId !== stateManager.getState().lastGuardedUserId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('k').setPlaceholder('護衛対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        
        const pMsg = await this.sendToPersonalChannel(guild, knight.userId, { 
          content: MSG.CHAT.DM_KNIGHT_PROMPT, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] 
        });
        
        if (!pMsg) return;
        const compCollector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect });
        let resolved = false;
        let targetId = '';
        let targetName = '';

        compCollector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== knight.userId) return;
          targetId = i.values[0];
          targetName = (await guild.members.fetch(targetId)).displayName;
          
          await i.deferUpdate();
          await pMsg.delete().catch(()=>{});
          await this.sendToPersonalChannel(guild, knight.userId, MSG.CHAT.DM_KNIGHT_TARGET_SET(targetName));
          
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, knightTargetId: targetId }, lastGuardedUserId: targetId });
          resolved = true;
          compCollector.stop();
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        
        if (!resolved) {
          if (pMsg) await pMsg.delete().catch(()=>{});
          targetId = secureSample(targets).userId;
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, knightTargetId: targetId }, lastGuardedUserId: targetId });
          targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, knight.userId, MSG.CHAT.DM_TIMEOUT_KNIGHT(targetName));
        }

        const knightVc = await guild.channels.fetch(knight.waitVcId) as VoiceBasedChannel;
        if (knightVc) playVoiceTask(getWorker(3), knightVc, MSG.VOICE.KNIGHT_TARGET_SET(targetName), 'knight_res');

      } catch (e) {}
    })();

    // 🔰 未熟な占い師のアクション
    const apprenticePromise = (async () => {
      if (!apprentice) return;
      const isLost = stateManager.getState().apprenticeStatus?.[apprentice.userId];
      if (isLost) {
        await this.sendToPersonalChannel(guild, apprentice.userId, '⚠️ あなたは過去に予想を外したため、占いの能力を失っています。');
        return;
      }

      try {
        const targets = alivePlayers.filter((p: Player) => p.userId !== apprentice.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('ap_target').setPlaceholder('占う対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }

        const predRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('pred_wolf').setLabel('予想: 人狼 🐺').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('pred_villager').setLabel('予想: 村人 🧑').setStyle(ButtonStyle.Primary)
        );

        const pMsg = await this.sendToPersonalChannel(guild, apprentice.userId, {
          content: '🔮 **【未熟な占い】** 占う対象を選択し、その人物が「人狼」か「村人」かを予想してください：',
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu), predRow]
        });

        if (!pMsg) return;
        let selectedTargetId = '';
        let selectedPred: 'wolf' | 'villager' = 'villager';
        let resolved = false;

        const collector = pMsg.createMessageComponentCollector({ time: settings.actionTimeoutMin * 60000 + nightBonusMs });

        collector.on('collect', async (i: any) => {
          if (i.user.id !== apprentice.userId) return;
          if (i.isStringSelectMenu()) {
            selectedTargetId = i.values[0];
            await i.deferUpdate().catch(() => {});
          } else if (i.isButton()) {
            selectedPred = i.customId === 'pred_wolf' ? 'wolf' : 'villager';
            resolved = true;
            await i.deferUpdate().catch(() => {});
            collector.stop();
          }

          if (selectedTargetId) {
            stateManager.updateState({
              nightActions: {
                ...stateManager.getState().nightActions,
                apprenticeTargetId: selectedTargetId,
                apprenticePrediction: selectedPred
              }
            });
          }
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});

        if (!resolved && !selectedTargetId) {
          selectedTargetId = secureSample(targets)?.userId || '';
          stateManager.updateState({
            nightActions: {
              ...stateManager.getState().nightActions,
              apprenticeTargetId: selectedTargetId,
              apprenticePrediction: selectedPred
            }
          });
        }

        if (selectedTargetId) {
          const targetPlayerForAudio = stateManager.getState().players.find((p: Player) => p.userId === selectedTargetId);
          if (targetPlayerForAudio) {
            const isWolf = targetPlayerForAudio.role === '人狼';
            const isCorrect = (selectedPred === (isWolf ? 'wolf' : 'villager'));
            const apprenticeVc = await guild.channels.fetch(apprentice.waitVcId).catch(() => null) as VoiceBasedChannel;
            if (apprenticeVc) {
              playVoiceTask(getWorker(4), apprenticeVc, MSG.VOICE.APPRENTICE_SEER_RESULT(isWolf, isCorrect), 'apprentice_res');
            }
          }
        }
      } catch (e) {}
    })();

    // ⚡ 無謀な占い師のアクション
    const recklessPromise = (async () => {
      if (!reckless) return;
      try {
        const targets = alivePlayers.filter((p: Player) => p.userId !== reckless.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('reckless_target').setPlaceholder('占う対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }

        const pMsg = await this.sendToPersonalChannel(guild, reckless.userId, {
          content: '⚡ **【無謀な占い】** 占う対象を選択してください（※あなたは護衛の恩恵を受けられません）：',
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });

        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== reckless.userId) return;
          const targetId = i.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, recklessTargetId: targetId } });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});

        let targetIdForAudio = stateManager.getState().nightActions.recklessTargetId;
        if (!resolved && !targetIdForAudio) {
          targetIdForAudio = secureSample(targets)?.userId || '';
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, recklessTargetId: targetIdForAudio } });
        }

        if (targetIdForAudio) {
          const targetPlayerForAudio = stateManager.getState().players.find((p: Player) => p.userId === targetIdForAudio);
          if (targetPlayerForAudio) {
            const recklessVc = await guild.channels.fetch(reckless.waitVcId).catch(() => null) as VoiceBasedChannel;
            if (recklessVc) {
              playVoiceTask(getWorker(5), recklessVc, MSG.VOICE.SEER_RESULT(targetPlayerForAudio.role === '人狼'), 'reckless_res');
            }
          }
        }
      } catch (e) {}
    })();

    // 🦊 狐憑きのアクション
    const foxPossessedPromise = (async () => {
      if (!foxPossessed) return;
      try {
        const selectMenu = new StringSelectMenuBuilder().setCustomId('fox_protect_target').setPlaceholder('加護を与える対象を選択');
        for (const target of alivePlayers) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }

        const pMsg = await this.sendToPersonalChannel(guild, foxPossessed.userId, {
          content: '🎭 **【狐の加護】** 今夜加護を与える対象を選択してください（占いを無効化し、妖狐の呪殺を防ぎます）：',
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });

        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== foxPossessed.userId) return;
          const targetId = i.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, foxProtectedTargetId: targetId } });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();

          const targetMember = await guild.members.fetch(targetId).catch(() => null);
          const targetName = targetMember?.displayName || '選択した対象';
          const foxVc = await guild.channels.fetch(foxPossessed.waitVcId).catch(() => null) as VoiceBasedChannel;
          if (foxVc) {
            playVoiceTask(getWorker(6), foxVc, MSG.VOICE.FOX_PROTECT_SET(targetName), 'fox_res');
          }
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    // ⚰️ 棺桶屋のアクション
    const undertakerPromise = (async () => {
      if (!undertaker) return;
      try {
        const history = stateManager.getState().undertakerHistory?.[undertaker.userId] || [];
        let validTargets = alivePlayers.filter(p => !history.includes(p.userId));

        // 全員指定済みなら履歴リセット
        if (validTargets.length === 0) {
          validTargets = alivePlayers;
          stateManager.updateState({
            undertakerHistory: { ...stateManager.getState().undertakerHistory, [undertaker.userId]: [] }
          });
        }

        const selectMenu = new StringSelectMenuBuilder().setCustomId('undertaker_target').setPlaceholder('明日処刑されそうな人を予想');
        for (const target of validTargets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }

        const currentHits = stateManager.getState().undertakerHitCount || 0;
        const pMsg = await this.sendToPersonalChannel(guild, undertaker.userId, {
          content: `⚰️ **【棺桶屋の処刑予想】** (現在的中: **${currentHits}/2回**)\n明日処刑される人物を予想してください（2回的中で即時単独勝利）：`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });

        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== undertaker.userId) return;
          const targetId = i.values[0];
          const newHist = [...(stateManager.getState().undertakerHistory?.[undertaker.userId] || []), targetId];
          stateManager.updateState({
            nightActions: { ...stateManager.getState().nightActions, undertakerTargetId: targetId },
            undertakerHistory: { ...stateManager.getState().undertakerHistory, [undertaker.userId]: newHist }
          });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();

          const targetMember = await guild.members.fetch(targetId).catch(() => null);
          const targetName = targetMember?.displayName || '選択した対象';
          const undertakerVc = await guild.channels.fetch(undertaker.waitVcId).catch(() => null) as VoiceBasedChannel;
          if (undertakerVc) {
            playVoiceTask(getWorker(7), undertakerVc, MSG.VOICE.UNDERTAKER_TARGET_SET(targetName), 'undertaker_res');
          }
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    // 🪤 罠師のアクション
    const trapperPromise = (async () => {
      if (!trapper) return;
      try {
        const targets = alivePlayers.filter(p => p.userId !== trapper.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('trap_target').setPlaceholder('罠を仕掛ける対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        const pMsg = await this.sendToPersonalChannel(guild, trapper.userId, {
          content: MSG.CHAT.DM_TRAPPER_PROMPT,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });
        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });
        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== trapper.userId) return;
          const targetId = i.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, trapperTargetId: targetId } });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();
          const targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, trapper.userId, `✅ **${targetName}** さんに罠を仕掛けました。`);
          const trapperVc = await guild.channels.fetch(trapper.waitVcId).catch(() => null) as VoiceBasedChannel;
          if (trapperVc) {
            playVoiceTask(getWorker(8), trapperVc, MSG.VOICE.TRAPPER_TARGET_SET(targetName), 'trapper_res');
          }
        });
        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    // 🩺 カウンセラーのアクション
    const counselorPromise = (async () => {
      if (!counselor) return;
      try {
        const targets = alivePlayers.filter(p => p.userId !== counselor.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('counsel_target').setPlaceholder('カウンセリング対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        const pMsg = await this.sendToPersonalChannel(guild, counselor.userId, {
          content: MSG.CHAT.DM_COUNSELOR_PROMPT,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });
        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });
        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== counselor.userId) return;
          const targetId = i.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, counselorTargetId: targetId } });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();
          const targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, counselor.userId, `✅ **${targetName}** さんにカウンセリングを行います。`);
          const counselorVc = await guild.channels.fetch(counselor.waitVcId).catch(() => null) as VoiceBasedChannel;
          if (counselorVc) {
            playVoiceTask(getWorker(9), counselorVc, MSG.VOICE.COUNSELOR_TARGET_SET(targetName), 'counselor_res');
          }
        });
        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    // 🕵️ スパイのアクション
    const spyPromise = (async () => {
      if (!spy) return;
      try {
        const targets = alivePlayers.filter(p => p.userId !== spy.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('spy_target').setPlaceholder('能力を妨害する対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        const pMsg = await this.sendToPersonalChannel(guild, spy.userId, {
          content: MSG.CHAT.DM_SPY_PROMPT,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });
        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });
        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== spy.userId) return;
          const targetId = i.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, spyTargetId: targetId } });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();
          const targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, spy.userId, `✅ **${targetName}** さんの能力妨害を指定しました。`);
          const spyVc = await guild.channels.fetch(spy.waitVcId).catch(() => null) as VoiceBasedChannel;
          if (spyVc) {
            playVoiceTask(getWorker(10), spyVc, MSG.VOICE.SPY_TARGET_SET(targetName), 'spy_res');
          }
        });
        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    // 🏹 ハンターのアクション（夜の事前道連れ指定）
    const hunterPromise = (async () => {
      if (!hunter) return;
      try {
        const targets = alivePlayers.filter(p => p.userId !== hunter.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('hunter_target').setPlaceholder('道連れにする対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        const pMsg = await this.sendToPersonalChannel(guild, hunter.userId, {
          content: MSG.CHAT.DM_HUNTER_PROMPT,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });
        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });
        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== hunter.userId) return;
          const targetId = i.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, hunterRevengeTargetId: targetId } });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();
          const targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, hunter.userId, `✅ 万一の道連れ先として **${targetName}** さんを指定しました。`);
          const hunterVc = await guild.channels.fetch(hunter.waitVcId).catch(() => null) as VoiceBasedChannel;
          if (hunterVc) {
            playVoiceTask(getWorker(11), hunterVc, MSG.VOICE.HUNTER_TARGET_SET(targetName), 'hunter_res');
          }
        });
        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    // 🔮 覚醒した占い師の弟子の占いアクション
    const apprenticeDivinerPromise = (async () => {
      if (!apprenticeDiviner || !stateManager.getState().apprenticeDivinerAwakened) return;
      try {
        const targets = alivePlayers.filter(p => p.userId !== apprenticeDiviner.userId);
        const selectMenu = new StringSelectMenuBuilder().setCustomId('ad_target').setPlaceholder('占う対象を選択');
        for (const target of targets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        const pMsg = await this.sendToPersonalChannel(guild, apprenticeDiviner.userId, {
          content: '🔮 **【覚醒・弟子の占い】** 師匠の遺志を継ぎ、占う対象を1名選択してください：',
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });
        if (!pMsg) return;
        let resolved = false;
        const collector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: settings.actionTimeoutMin * 60000 + nightBonusMs });
        collector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== apprenticeDiviner.userId) return;
          const targetId = i.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, seerTargetId: targetId } });
          resolved = true;
          await i.deferUpdate().catch(() => {});
          collector.stop();
          const targetPlayer = stateManager.getState().players.find(p => p.userId === targetId);
          const isWolf = targetPlayer?.role === '人狼';
          const targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, apprenticeDiviner.userId, MSG.CHAT.DM_SEER_RESULT(targetName, isWolf));
          const adVc = await guild.channels.fetch(apprenticeDiviner.waitVcId).catch(() => null) as VoiceBasedChannel;
          if (adVc) {
            playVoiceTask(getWorker(12), adVc, MSG.VOICE.SEER_RESULT(isWolf), 'ad_res');
          }
        });
        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => resolved);
        collector.stop();
        await pMsg.delete().catch(() => {});
      } catch (e) {}
    })();

    await Promise.all([
      wolfPromise, 
      seerPromise, 
      knightPromise, 
      apprenticePromise, 
      recklessPromise, 
      foxPossessedPromise, 
      undertakerPromise,
      trapperPromise,
      counselorPromise,
      spyPromise,
      hunterPromise,
      apprenticeDivinerPromise
    ]);

    if ((StateManager.getInstance().getState().awayPlayerIds || []).length > 0) {
        await this.waitWithPauseAndCondition(9999999 * 1000, () => (StateManager.getInstance().getState().awayPlayerIds || []).length === 0);
    }
    
    awayCollector.stop();
    for (const interval of awayIntervals.values()) clearInterval(interval);
    awayIntervals.clear();
    StateManager.getInstance().updateState({ awayPlayerIds: [] });
    await awayMsg.delete().catch(()=>{});

    clearInterval(nightTimerInterval);
    await nightTimerMsg.edit(MSG.CHAT.NIGHT_WOLF_TIMER_UPDATE(`**【終了済】**`, '░'.repeat(20), 0, '00')).catch(()=>{});
    
    await Promise.all(workerLocks.values());

    for (const worker of freeWorkers) {
      try {
        VoiceService.disconnectClient(worker, gameId);
      } catch(e) {}
    }

    if (aliveWolves.length > 0 && !stateManager.getState().nightActions.wolfTargetId) {
        const randomTarget = secureSample(wolfTargets).userId;
        stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, wolfTargetId: randomTarget } });
        
        const targetName = (await guild.members.fetch(randomTarget)).displayName;
        for (const wolf of aliveWolves) {
            await this.sendToPersonalChannel(guild, wolf.userId, MSG.CHAT.DM_TIMEOUT_WOLF(targetName));
        }
    }

    for (const wolf of aliveWolves) {
      actionQueue.add(async () => {
        try { 
          const m = await guild.members.fetch(wolf.userId); 
          if (m.voice.channelId) await m.voice.setMute(true); 
        } catch (e) {}
      }, `mute-wolf-${wolf.userId}`);
    }
    await actionQueue.waitForEmpty();
    await new Promise(resolve => setTimeout(resolve, 1500)); 

    // ==========================================
    // 🌙 ルール解決エンジンによる夜のアクション突合
    // ==========================================
    const nightResolution = NightActionResolver.resolve(
      stateManager.getState().players,
      stateManager.getState().nightActions,
      stateManager.getState().apprenticeStatus || {},
      {
        loversUserIds: stateManager.getState().loversUserIds,
        femmeFataleData: stateManager.getState().femmeFataleData,
        livingSpiritData: stateManager.getState().livingSpiritData,
        queenUserId: stateManager.getState().queenUserId,
        apprenticeDivinerAwakened: stateManager.getState().apprenticeDivinerAwakened
      }
    );

    // スパイ妨害通知
    if (nightResolution.spyBlockedUserId) {
      await this.sendToPersonalChannel(guild, nightResolution.spyBlockedUserId, MSG.CHAT.DM_SPY_BLOCKED);
    }

    // カウンセラー更生通知
    if (nightResolution.counselorReformedUserId && counselor) {
      await this.sendToPersonalChannel(guild, counselor.userId, MSG.CHAT.DM_COUNSELOR_REFORMED);
      await this.sendToPersonalChannel(guild, nightResolution.counselorReformedUserId, MSG.CHAT.DM_COUNSELOR_TARGET_REFORMED);
    }

    // タフガイ毒通知
    if (nightResolution.toughGuyPoisonedUserIds && nightResolution.toughGuyPoisonedUserIds.length > 0) {
      const currentPoisoned = stateManager.getState().toughGuyPoisoned || {};
      for (const tgId of nightResolution.toughGuyPoisonedUserIds) {
        currentPoisoned[tgId] = true;
        await this.sendToPersonalChannel(guild, tgId, MSG.CHAT.DM_TOUGH_GUY_ATTACKED);
      }
      stateManager.updateState({ toughGuyPoisoned: currentPoisoned });
    }

    // 狙われる市民感染通知
    if (nightResolution.targetedCivilianInfectedUserId) {
      await this.sendToPersonalChannel(guild, nightResolution.targetedCivilianInfectedUserId, MSG.CHAT.DM_TARGETED_CIVILIAN_INFECTED);
    }

    // 占い師たちへの結果送信
    for (const sr of nightResolution.seerResults) {
      const targetM = await guild.members.fetch(sr.targetUserId).catch(() => null);
      const targetName = targetM?.displayName || '不明なプレイヤー';

      let resultText = '';
      if (sr.result === 'blocked') {
        resultText = `🔮 **占い結果:** ${targetName} の判定結果は **【 ×（判定不能） 】** でした。`;
      } else {
        const isWolfStr = sr.result === 'wolf' ? '人狼 🐺' : '村人（人狼ではない） 🧑';
        resultText = `🔮 **占い結果:** ${targetName} は **【 ${isWolfStr} 】** でした。`;
      }

      if (sr.isApprentice) {
        if (sr.predictionCorrect) {
          resultText += `\n🎉 **予想的中！** 翌夜も引き続き占うことができます。`;
        } else {
          resultText += `\n❌ **予想が外れました！** 翌夜から占いの能力を失います。`;
          stateManager.updateState({
            apprenticeStatus: { ...stateManager.getState().apprenticeStatus, [sr.seerUserId]: true }
          });
        }
      }

      await this.sendToPersonalChannel(guild, sr.seerUserId, resultText);
    }

    // 狐憑きへの妖狐守護フィードバック
    if (nightResolution.foxProtectedSuccess && nightResolution.foxPossessedUserId) {
      await this.sendToPersonalChannel(guild, nightResolution.foxPossessedUserId, '👍 **妖狐の守護に成功しました！**（あなたの加護によって妖狐が守られました）');
    }

    // 死亡者の適用
    const killedUserIds = nightResolution.killedUserIds;
    if (killedUserIds.length > 0) {
      const updatedPlayers = stateManager.getState().players.map((p: Player) => 
        killedUserIds.includes(p.userId) ? { ...p, isAlive: false } : p
      );
      
      for (const kid of killedUserIds) {
        const km = await guild.members.fetch(kid).catch(() => null);
        state.eventLogs.push(`[第${state.day}日 夜] ${km?.displayName || kid} が無惨な姿で発見された`);
      }
      stateManager.updateState({ players: updatedPlayers, eventLogs: state.eventLogs });
    }

    stateManager.updateState({ day: state.day + 1, executedUserId: undefined });
    const winningTeam = this.checkWinCondition(stateManager.getState());

    // 朝のアナウンス文の生成（複数人死亡対応）
    let morningText = '';
    if (killedUserIds.length === 0) {
      morningText = MSG.VOICE.MORNING_PEACE;
    } else {
      const killedNames = (await Promise.all(killedUserIds.map(async id => {
        const m = await guild.members.fetch(id).catch(() => null);
        return m?.displayName || '不明なプレイヤー';
      }))).join('さんと、');
      morningText = `おはようございます。昨晩の犠牲者は・・・${killedNames}さんでした。`;
    }

    // パン屋のアナウンスチェック
    const aliveBaker = stateManager.getState().players.some(p => p.isAlive && p.role === 'パン屋');
    const hasBakerInVillage = stateManager.getState().players.some(p => p.role === 'パン屋');
    if (hasBakerInVillage) {
      if (aliveBaker) {
        morningText += ' また、今朝もパン屋がおいしいパンを焼いてくれました。';
      } else {
        morningText += ' しかし、今朝はパン屋からパンが届きませんでした。';
      }
    }

    if (winningTeam) {
      stateManager.nextPhase('finished');
      await this.finishGame(gmClient, assistantClient, gameId, winningTeam, 'bite', morningText);
    } else {
      // 🚨 修正：朝のGMアナウンスまでは、生存者および今夜の犠牲者(killedUserIds)をメインVC(mainVcId)に集め、すでに死亡している人だけを霊界VC(ghostVcId)へ送る
      await this.syncLedgerAndMove(guild, gameId, 'day', killedUserIds[0]);
      
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (mainVcChannel && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        await new Promise(r => setTimeout(r, 1000));
        const morningAudio = await TTSService.generateAudio(morningText, gameId, `morning_${state.day}`);
        await VoiceService.playAudio(gmConnection, morningAudio, gameId);
      }
      
      const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
      await voteChannel.send(MSG.CHAT.MORNING_ANNOUNCE(stateManager.getState().day, morningText));

      // 🚨 朝のアナウンス完了後、犠牲者を霊界VCへ移動
      await this.syncLedgerAndMove(guild, gameId, 'day');

      // 犠牲者のミュート解除
      for (const kid of killedUserIds) {
        try { 
          const m = await guild.members.fetch(kid);
          if (m.voice.channelId) await m.voice.setMute(false); 
        } catch (e) {}
      }
      
      stateManager.nextPhase('day_discussion');
      await this.startDayDiscussion(gmClient, assistantClient, gameId); 
    }
  }

  public static async finishGame(gmClient: Client, assistantClient: Client, gameId: string, winningTeam: string, reason: 'execution' | 'bite', morningText?: string): Promise<void> {
    Logger.info('PhaseHandler', `🎊 終了フェーズを開始します。`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    const settings = state.settingsSnapshot; 
    const sysTimeMs = this.getSysTimeMs(settings);

    await this.syncLedgerAndMove(guild, gameId, 'finish'); 
    
    for (const player of state.players) {
      actionQueue.add(async () => {
        try { 
          const m = await guild.members.fetch(player.userId);
          if (m.voice.channelId) await m.voice.setMute(false); 
        } catch (error) {}
      }, `finish-gather-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    state.eventLogs.push(`[終了] ${winningTeam} の勝利`);
    stateManager.updateState({ eventLogs: state.eventLogs, endedAt: Date.now() });

    let resultText = MSG.CHAT.SYS_WIN(winningTeam);
    for (const p of state.players) {
      const name = (guild.members.cache.get(p.userId) || await guild.members.fetch(p.userId).catch(() => null))?.displayName || '不明';
      resultText += `- ${name}: **${p.role}** (${p.isAlive ? '生存' : '死亡'})\n`;
    }
    
    await DiscordService.archiveGameChannel(guild, state.voteChannelId, gameId);

    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;

    if (mainVcChannel && ghostVc) {
      const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      await new Promise(r => setTimeout(r, 1000));
      const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
      const broadcastConns = [gmConnection, assistantConnection];

      let winVoiceText = MSG.VOICE.WIN_EXECUTION_VILLAGER;
      if (winningTeam === '村人陣営') {
        winVoiceText = (reason === 'execution') ? MSG.VOICE.WIN_EXECUTION_VILLAGER : '人狼がいなくなったため、村人陣営の勝利です！';
      } else if (winningTeam === '人狼陣営') {
        winVoiceText = (reason === 'execution') ? MSG.VOICE.WIN_EXECUTION_WOLF : MSG.VOICE.WIN_BITE_WOLF;
      } else if (winningTeam === '恋人陣営') {
        winVoiceText = MSG.VOICE.WIN_LOVERS;
      } else if (winningTeam === '一匹狼') {
        winVoiceText = MSG.VOICE.WIN_LONE_WOLF;
      } else if (winningTeam === '神様') {
        winVoiceText = MSG.VOICE.WIN_GOD;
      } else if (winningTeam === 'てるてる坊主') {
        winVoiceText = MSG.VOICE.WIN_FOOL;
      } else if (winningTeam === '棺桶屋') {
        winVoiceText = MSG.VOICE.WIN_UNDERTAKER;
      } else if (winningTeam === '妖狐陣営') {
        winVoiceText = MSG.VOICE.WIN_FOX;
      }

      if (reason === 'bite' && morningText) {
        const morningAudio = await TTSService.generateAudio(morningText, gameId, 'morning_kill');
        await VoiceService.broadcastAudio(broadcastConns, morningAudio, gameId);
      }
      const winAudio = await TTSService.generateAudio(winVoiceText, gameId, `win_${reason}`);
      await VoiceService.broadcastAudio(broadcastConns, winAudio, gameId);
      
      await voteChannel.send(resultText);

      const sysSettings = SettingsManager.getInstance().getSystem();
      const reg = state.regulationId ? RegulationManager.getInstance().get(state.regulationId) : undefined;
      const isAIRecordingEnabled = reg?.system?.enableAIRecording !== undefined
        ? reg.system.enableAIRecording
        : (sysSettings.enableAIRecording !== false);

      if (isAIRecordingEnabled) {
        const nextAudio = await TTSService.generateAudio(MSG.VOICE.MVP_NEXT, gameId, 'win_announce_next');
        await VoiceService.broadcastAudio(broadcastConns, nextAudio, gameId);
        await voteChannel.send(MSG.CHAT.MVP_ANALYZING);
        
        try {
          const playerNameMap: Record<string, string> = {};
          for (const p of state.players) {
            playerNameMap[p.userId] = (guild.members.cache.get(p.userId) || await guild.members.fetch(p.userId).catch(() => null))?.displayName || '不明なプレイヤー';
          }
          const regulationSummary = RegulationManager.getInstance().formatSummary(reg, state.players);

          // 🚨 戻り値から wasForcedFallback を受け取る
          const mvpData = await AIService.analyzeMVP(gameId, state.speechLogs, playerNameMap, state.eventLogs, regulationSummary);
          
          let resultText = '';
          let voiceText = '';

          if (sysSettings.mvpMode === 'compare') {
              resultText = MSG.CHAT.MVP_RESULT_DOUBLE(mvpData.discussionMvpName || '不明', mvpData.contributionMvpName || '不明', mvpData.text);
              voiceText = MSG.VOICE.MVP_ANNOUNCE_DOUBLE(mvpData.discussionMvpName || '不明', mvpData.contributionMvpName || '不明');
          } else {
              const title = sysSettings.mvpMode === 'discussion' ? '議論MVP' : '勝利貢献MVP';
              resultText = MSG.CHAT.MVP_RESULT_SINGLE(title, mvpData.mvpName, mvpData.text);
              voiceText = MSG.VOICE.MVP_ANNOUNCE_SINGLE(title, mvpData.mvpName);
          }

          // 🚨 インテリジェント・フォールバックが発生した場合、システム通知を挿入し、全体設定を上書きする
          if (mvpData.wasForcedFallback) {
              const warningMsg = `⚠️ **【システム通知】**\n設定されていたAIモデルで制限または権限エラーを検知したため、安全な無料枠モデル（自動フォールバック）へ切り替えて解析を実行しました。\n次回以降の遅延を防ぐため、サーバーの全体設定を **「自動フォールバック」** に自動更新しました。\n\n---\n\n`;
              resultText = warningMsg + resultText;
              SettingsManager.getInstance().updateSystem({ aiModel: 'fallback' });
              Logger.warn('PhaseHandler', `🔧 強制ダウングレードを検知したため、システム設定を 'fallback' に自動更新しました。`, gameId);
          }

          const chunks = this.splitMessage(resultText);
          for (const chunk of chunks) await voteChannel.send(chunk);
          
          const mvpAudio = await TTSService.generateAudio(voiceText, gameId, 'mvp_announce');
          await VoiceService.broadcastAudio(broadcastConns, mvpAudio, gameId);
        } catch (error) {
          await voteChannel.send(MSG.CHAT.MVP_ERROR(gameId));
        }
      } else {
        Logger.info('PhaseHandler', '🎙️ AI総評・音声解析は設定により無効化されているためスキップします', gameId);
        await voteChannel.send('ℹ️ **【AI総評】** この村はAI総評・録音機能がOFFに設定されているため、講評をスキップします。感想戦をお楽しみください！');
      }
    }

    await new Promise(resolve => setTimeout(resolve, sysTimeMs.CLEANUP_DELAY));
    
    // 🚨 終局時の大掃除大リセット：全Worker（マイク・書記・スピーカー・プレイヤー役すべて）を安全に「スタッフXX」に一括初期化
    const wm = WorkerManager.getInstance();
    await Promise.all(wm.getWorkers().map(async (worker) => {
       await wm.renameWorker(worker, state.serverId, null);
       try {
         const wGuild = await worker.guilds.fetch(state.serverId).catch(() => null);
         if (wGuild && wGuild.members.me && wGuild.members.me.voice.channelId) {
           await wGuild.members.me.voice.disconnect().catch(() => {});
         }
       } catch (e) {}
    }));

    try {
      const gmMember = await guild.members.fetch(gmClient.user!.id);
      if (gmMember && gmMember.voice.channelId) await gmMember.voice.disconnect().catch(() => {});
    } catch (e) {}

    try {
      const astMember = await guild.members.fetch(assistantClient.user!.id);
      if (astMember && astMember.voice.channelId) await astMember.voice.disconnect().catch(() => {});
    } catch (e) {}

    VoiceService.disconnectAll(gameId);
    VCWatcher.getInstance().stop();
    await this.syncLedgerAndMove(guild, gameId, 'lobby');

    const deleteIds = [
      state.mainVcId, 
      state.wolfVcId, 
      state.ghostVcId, 
      state.wolfTextChannelId 
    ];

    state.players.forEach((p: Player) => {
      deleteIds.push(p.waitVcId);
      if (p.personalTextChannelId) {
        deleteIds.push(p.personalTextChannelId);
      }
    });    
    for (const id of deleteIds) {
      if (!id) continue;
      actionQueue.add(async () => {
        try { 
          const ch = await guild.channels.fetch(id); 
          if (ch) await ch.delete(); 
        } catch (e) {}
      }, `cleanup-channel-${id}`);
    }
    
    for (const player of state.players) {
      actionQueue.add(async () => {
        try { 
          const role = await guild.roles.fetch(player.personalRoleId); 
          if (role) await role.delete(); 
        } catch (e) {}
      }, `cleanup-personal-role-${player.userId}`);
    }
    
    actionQueue.add(async () => {
      try {
        const category = await guild.channels.fetch(state.categoryId);
        if (category) await category.delete();
        const commonRole = guild.roles.cache.find(r => r.name === `GM-COMMON-${gameId}`);
        if (commonRole) await commonRole.delete();
      } catch (e) {}
    }, `cleanup-base`);
    
    await actionQueue.waitForEmpty();
  }
  
  public static async resumeGame(gmClient: Client, assistantClient: Client, gameId: string): Promise<void> {
    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();
    try {
      const guild = await gmClient.guilds.fetch(state.serverId).catch(() => null);
      if (!guild) {
        Logger.warn('PhaseHandler', `⚠️ ギルド (${state.serverId}) が見つからないため、ゲーム [${gameId}] を終了としてマークします`, gameId);
        stateManager.updateState({ phase: 'finished' });
        return;
      }
      
      VoiceService.disconnectAll(gameId);
      
      const voteChannel = await guild.channels.fetch(state.voteChannelId).catch(() => null) as TextChannel | null;
      if (!voteChannel) {
        Logger.warn('PhaseHandler', `⚠️ 投票チャンネル (${state.voteChannelId}) が存在しないため、ゲーム [${gameId}] を終了としてマークします`, gameId);
        stateManager.updateState({ phase: 'finished' });
        return;
      }
      
      await voteChannel.send(MSG.CHAT.SYS_RECOVER(state.phase)).catch(() => {});

      switch (state.phase) {
        case 'setup': await this.startRoleDistribution(gmClient, assistantClient, gameId); break;
        case 'day_discussion': await this.startDayDiscussion(gmClient, assistantClient, gameId); break;
        case 'voting': await this.startVotingPhase(gmClient, assistantClient, gameId); break;
        case 'runoff_voting':
          if (state.runoffTargets && state.runoffTargets.length > 0) {
            await this.handleRunoffVotingPhase(gmClient, assistantClient, gameId, state.runoffTargets);
          } else {
            Logger.warn('PhaseHandler', '⚠️ 決選投票対象が見つからないため、投票フェーズから再開します', gameId);
            await this.startVotingPhase(gmClient, assistantClient, gameId);
          }
          break;
        case 'execution': 
          if (state.executedUserId !== undefined) {
            await this.handleExecutionPhase(gmClient, assistantClient, gameId, state.executedUserId);
          } else {
            Logger.warn('PhaseHandler', '⚠️ 処刑対象データが見つからないため、投票フェーズから再開します', gameId);
            await this.startVotingPhase(gmClient, assistantClient, gameId);
          }
          break;
        case 'night': await this.startNightPhase(gmClient, assistantClient, gameId); break;
      }
    } catch (err: any) {
      Logger.error('PhaseHandler', `❌ ゲーム [${gameId}] の復帰中に予期せぬエラーが発生しました: ${err.message}`, gameId);
      throw err;
    }
  }
}
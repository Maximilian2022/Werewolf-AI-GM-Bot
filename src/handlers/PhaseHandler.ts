/**
 * src/handlers/PhaseHandler.ts
 * 決選投票オプション設定・警告アナウンス・開票可視化 統合完全版
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
import { GAME_CONSTANTS } from '../constants.js';
import { Player, GameState } from '../types.js';
import { Logger } from '../utils/logger.js';
import { MSG } from '../messages.js';
import { GameSettings } from '../managers/SettingsManager.js';

export class PhaseHandler {
  private static getSysTimeMs(settings: GameSettings) {
    return {
      LAST_WORD: settings.lastWordMin * 60 * 1000,
      CLEANUP_DELAY: settings.cleanupDelayMin * 60 * 1000
    };
  }

  private static shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private static checkWinCondition(state: GameState): '村人陣営' | '人狼陣営' | null {
    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    const aliveWolves = alivePlayers.filter((p: Player) => p.role === '人狼').length;
    const aliveVillagers = alivePlayers.length - aliveWolves;

    if (aliveWolves === 0) return '村人陣営';
    else if (aliveWolves >= aliveVillagers) return '人狼陣営';
    return null;
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

  private static async syncLedgerAndMove(guild: Guild, gameId: string, phaseType: 'setup' | 'day' | 'night' | 'lobby' | 'finish') {
    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();
    const expected: Record<string, string> = {};

    for (const player of state.players) {
      if (!player.isAlive) {
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
    for (const player of state.players) {
      actionQueue.add(async () => {
        const targetVcId = expected[player.userId];
        const member = await guild.members.fetch(player.userId).catch(() => null);
        if (member && member.voice.channelId && member.voice.channelId !== targetVcId) {
          await member.voice.setChannel(targetVcId).catch(() => {});
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

    const originalVc = await guild.channels.fetch(state.originalVcId) as VoiceBasedChannel;
    if (originalVc && originalVc.isVoiceBased()) {
      const connection = await VoiceService.connectWithClient(gmClient, originalVc, gameId, 'lobby');
      const audio = await TTSService.generateAudio(MSG.VOICE.GREETING, gameId, 'greeting');
      await VoiceService.playAudio(connection, audio, gameId);
      await new Promise(resolve => setTimeout(resolve, 1000));
      connection.destroy();
      Logger.info('PhaseHandler', '🚪 GMがロビーVCから退出しました（次回は全体議論VCへ新規接続します）', gameId);
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

    const rolesToAssign = GAME_CONSTANTS.ROLES[state.players.length as 11 | 13];
    const shuffledRoles = this.shuffleArray(rolesToAssign);
    const updatedPlayers: Player[] = state.players.map((player: Player, index: number) => ({
      ...player, 
      role: shuffledRoles[index],
    }));

    const roleMapPromises = updatedPlayers.map(async p => {
      const m = await guild.members.fetch(p.userId).catch(() => null);
      return `${m?.displayName || '不明'}:${p.role}`;
    });
    const rolesStr = (await Promise.all(roleMapPromises)).join(', ');
    
    stateManager.updateState({ players: updatedPlayers, day: 1, eventLogs: [`[セットアップ] 実際の配役: ${rolesStr}`] });

    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    await voteChannel.send(MSG.CHAT.SYS_START_ROLE);

    const wolfTextCh = await guild.channels.fetch(state.wolfTextChannelId) as TextChannel;
    const wolves = updatedPlayers.filter(p => p.role === '人狼');
    for (const w of wolves) {
      await wolfTextCh.permissionOverwrites.create(w.userId, { ViewChannel: true, SendMessages: false });
    }

    const seer = updatedPlayers.find(p => p.role === '占い師');
    const safeTargets = updatedPlayers.filter(p => p.role !== '人狼' && p.role !== '占い師');
    const firstWhiteTarget = seer ? this.shuffleArray(safeTargets)[0] : null;

    for (const player of updatedPlayers) {
      actionQueue.add(async () => {
        let message = MSG.CHAT.DM_ROLE_HEADER + MSG.CHAT.DM_ROLE_YOUR_ROLE(player.role as string);
        if (player.role === '人狼') {
          message += MSG.CHAT.DM_ROLE_WOLF_GUIDE;
        } else if (player.role === '占い師' && firstWhiteTarget) {
          const targetMember = await guild.members.fetch(firstWhiteTarget.userId).catch(() => null);
          if (targetMember) message += MSG.CHAT.DM_ROLE_SEER_FIRST(targetMember.displayName);
          message += MSG.CHAT.DM_ROLE_WAIT;
        } else {
          message += MSG.CHAT.DM_ROLE_WAIT;
        }
        await this.sendToPersonalChannel(guild, player.userId, message);
      }, `distribute-role-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    await this.syncLedgerAndMove(guild, gameId, 'night');

    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const wolfVc = await assistantGuild.channels.fetch(state.wolfVcId).catch(()=>null) as VoiceBasedChannel;
    
    const playerIds = state.players.map((p: Player) => p.userId);
    const freeWorkers = await WorkerManager.getInstance().getFreeWorkers(state.serverId, playerIds, 2);
    
    const wolfWorkerClient = freeWorkers.length > 0 ? freeWorkers.shift()! : assistantClient; 
    const seerWorkerClient = freeWorkers.length > 0 ? freeWorkers.shift()! : assistantClient;

    let nightWorkerConn: any = null;

    if (wolfVc) {
      Logger.info('PhaseHandler', `🐺 [初日人狼内通スタッフ配置] \n  - 担当: ${wolfWorkerClient.user?.tag || 'なし'} (${wolfWorkerClient.user?.id || 'null'})`, gameId);
      nightWorkerConn = await VoiceService.connectWithClient(wolfWorkerClient, wolfVc, gameId, 'first_wolf');
    }

    const aliveWolves = stateManager.getState().players.filter((p: Player) => p.role === '人狼' && p.isAlive);
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

      const isFree = WorkerManager.getInstance().getWorkers().some(w => w.user?.id === wolfWorkerClient.user?.id && !playerIds.includes(w.user!.id));
      if (isFree) {
        try {
          const wGuild = await wolfWorkerClient.guilds.fetch(state.serverId).catch(()=>null);
          wGuild?.members.me?.voice.disconnect();
        } catch(e) {}
      }
    }

    if (seer && firstWhiteTarget) {
      const seerVc = await guild.channels.fetch(seer.waitVcId).catch(()=>null) as VoiceBasedChannel;
      if (seerVc) {
        Logger.info('PhaseHandler', `🔮 [初日占い師アナウンススタッフ配置] \n  - 担当: ${seerWorkerClient.user?.tag || 'なし'} (${seerWorkerClient.user?.id || 'null'})`, gameId);
        const seerConn = await VoiceService.connectWithClient(seerWorkerClient, seerVc, gameId, 'first_seer');
        await new Promise(r => setTimeout(r, 1000));
        const targetMember = await guild.members.fetch(firstWhiteTarget.userId).catch(()=>null);
        if (targetMember) {
          const seerAudio = await TTSService.generateAudio(MSG.VOICE.SEER_FIRST(targetMember.displayName), gameId, 'first_seer_res');
          await VoiceService.playAudio(seerConn, seerAudio, gameId);
        }
        
        const isFree = WorkerManager.getInstance().getWorkers().some(w => w.user?.id === seerWorkerClient.user?.id && !playerIds.includes(w.user!.id));
        if (isFree) {
          try {
            const wGuild = await seerWorkerClient.guilds.fetch(state.serverId).catch(()=>null);
            wGuild?.members.me?.voice.disconnect();
          } catch(e) {}
        }
      }
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
        await new Promise(r => setTimeout(r, 1000)); 

        const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
        await new Promise(r => setTimeout(r, 1000)); 

        const workers = WorkerManager.getInstance().getWorkers();
        let relayClient = state.relayWorkerId ? workers.find(w => w.user?.id === state.relayWorkerId) : null;
        let recordClient = state.recorderWorkerId ? workers.find(w => w.user?.id === state.recorderWorkerId) : null;

        if (!relayClient || !recordClient) {
          const playerIds = state.players.map((p: Player) => p.userId);
          const needed = (!relayClient ? 1 : 0) + (!recordClient ? 1 : 0);
          const freeWorkers = await WorkerManager.getInstance().getFreeWorkers(state.serverId, playerIds, needed);
          
          if (!relayClient && freeWorkers.length > 0) relayClient = freeWorkers.shift();
          if (!recordClient && freeWorkers.length > 0) recordClient = freeWorkers.shift();
          
          stateManager.updateState({
            relayWorkerId: relayClient?.user?.id,
            recorderWorkerId: recordClient?.user?.id
          });
          Logger.info('PhaseHandler', `👷 [スタッフ雇用] \n  - 中継: ${relayClient?.user?.tag || 'なし'}\n  - 録音: ${recordClient?.user?.tag || 'なし'}`, gameId);
        }

        if (relayClient) {
          const relayListenerConn = await VoiceService.connectWithClient(relayClient, mainVc, gameId, 'relay_listener');
          await new Promise(r => setTimeout(r, 1000)); 
          
          if (!(relayListenerConn as any)._mixerSetupDone) {
            VoiceService.setupMixerRelay(relayListenerConn, assistantConnection, gameId);
            (relayListenerConn as any)._mixerSetupDone = true;
          }
          if (state.day === 1) { 
            const workerIndex = workers.findIndex(w => w.user?.id === relayClient!.user?.id);
            const workerNum = String(workerIndex + 1).padStart(2, '0');
            ActionQueue.getInstance().add(async () => {
              try {
                const relayGuild = await relayClient!.guilds.fetch(state.serverId);
                await relayGuild.members.me?.setNickname(`人狼ゲームマイク${workerNum}`);
              } catch (e) {}
            }, `rename-relay-${gameId}`);
          }
        }

        if (recordClient) {
          const recordConn = await VoiceService.connectWithClient(recordClient, mainVc, gameId, 'recorder');
          await new Promise(r => setTimeout(r, 1000)); 
          
          VoiceService.startRecording(recordConn, gameId);
          
          if (state.day === 1) { 
            const workerIndex2 = workers.findIndex(w => w.user?.id === recordClient!.user?.id);
            const workerNum2 = String(workerIndex2 + 1).padStart(2, '0');
            ActionQueue.getInstance().add(async () => {
              try {
                const recordGuild = await recordClient!.guilds.fetch(state.serverId);
                await recordGuild.members.me?.setNickname(`人狼ゲーム書記${workerNum2}`);
              } catch (e) {}
            }, `rename-record-${gameId}`);
          }
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
        await VoiceService.playAudio(gmConnection, startAudio, gameId);

        const timerMsg = await voteChannel.send(MSG.CHAT.DAY_TIMER_START(state.day, targetUnixTime));

        let remainAnnounced = false;
        const intervalMs = 10000; 
        let elapsed = 0;

        while (elapsed < totalDiscussionMs) {
          const currentState = StateManager.getInstance().getState();
          if (currentState.isPaused) {
              await timerMsg.edit(MSG.CHAT.DAY_TIMER_PAUSED(state.day)).catch(() => {});
              await new Promise(r => setTimeout(r, 2000));
              targetUnixTime += 2;
              continue;
          }

          const aliveWorkerPlayers = alivePlayers.filter(p => workers.some(w => w.user?.id === p.userId));
          if (aliveWorkerPlayers.length > 0 && Math.random() < 0.15) {
            const randomWorkerPlayer = aliveWorkerPlayers[Math.floor(Math.random() * aliveWorkerPlayers.length)];
            const workerClient = workers.find(w => w.user?.id === randomWorkerPlayer.userId);
            if (workerClient) {
              const phrase = MSG.VOICE.WORKER_PHRASES[Math.floor(Math.random() * MSG.VOICE.WORKER_PHRASES.length)];
              try {
                const workerConn = await VoiceService.connectWithClient(workerClient, mainVc, gameId, 'worker');
                const audio = await TTSService.generateAudio(phrase, gameId, `worker_${Date.now()}`);
                VoiceService.playAudio(workerConn, audio, gameId).catch(()=>{});
              } catch (e) {
                Logger.warn('PhaseHandler', 'バイト君の発声に失敗しました', gameId);
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

        const endAudio = await TTSService.generateAudio(MSG.VOICE.DAY_END, gameId, `day_end_${state.day}`);
        await VoiceService.playAudio(gmConnection, endAudio, gameId);

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
    let unvotedPlayers = [...alivePlayers];
    const votedPlayers: any[] = [];
    const waitQueue: Player[] = [];
    const randomVoterIds: string[] = [];
    const randomlyAssignedSpeakerIds: string[] = [];
    
    stateManager.updateState({ currentVotes: {} });
    await voteChannel.send(MSG.CHAT.SYS_VOTE_START(state.day));
    
    const handRaiseButton = new ButtonBuilder()
      .setCustomId('hand_raise')
      .setLabel('✋ 発言順を予約する')
      .setStyle(ButtonStyle.Primary);
    const handRaiseRow = new ActionRowBuilder<ButtonBuilder>().addComponents(handRaiseButton);

    const handRaiseMsg = await voteChannel.send({
      content: MSG.CHAT.VOTE_BUTTON_PROMPT,
      components: [handRaiseRow]
    });

    const statusMsg = await voteChannel.send(MSG.CHAT.VOTE_LOADING);

    let currentSpeaker: Player | null = null;
    
    const collector = handRaiseMsg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 24 * 60 * 60 * 1000
    });

    collector.on('collect', async (interaction: ButtonInteraction) => {
      if (interaction.customId !== 'hand_raise') return;
      const user = interaction.user;
      const p = unvotedPlayers.find(up => up.userId === user.id);
      if (p) {
        if (!waitQueue.find(q => q.userId === p.userId) && currentSpeaker?.userId !== p.userId) {
          waitQueue.push(p);
          await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_SUCCESS, flags: MessageFlags.Ephemeral }).catch(()=>{});
        } else {
          await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_DUPLICATE, flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      } else {
        await interaction.reply({ content: MSG.CHAT.VOTE_RESERVE_INVALID, flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
    });  

    while (unvotedPlayers.length > 0) {
      let speaker = waitQueue.shift();

      if (!speaker) {
        await this.waitWithPauseAndCondition(handRaiseTimeoutSec * 1000, () => waitQueue.length > 0);
        if (waitQueue.length > 0) {
          speaker = waitQueue.shift();
        } else {
          speaker = unvotedPlayers[Math.floor(Math.random() * unvotedPlayers.length)];
          randomlyAssignedSpeakerIds.push(speaker.userId);
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
           const qm = await guild.members.fetch(qp.userId).catch(() => null);
           uiText += MSG.CHAT.VOTE_UI_WAITING(qm?.displayName || '不明');
        }

        for (const up of unvotedPlayers) {
           if (up.userId !== currentSpeaker!.userId && !waitQueue.find(q => q.userId === up.userId)) {
             const um = await guild.members.fetch(up.userId).catch(() => null);
             uiText += MSG.CHAT.VOTE_UI_PENDING(um?.displayName || '不明');
           }
        }
        
        uiText += MSG.CHAT.VOTE_UI_RESULT_HEADER;
        const currentVotes = currentState.currentVotes;
        const counts: Record<string, string[]> = {};
        for (const [vId, tId] of Object.entries(currentVotes)) {
          if (!counts[tId]) counts[tId] = [];
          const voterM = await guild.members.fetch(vId).catch(() => null);
          const suffix = randomVoterIds.includes(vId) ? ' (ランダム)' : '';
          counts[tId].push(`${voterM?.displayName || '不明'}${suffix}`);
        }

        if (Object.keys(counts).length === 0) uiText += MSG.CHAT.VOTE_UI_NO_VOTES;
        else {
          for (const [tId, voters] of Object.entries(counts)) {
            const targetM = await guild.members.fetch(tId).catch(() => null);
            uiText += MSG.CHAT.VOTE_UI_VOTE_ITEM(targetM?.displayName || '不明', voters.length, voters.join(', '));
          }
        }
        await statusMsg.edit(uiText).catch(() => {});
      }, 2000);

      const mainVc = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
      
      let gmConn: any;
      if (mainVc) {
        gmConn = await VoiceService.connectWithClient(gmClient, mainVc, gameId, 'main');
      }

      actionQueue.add(async () => {
        try { if (speakerMember.voice.channelId) await speakerMember.voice.setMute(false); } catch (e) {}
      }, `unmute-${currentSpeaker!.userId}`);
      await actionQueue.waitForEmpty();

      if (gmConn) {
        await new Promise(r => setTimeout(r, 500)); 
        const timeStr = speechSec >= 60 ? `${Math.floor(speechSec / 60)}分` : `${speechSec}秒`;
        const speakerAudio = await TTSService.generateAudio(MSG.VOICE.VOTE_START(speakerMember.displayName, timeStr), gameId, `vote_start_${currentSpeaker!.userId}`);
        await VoiceService.playAudio(gmConn, speakerAudio, gameId);
      }

      const selectMenu = new StringSelectMenuBuilder().setCustomId('vote_select').setPlaceholder('処刑対象を選択');
      for (const target of alivePlayers.filter((p: Player) => p.userId !== currentSpeaker!.userId)) {
        const targetMember = await guild.members.fetch(target.userId).catch(() => null);
        if (targetMember) selectMenu.addOptions({ label: targetMember.displayName, value: target.userId });
      }

      let votedTargetId = '';
      
      const pChannelMsg = await this.sendToPersonalChannel(guild, currentSpeaker!.userId, { 
        content: MSG.CHAT.DM_VOTE_PROMPT, 
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] 
      });

      if (pChannelMsg) {
        const compCollector = pChannelMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect });
        compCollector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== currentSpeaker!.userId) return;
          votedTargetId = i.values[0];
          const targetName = (await guild.members.fetch(votedTargetId)).displayName;
          
          await i.deferUpdate();
          await pChannelMsg.delete().catch(()=>{});
          await this.sendToPersonalChannel(guild, currentSpeaker!.userId, MSG.CHAT.DM_VOTED(targetName));
          compCollector.stop();
        });
      }

      await this.waitWithPauseAndCondition((speechSec + voteSec) * 1000, () => votedTargetId !== '');
      clearInterval(uiUpdateInterval);

      actionQueue.add(async () => {
        try { if (speakerMember.voice.channelId) await speakerMember.voice.setMute(true); } catch (e) {}
      }, `mute-${currentSpeaker!.userId}`);
      await actionQueue.waitForEmpty();
      
      if (!votedTargetId) {
          if (pChannelMsg) await pChannelMsg.delete().catch(()=>{});
          const candidates = alivePlayers.filter((p: Player) => p.userId !== currentSpeaker!.userId);
          votedTargetId = candidates[Math.floor(Math.random() * candidates.length)].userId;
          randomVoterIds.push(currentSpeaker!.userId);
          const targetName = (await guild.members.fetch(votedTargetId)).displayName;
          await this.sendToPersonalChannel(guild, currentSpeaker!.userId, MSG.CHAT.DM_TIMEOUT_VOTE(targetName));
      }
      
      const newVotes = { ...stateManager.getState().currentVotes, [currentSpeaker!.userId]: votedTargetId };
      stateManager.updateState({ currentVotes: newVotes });

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
      const voterM = await guild.members.fetch(vId).catch(() => null);
      const suffix = randomVoterIds.includes(vId) ? ' (ランダム)' : '';
      finalCounts[tId].push(`${voterM?.displayName || '不明'}${suffix}`);
    }
    for (const [tId, voters] of Object.entries(finalCounts)) {
      const targetM = await guild.members.fetch(tId).catch(() => null);
      finalUiText += MSG.CHAT.VOTE_UI_VOTE_ITEM(targetM?.displayName || '不明', voters.length, voters.join(', '));
    }
    await statusMsg.edit(finalUiText).catch(() => {});

    const mainVcChannel = await guild.channels.fetch(state.mainVcId).catch(()=>null) as VoiceBasedChannel;
    if (mainVcChannel) {
      const finalGmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      await new Promise(r => setTimeout(r, 1000));
      const endAudio = await TTSService.generateAudio(MSG.VOICE.VOTE_END, gameId, `vote_end_${state.day}`);
      await VoiceService.playAudio(finalGmConn, endAudio, gameId);
      await new Promise(r => setTimeout(r, 4000)); 
    }

    const counts: Record<string, number> = {};
    Object.values(finalVotes).forEach(id => counts[id] = (counts[id] || 0) + 1);
    const maxVotes = Math.max(...Object.values(counts), 0);
    const executionTargets = Object.keys(counts).filter(id => counts[id] === maxVotes);

    if (executionTargets.length > 1) {
        stateManager.nextPhase('runoff_voting');
        await this.handleRunoffVotingPhase(gmClient, assistantClient as Client, gameId, executionTargets);
    } else {
        stateManager.nextPhase('execution');
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
    const settings = state.settingsSnapshot;

    const defenseMs = settings.runoffDefenseMin * 60000;
    const voteTimeoutMs = settings.runoffVoteTimeoutMin * 60000;

    let gmConn: any;
    if (mainVcChannel) gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');

    if (gmConn) {
        const startAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_START, gameId, `runoff_start_${state.day}`);
        await VoiceService.playAudio(gmConn, startAudio, gameId);
    }

    await voteChannel.send(MSG.CHAT.SYS_RUNOFF_START);

    const shuffledTargets = this.shuffleArray(tiedUserIds);
    const alivePlayers = state.players.filter((p: Player) => p.isAlive);

    for (const p of alivePlayers) {
        actionQueue.add(async () => {
            try { const m = await guild.members.fetch(p.userId); if (m.voice.channelId) await m.voice.setMute(true); } catch(e){}
        }, `mute-all-runoff-${p.userId}`);
    }
    await actionQueue.waitForEmpty();

    const defTimeStr = defenseMs >= 60000 ? `${settings.runoffDefenseMin}分間` : `${Math.round(defenseMs / 1000)}秒間`;

    for (const targetId of shuffledTargets) {
        const targetMember = await guild.members.fetch(targetId).catch(()=>null);
        if (!targetMember) continue;

        actionQueue.add(async () => {
            try { if (targetMember.voice.channelId) await targetMember.voice.setMute(false); } catch(e){}
        }, `unmute-runoff-${targetId}`);
        await actionQueue.waitForEmpty();

        if (gmConn) {
            const defenseStartAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_DEFENSE_START(targetMember.displayName, defTimeStr), gameId, `runoff_def_start_${targetId}`);
            await VoiceService.playAudio(gmConn, defenseStartAudio, gameId);
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

        await this.waitWithPauseAndCondition(defenseMs);
        clearInterval(uiUpdateInterval);
        await defMsg.edit(MSG.CHAT.RUNOFF_DEFENSE_UPDATE(targetMember.displayName, `**【終了済】**`)).catch(()=>{});

        if (gmConn) {
            const defenseEndAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_DEFENSE_END, gameId, `runoff_def_end_${targetId}`);
            await VoiceService.playAudio(gmConn, defenseEndAudio, gameId);
        }

        actionQueue.add(async () => {
            try { if (targetMember.voice.channelId) await targetMember.voice.setMute(true); } catch(e){}
        }, `mute-runoff-${targetId}`);
        await actionQueue.waitForEmpty();
    }

    // 🚨 修正：投票制限時間のアナウンス強化
    const voteTimeStr = voteTimeoutMs >= 60000 ? `${settings.runoffVoteTimeoutMin}分` : `${Math.round(voteTimeoutMs / 1000)}秒`;
    if (gmConn) {
        const votePromptAudio = await TTSService.generateAudio(MSG.VOICE.RUNOFF_VOTE_PROMPT(voteTimeStr), gameId, `runoff_prompt_${state.day}`);
        await VoiceService.playAudio(gmConn, votePromptAudio, gameId);
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
            const randomTarget = tiedUserIds[Math.floor(Math.random() * tiedUserIds.length)];
            runoffVotes[voter.userId] = randomTarget;
            randomRunoffVoterIds.push(voter.userId);
            const selectedName = (await guild.members.fetch(randomTarget)).displayName;
            await this.sendToPersonalChannel(guild, voter.userId, MSG.CHAT.DM_TIMEOUT_VOTE(selectedName));
        }
    });

    await Promise.all(votePromises);

    // 🚨 修正：決選投票の開票結果をテキスト開示
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
    const executedUserId = finalExecutionTargets[Math.floor(Math.random() * finalExecutionTargets.length)];

    stateManager.nextPhase('execution');
    await this.handleExecutionPhase(gmClient, assistantClient, gameId, executedUserId);
  }

  public static async handleExecutionPhase(gmClient: Client, assistantClient: Client, gameId: string, executedUserId: string): Promise<void> {
    Logger.info('PhaseHandler', `⚖️ 処刑フェーズを開始します。`, gameId);
    
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    const settings = state.settingsSnapshot;
    const sysTimeMs = this.getSysTimeMs(settings);

    const executedMember = await guild.members.fetch(executedUserId).catch(() => null);
    const executedName = executedMember?.displayName || '不明なプレイヤー';
    
    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;

    if (mainVcChannel && ghostVc) {
      const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      await new Promise(r => setTimeout(r, 1000));
      const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
      
      const executionAudio = await TTSService.generateAudio(MSG.VOICE.EXEC_START(executedName), gameId, `exec_${executedUserId}`);
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
    await lwMsg.edit(MSG.CHAT.EXEC_LAST_WORD_END(executedName)).catch(()=>{});

    const updatedPlayers = state.players.map((p: Player) => p.userId === executedUserId ? { ...p, isAlive: false } : p);
    state.eventLogs.push(`[第${state.day}日 昼] ${executedName} が処刑された`);
    stateManager.updateState({ players: updatedPlayers, eventLogs: state.eventLogs });

    if (mainVcChannel && ghostVc) {
      const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      const introAudio = await TTSService.generateAudio(MSG.VOICE.NIGHT_INTRO(executedName), gameId, `night_intro_${state.day}`);
      await VoiceService.playAudio(gmConnection, introAudio, gameId);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const winningTeam = this.checkWinCondition(stateManager.getState());
    if (winningTeam) {
      stateManager.nextPhase('finished');
      await this.finishGame(gmClient, assistantClient, gameId, winningTeam, 'execution');
    } else {
      stateManager.nextPhase('night');
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

    await this.syncLedgerAndMove(guild, gameId, 'night');
    stateManager.updateState({ nightActions: {} });

    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    const aliveWolves = alivePlayers.filter((p: Player) => p.role === '人狼');
    const wolfTargets = alivePlayers.filter((p: Player) => p.role !== '人狼');

    for (const wolf of aliveWolves) {
      actionQueue.add(async () => {
        try { 
          const m = await guild.members.fetch(wolf.userId);
          if (m.voice.channelId) await m.voice.setMute(false); 
        } catch (e) {}
      }, `unmute-wolf-${wolf.userId}`);
    }
    await actionQueue.waitForEmpty();

    const playerIds = state.players.map((p: Player) => p.userId);
    const freeWorkers = await WorkerManager.getInstance().getFreeWorkers(state.serverId, playerIds, 4);
    
    const getWorker = (index: number) => freeWorkers.length > 0 ? freeWorkers[index % freeWorkers.length] : assistantClient;
    
    const workerLocks = new Map<string, Promise<void>>();

    const playVoiceTask = (worker: Client, channel: VoiceBasedChannel, text: string, id: string) => {
      const workerId = worker.user!.id;
      const prevTask = workerLocks.get(workerId) || Promise.resolve();
      const nextTask = prevTask.then(async () => {
        try {
          const conn = await VoiceService.connectWithClient(worker, channel, gameId, id);
          await new Promise(r => setTimeout(r, 1000)); 
          const audio = await TTSService.generateAudio(text, gameId, id);
          await VoiceService.playAudio(conn, audio, gameId);
        } catch (e) {}
      });
      workerLocks.set(workerId, nextTask);
    };
    
    const medium = alivePlayers.find((p: Player) => p.role === '霊媒師');
    const executedPlayer = stateManager.getState().players.find(p => !p.isAlive && Object.values(state.currentVotes).includes(p.userId));
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
      playVoiceTask(getWorker(1), wolfVc, MSG.VOICE.PROMPT_WOLF, 'wolf_prompt');
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


    const wolfVotePromises = aliveWolves.map(async (wolf: Player) => {
      try {
        const selectMenu = new StringSelectMenuBuilder().setCustomId('w').setPlaceholder('襲撃先を選択');
        for (const target of wolfTargets) {
          const targetM = await guild.members.fetch(target.userId).catch(() => null);
          if (targetM) selectMenu.addOptions({ label: targetM.displayName, value: target.userId });
        }
        const pMsg = await this.sendToPersonalChannel(guild, wolf.userId, { 
          content: MSG.CHAT.DM_WOLF_PROMPT, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] 
        });
        
        if (!pMsg) return;
        const compCollector = pMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect });

        compCollector.on('collect', async (i: StringSelectMenuInteraction) => {
          if (i.user.id !== wolf.userId) return;
          const targetId = i.values[0];
          const targetName = (await guild.members.fetch(targetId)).displayName;
          
          await i.deferUpdate();
          await pMsg.delete().catch(()=>{});
          await this.sendToPersonalChannel(guild, wolf.userId, MSG.CHAT.DM_WOLF_TARGET_SET(targetName));
          
          if (!stateManager.getState().nightActions.wolfTargetId) {
            stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, wolfTargetId: targetId } });
            if (wolfVc) playVoiceTask(getWorker(1), wolfVc, MSG.VOICE.WOLF_TARGET_SET(targetName), 'wolf_res');
          }
          compCollector.stop();
        });

        await this.waitWithPauseAndCondition(settings.actionTimeoutMin * 60000 + nightBonusMs, () => false);
        if (pMsg) await pMsg.delete().catch(()=>{});
      } catch (e) {}
    });

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
          targetId = targets[Math.floor(Math.random() * targets.length)].userId;
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
          targetId = targets[Math.floor(Math.random() * targets.length)].userId;
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, knightTargetId: targetId }, lastGuardedUserId: targetId });
          targetName = (await guild.members.fetch(targetId)).displayName;
          await this.sendToPersonalChannel(guild, knight.userId, MSG.CHAT.DM_TIMEOUT_KNIGHT(targetName));
        }

        const knightVc = await guild.channels.fetch(knight.waitVcId) as VoiceBasedChannel;
        if (knightVc) playVoiceTask(getWorker(3), knightVc, MSG.VOICE.KNIGHT_TARGET_SET(targetName), 'knight_res');

      } catch (e) {}
    })();

    await Promise.all([...wolfVotePromises, seerPromise, knightPromise]);

    clearInterval(nightTimerInterval);
    await nightTimerMsg.edit(MSG.CHAT.NIGHT_WOLF_TIMER_UPDATE(`**【終了済】**`, '░'.repeat(20), 0, '00')).catch(()=>{});
    
    await Promise.all(workerLocks.values());

    for (const worker of freeWorkers) {
      try {
        const wGuild = await worker.guilds.fetch(state.serverId).catch(()=>null);
        wGuild?.members.me?.voice.disconnect();
      } catch(e) {}
    }

    if (aliveWolves.length > 0 && !stateManager.getState().nightActions.wolfTargetId) {
        const randomTarget = wolfTargets[Math.floor(Math.random() * wolfTargets.length)].userId;
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

    const finalWolfTargetId = stateManager.getState().nightActions.wolfTargetId;
    let killedUserId: string | null = null;
    
    if (finalWolfTargetId && finalWolfTargetId !== stateManager.getState().nightActions.knightTargetId) {
      killedUserId = finalWolfTargetId;
      const killedName = (await guild.members.fetch(killedUserId)).displayName;
      const updatedPlayers = stateManager.getState().players.map((p: Player) => p.userId === killedUserId ? { ...p, isAlive: false } : p);
      
      state.eventLogs.push(`[第${state.day}日 夜] ${killedName} が人狼に襲撃された`);
      stateManager.updateState({ players: updatedPlayers, eventLogs: state.eventLogs });
    }

    stateManager.updateState({ day: state.day + 1 });
    const winningTeam = this.checkWinCondition(stateManager.getState());

    if (winningTeam) {
      stateManager.nextPhase('finished');
      const morningText = killedUserId 
        ? MSG.VOICE.MORNING_KILLED((await guild.members.fetch(killedUserId)).displayName)
        : MSG.VOICE.MORNING_PEACE;
      await this.finishGame(gmClient, assistantClient, gameId, winningTeam, 'bite', morningText);
    } else {
      const postNightExpected: Record<string, string> = {};
      for (const player of stateManager.getState().players) {
          postNightExpected[player.userId] = player.isAlive ? player.waitVcId : state.ghostVcId;
      }
      stateManager.updateState({ expectedVcIds: postNightExpected });
      await this.syncLedgerAndMove(guild, gameId, 'night');
      
      await new Promise(resolve => setTimeout(resolve, 2000));

      const morningText = killedUserId 
        ? MSG.VOICE.MORNING_KILLED((await guild.members.fetch(killedUserId)).displayName)
        : MSG.VOICE.MORNING_PEACE;
      
      if (killedUserId) {
        try { 
          const m = await guild.members.fetch(killedUserId);
          if (m.voice.channelId) await m.voice.setMute(false); 
        } catch (e) {}
      }
      
      if (mainVcChannel && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        await new Promise(r => setTimeout(r, 1000));
        const morningAudio = await TTSService.generateAudio(morningText, gameId, `morning_${state.day}`);
        await VoiceService.playAudio(gmConnection, morningAudio, gameId);
      }
      
      const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
      await voteChannel.send(MSG.CHAT.MORNING_ANNOUNCE(stateManager.getState().day, morningText));

      await this.syncLedgerAndMove(guild, gameId, 'day');
      
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
      const name = (await guild.members.fetch(p.userId)).displayName;
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

      if (reason === 'execution') {
          const text = winningTeam === '村人陣営' ? MSG.VOICE.WIN_EXECUTION_VILLAGER : MSG.VOICE.WIN_EXECUTION_WOLF;
          const winAudio = await TTSService.generateAudio(text, gameId, 'win_exec');
          await VoiceService.broadcastAudio(broadcastConns, winAudio, gameId);
      } else if (reason === 'bite') {
          if (morningText) {
              const morningAudio = await TTSService.generateAudio(morningText, gameId, 'morning_kill');
              await VoiceService.broadcastAudio(broadcastConns, morningAudio, gameId);
          }
          const winAudio = await TTSService.generateAudio(MSG.VOICE.WIN_BITE_WOLF, gameId, 'win_bite');
          await VoiceService.broadcastAudio(broadcastConns, winAudio, gameId);
      }
      
      await voteChannel.send(resultText);

      const nextAudio = await TTSService.generateAudio(MSG.VOICE.MVP_NEXT, gameId, 'win_announce_next');
      await VoiceService.broadcastAudio(broadcastConns, nextAudio, gameId);
      await voteChannel.send(MSG.CHAT.MVP_ANALYZING);
      
      try {
        const playerNameMap: Record<string, string> = {};
        for (const p of state.players) playerNameMap[p.userId] = (await guild.members.fetch(p.userId)).displayName;

        const mvpData = await AIService.analyzeMVP(gameId, state.speechLogs, playerNameMap, state.eventLogs);
        
        const chunks = this.splitMessage(MSG.CHAT.MVP_RESULT(mvpData.mvpName, mvpData.text));
        for (const chunk of chunks) await voteChannel.send(chunk);
        
        const mvpAudio = await TTSService.generateAudio(MSG.VOICE.MVP_ANNOUNCE(mvpData.mvpName), gameId, 'mvp_announce');
        await VoiceService.broadcastAudio(broadcastConns, mvpAudio, gameId);
      } catch (error) {
        await voteChannel.send(MSG.CHAT.MVP_ERROR(gameId));
      }
    }

    await new Promise(resolve => setTimeout(resolve, sysTimeMs.CLEANUP_DELAY));
    
    const workers = WorkerManager.getInstance().getWorkers();
    await Promise.all(workers.map(async (worker, index) => {
      try {
        const wGuild = await worker.guilds.fetch(state.serverId).catch(()=>null);
        if (wGuild && wGuild.members.me) {
          const isMyStaff = worker.user?.id === state.relayWorkerId || worker.user?.id === state.recorderWorkerId;
          if (isMyStaff) {
            const num = String(index + 1).padStart(2, '0');
            await wGuild.members.me.setNickname(`人狼ゲームスタッフ${num}`).catch(()=>{});
          }
        }
      } catch(e) {}
    }));    
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
    const guild = await gmClient.guilds.fetch(state.serverId);
    
    VoiceService.disconnectAll(gameId);
    
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    if (voteChannel) await voteChannel.send(MSG.CHAT.SYS_RECOVER(state.phase));

    switch (state.phase) {
      case 'setup': await this.startRoleDistribution(gmClient, assistantClient, gameId); break;
      case 'day_discussion': await this.startDayDiscussion(gmClient, assistantClient, gameId); break;
      case 'voting': await this.startVotingPhase(gmClient, assistantClient, gameId); break;
      case 'execution': 
        await this.startNightPhase(gmClient, assistantClient, gameId); 
        break;
      case 'night': await this.startNightPhase(gmClient, assistantClient, gameId); break;
    }
  }
}
/**
 * src/handlers/PhaseHandler.ts
 * スナップショット対応 ＆ 完全統合版
 */
import { Client, TextChannel, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, Guild, VoiceBasedChannel } from 'discord.js';
import { StateManager } from '../state/StateManager';
import { ActionQueue } from '../state/ActionQueue';
import { TTSService } from '../services/TTSService';
import { VoiceService } from '../services/VoiceService';
import { DiscordService } from '../services/DiscordService';
import { WorkerManager } from '../managers/WorkerManager';
import { VCWatcher } from '../managers/VCWatcher';
import { AIService } from '../services/AIService';
import { GAME_CONSTANTS } from '../constants';
import { Player, GameState } from '../types';
import { Logger } from '../utils/logger';

export class PhaseHandler {
  private static getSysTimeMs(isDebug: boolean) {
    return {
      NO_HAND_RAISE: isDebug ? 5000 : 15000,
      HAND_RAISE_POLLING: 1000,
      LAST_WORD: isDebug ? 5000 : 30000,
      CLEANUP_DELAY: 5000
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

  private static async logBotPosition(gmClient: Client, assistantClient: Client, guild: Guild, gameId: string) {
    const state = StateManager.getInstance().getState();
    if (!state.isDebug) return;
    try {
      const gmMember = await guild.members.fetch(gmClient.user!.id).catch(()=>null);
      const astMember = await guild.members.fetch(assistantClient.user!.id).catch(()=>null);
      const gmPos = gmMember?.voice.channel ? gmMember.voice.channel.name : '未接続';
      const astPos = astMember?.voice.channel ? astMember.voice.channel.name : '未接続';
      Logger.info('Debug', `[現在地報告] GM: ${gmPos} / アシスタント: ${astPos}`, gameId);
    } catch (e) {}
  }

  private static async returnToHomePositions(gmClient: Client, assistantClient: Client, gameId: string) {
    const state = StateManager.getInstance().getState();
    const gmGuild = await gmClient.guilds.fetch(state.serverId).catch(()=>null);
    const astGuild = await assistantClient.guilds.fetch(state.serverId).catch(()=>null);
    if (!gmGuild || !astGuild) return;

    const mainVc = await gmGuild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const ghostVc = await astGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;

    if (mainVc) {
        if (state.isDebug) Logger.info('Debug', `[移動] GMがホーム(全体議論VC)へ帰還します。`, gameId);
        await VoiceService.connectWithClient(gmClient, mainVc, gameId, 'main');
    }
    if (ghostVc) {
        if (state.isDebug) Logger.info('Debug', `[移動] アシスタントがホーム(霊界VC)へ帰還します。`, gameId);
        await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
    }
    await this.logBotPosition(gmClient, assistantClient, gmGuild, gameId);
  }

  private static async syncLedgerAndMove(guild: Guild, gameId: string, phaseType: 'setup' | 'day' | 'night' | 'lobby' | 'finish') {
    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();
    const expected: Record<string, string> = {};

    for (const player of state.players) {
      if (!player.isAlive) {
        expected[player.userId] = phaseType === 'lobby' ? state.originalVcId : (phaseType === 'finish' ? state.mainVcId : state.ghostVcId);
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

    // 🚨 修正: SettingsManagerからではなく、開始時に記録したスナップショットを参照
    const settings = state.settingsSnapshot;
    const wolfMeetingMs = settings.wolfMeetingMin * 60 * 1000;

    const originalVc = await guild.channels.fetch(state.originalVcId) as VoiceBasedChannel;
    if (originalVc && originalVc.isVoiceBased()) {
      const connection = await VoiceService.connectWithClient(gmClient, originalVc, gameId, 'lobby');
      const greetingText = '人狼ゲームを開始します。これより皆様を、各自の隔離部屋へ強制移動し、役職を配布いたします。';
      const greetingAudio = await TTSService.generateAudio(greetingText, gameId, 'greeting');
      await VoiceService.playAudio(connection, greetingAudio, gameId);
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
      ...player, role: shuffledRoles[index],
    }));
    stateManager.updateState({ players: updatedPlayers, day: 1 });

    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    await voteChannel.send('🎲 役職の配布を開始します。皆様にダイレクトメッセージ（DM）を送信しています...');

    const seer = updatedPlayers.find((p: Player) => p.role === '占い師');
    const safeTargets = updatedPlayers.filter((p: Player) => p.role !== '人狼' && p.role !== '占い師');
    const firstWhiteTarget = seer ? this.shuffleArray(safeTargets)[0] : null;

    for (const player of updatedPlayers) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(player.userId).catch(() => null);
          if (!member) return;

          let message = `🐺 **【人狼ゲーム進行】**\nあなたの役職は **「${player.role}」** です。\n`;
          if (player.role === '人狼') message += '他の人狼と合流するため、内通ボイスチャンネルへ移動します。作戦会議を行ってください。';
          else if (player.role === '占い師' && firstWhiteTarget) {
            const targetMember = await guild.members.fetch(firstWhiteTarget.userId).catch(() => null);
            message += `【初日のお告げ】\n**${targetMember?.displayName || '不明なプレイヤー'}** さんは「人狼ではありません（白）」でした。`;
          }
          await member.send(message);
        } catch (error) { Logger.warn('PhaseHandler', `DM送信スキップ: ${player.userId}`, gameId); }
      }, `distribute-role-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    await this.syncLedgerAndMove(guild, gameId, 'night');

    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const wolfVc = await assistantGuild.channels.fetch(state.wolfVcId) as VoiceBasedChannel;
    if (wolfVc) {
        const astConn = await VoiceService.connectWithClient(assistantClient, wolfVc, gameId, 'ghost_wolf');
        const meetText = `人狼の皆様、これより初日の作戦会議を開始します。時間は${settings.wolfMeetingMin}分間です。顔合わせと方針の相談を行ってください。`;
        if (state.isDebug) Logger.info('Debug', `[発話] アシスタント(初日内通): ${meetText}`, gameId);
        const audio = await TTSService.generateAudio(meetText, gameId, 'first_wolf_meet');
        await VoiceService.playAudio(astConn, audio, gameId);
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

    Logger.info('PhaseHandler', `⏳ 初日作戦会議...`, gameId);
    await new Promise(resolve => setTimeout(resolve, wolfMeetingMs));

    for (const wolf of aliveWolves) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(wolf.userId);
          if (member.voice.channelId) await member.voice.setMute(true);
        } catch (e) {}
      }, `mute-first-wolf-${wolf.userId}`);
    }
    await actionQueue.waitForEmpty();
    await new Promise(resolve => setTimeout(resolve, 1500)); 

    stateManager.nextPhase('day_discussion');
    await this.startDayDiscussion(gmClient, assistantClient, gameId);
  }

  public static async startDayDiscussion(gmClient: Client, assistantClient: Client, gameId: string): Promise<void> {
    Logger.info('PhaseHandler', `☀️ 昼議論フェーズを開始します...`, gameId);
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const workers = WorkerManager.getInstance().getWorkers();
    
    // 🚨 スナップショットから設定を取得
    const settings = state.settingsSnapshot;

    await this.returnToHomePositions(gmClient, assistantClient, gameId);
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
        VoiceService.startRecording(gmConnection, gameId);
        const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
        VoiceService.setupRelay(gmConnection, assistantConnection, gameId);
        
        const broadcastConns = [gmConnection, assistantConnection];

        let dayTimeMinutes = state.day === 1 
            ? settings.day1DiscussionMin 
            : Math.max(settings.day2DiscussionMin - (state.day - 2) * settings.dayDecreaseMin, state.isDebug ? 0.166 : 1);
            
        let announceText = `朝になりました。本日の議論時間は${dayTimeMinutes}分間です。それでは、議論を開始してください。`;

        if (state.isResumedBonus) {
            dayTimeMinutes += 1;
            announceText = `中断からの再開となります。お詫びとして、本日の議論時間を1分追加し、${dayTimeMinutes}分間とします。それでは、議論を再開してください。`;
            state.isResumedBonus = false; 
            stateManager.updateState(state);
        }
        
        if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${announceText}`, gameId);
        const audioPath = await TTSService.generateAudio(announceText, gameId, `day_start_${state.day}`);
        await VoiceService.broadcastAudio(broadcastConns, audioPath, gameId);

        let totalDiscussionMs = dayTimeMinutes * 60 * 1000;
        let remainAnnounced = false;

        const chatterPhrases = [
          "私は村人陣営です。皆さんよろしくお願いします。",
          "昨日の夜の動きで、何か気になったことはありますか？",
          "とりあえず、役職持ちの方は早めにカミングアウトした方が進行しやすいと思います。",
          "私の推理では、あの人が人狼の可能性が高い気がしています。",
          "とりあえず様子見で、今日は情報収集に徹しませんか？"
        ];

        const aliveWorkerPlayers = alivePlayers.filter((p: Player) => workers.some(w => w.user?.id === p.userId));

        for (let i = 0; i < totalDiscussionMs; i += 10000) {
          await new Promise(r => setTimeout(r, 10000));

          if (dayTimeMinutes > 1 && !remainAnnounced && (totalDiscussionMs - i) <= 60000) {
              remainAnnounced = true;
              const remainText = "議論時間は残り1分です。投票の準備をお願いします。";
              if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${remainText}`, gameId);
              const remainAudio = await TTSService.generateAudio(remainText, gameId, `day_remain_${state.day}`);
              await VoiceService.broadcastAudio(broadcastConns, remainAudio, gameId);
          }

          if (state.isDebug && aliveWorkerPlayers.length > 0) {
              const speaker = aliveWorkerPlayers[Math.floor(Math.random() * aliveWorkerPlayers.length)];
              const workerClient = workers.find(w => w.user?.id === speaker.userId);
              const phrase = chatterPhrases[Math.floor(Math.random() * chatterPhrases.length)];

              if (workerClient) {
                  Logger.info('PhaseHandler', `🗣️ [発話] バイト(${workerClient.user?.tag}) が全体議論VCで発言: "${phrase}"`, gameId);
                  try {
                    const conn = await VoiceService.connectWithClient(workerClient, mainVc, gameId, 'main');
                    const audio = await TTSService.generateAudio(phrase, gameId, `chatter_${speaker.userId}`);
                    await VoiceService.playAudio(conn, audio, gameId);
                  } catch (e) {
                    Logger.warn('PhaseHandler', `テスト発話エラー: ${workerClient.user?.tag}`, gameId);
                  }
              }
          }
        }

        const endText = "議論時間が終了しました。これより投票フェーズに移行します。";
        if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${endText}`, gameId);
        const endAudio = await TTSService.generateAudio(endText, gameId, `day_end_${state.day}`);
        await VoiceService.broadcastAudio(broadcastConns, endAudio, gameId);

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
    } catch (error) {}
  }

  public static async startVotingPhase(gmClient: Client, assistantClient: Client, gameId: string): Promise<void> {
    Logger.info('PhaseHandler', `🗳️ 投票フェーズを開始します。`, gameId);
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    
    const sysTimeMs = this.getSysTimeMs(state.isDebug);
    
    // 🚨 スナップショットから設定を取得
    const settings = state.settingsSnapshot;
    const speechSec = state.isDebug ? 10 : 30; 
    const voteSec = Math.round(settings.actionTimeoutMin * 60);

    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    let unvotedPlayers = [...alivePlayers];
    stateManager.updateState({ currentVotes: {} });

    await voteChannel.send(`🗳️ **【第${state.day}日 投票フェーズ】**\nこれより1人ずつ発言と投票を行います。\n発言希望者は ✋ スタンプを付けてください。`);
    const handRaiseMsg = await voteChannel.send("待機中... (✋を押してください)");
    await handRaiseMsg.react('✋');

    while (unvotedPlayers.length > 0) {
      let nextSpeakerId: string | null = null;
      const reactions = handRaiseMsg.reactions.cache.get('✋');
      if (reactions) {
        const users = await reactions.users.fetch();
        const raisedUser = users.find(u => !u.bot && unvotedPlayers.some((p: Player) => p.userId === u.id));
        if (raisedUser) nextSpeakerId = raisedUser.id;
      }

      if (!nextSpeakerId) {
        let waitedTime = 0;
        while (waitedTime < sysTimeMs.NO_HAND_RAISE && !nextSpeakerId) {
          await new Promise(resolve => setTimeout(resolve, sysTimeMs.HAND_RAISE_POLLING));
          waitedTime += sysTimeMs.HAND_RAISE_POLLING;
          const currentReactions = handRaiseMsg.reactions.cache.get('✋');
          if (currentReactions) {
            const currentUsers = await currentReactions.users.fetch();
            const currentRaisedUser = currentUsers.find(u => !u.bot && unvotedPlayers.some((p: Player) => p.userId === u.id));
            if (currentRaisedUser) nextSpeakerId = currentRaisedUser.id;
          }
        }
        if (!nextSpeakerId) nextSpeakerId = unvotedPlayers[Math.floor(Math.random() * unvotedPlayers.length)].userId;
      }

      const speaker = unvotedPlayers.find((p: Player) => p.userId === nextSpeakerId)!;
      const speakerMember = await guild.members.fetch(speaker.userId).catch(()=>null);
      if (!speakerMember) continue;

      const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
      const ghostVcChannel = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
      
      let gmConn: any, astConn: any;
      if (mainVcChannel && ghostVcChannel) {
        gmConn = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        astConn = await VoiceService.connectWithClient(assistantClient, ghostVcChannel, gameId, 'ghost');
        
        const promptText1 = `${speakerMember.displayName}さんの発言時間です。制限時間は${speechSec}秒です。`;
        if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${promptText1}`, gameId);
        const speakerAudio = await TTSService.generateAudio(promptText1, gameId, `vote_start_${speaker.userId}`);
        await VoiceService.broadcastAudio([gmConn, astConn], speakerAudio, gameId);
      }

      actionQueue.add(async () => {
        try {
          if (speakerMember.voice.channelId) await speakerMember.voice.setMute(false);
        } catch (e) {}
      }, `unmute-${speaker.userId}`);
      await actionQueue.waitForEmpty();

      const selectMenu = new StringSelectMenuBuilder().setCustomId('vote_select').setPlaceholder('処刑するプレイヤーを選択');
      
      const targetPromises = alivePlayers.filter((p: Player) => p.userId !== speaker.userId).map(async (target: Player) => {
        const targetMember = await guild.members.fetch(target.userId).catch(()=>null);
        if (targetMember) {
          selectMenu.addOptions({ label: targetMember.displayName, value: target.userId });
        }
      });
      await Promise.all(targetPromises);

      let votedTargetId: string | null = null;
      
      const dmPromise = speakerMember.send({ content: '【投票】処刑対象を選択してください', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] })
        .then(dmMsg => {
           return dmMsg.awaitMessageComponent({ 
               filter: i => i.customId === 'vote_select' && i.user.id === speaker.userId, 
               componentType: ComponentType.StringSelect, 
               time: (speechSec + voteSec) * 1000 
           });
        })
        .then(async interaction => {
           await interaction.deferUpdate();
           votedTargetId = interaction.values[0];
           await interaction.editReply({ content: `✅ 投票を受け付けました。`, components: [] });
           return 'VOTED';
        })
        .catch(() => 'TIMEOUT');

      await new Promise(r => setTimeout(r, speechSec * 1000));

      actionQueue.add(async () => {
        try {
          if (speakerMember.voice.channelId) await speakerMember.voice.setMute(true);
        } catch (e) {}
      }, `mute-${speaker.userId}`);
      await actionQueue.waitForEmpty();

      if (gmConn && astConn) {
        const promptText2 = `時間です。${voteSec}秒以内にDMから投票を完了してください。タイムアウトした場合はランダムに選択されます。`;
        if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${promptText2}`, gameId);
        const voteGuideAudio = await TTSService.generateAudio(promptText2, gameId, `vote_guide_${speaker.userId}`);
        await VoiceService.broadcastAudio([gmConn, astConn], voteGuideAudio, gameId);
      }

      if (!votedTargetId) {
          await Promise.race([
              dmPromise,
              new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), voteSec * 1000))
          ]);
      }
      
      if (votedTargetId) {
          stateManager.updateState({ currentVotes: { ...stateManager.getState().currentVotes, [speaker.userId]: votedTargetId } });
      } else {
          const candidates = alivePlayers.filter((p: Player) => p.userId !== speaker.userId);
          const randomTargetId = candidates[Math.floor(Math.random() * candidates.length)].userId;
          stateManager.updateState({ currentVotes: { ...stateManager.getState().currentVotes, [speaker.userId]: randomTargetId } });
      }

      unvotedPlayers = unvotedPlayers.filter((p: Player) => p.userId !== speaker.userId);
    }

    stateManager.nextPhase('execution');
    await this.handleExecutionPhase(gmClient, assistantClient, gameId);
  }

  public static async handleExecutionPhase(gmClient: Client, assistantClient: Client, gameId: string): Promise<void> {
    Logger.info('PhaseHandler', `⚖️ 処刑フェーズを開始します。`, gameId);
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    
    const sysTimeMs = this.getSysTimeMs(state.isDebug);
    
    const counts: Record<string, number> = {};
    Object.values(state.currentVotes).forEach(id => counts[id] = (counts[id] || 0) + 1);
    const maxVotes = Math.max(...Object.values(counts), 0);
    let executionTargets = Object.keys(counts).filter(id => counts[id] === maxVotes);

    if (executionTargets.length > 1) {
      await voteChannel.send(`⚠️ 最多得票数が同数となりました。対象者による弁明後、決選投票を行います。`);
      executionTargets = [executionTargets[Math.floor(Math.random() * executionTargets.length)]];
    }

    const executedUserId = executionTargets[0];
    const executedMember = await guild.members.fetch(executedUserId).catch(()=>null);
    const executedName = executedMember?.displayName || '不明なプレイヤー';

    const updatedPlayers = state.players.map((p: Player) => p.userId === executedUserId ? { ...p, isAlive: false } : p);
    stateManager.updateState({ players: updatedPlayers });

    await voteChannel.send(`💀 投票の結果、<@${executedUserId}> さんが処刑されました。\n最後に遺言を残してください。`);
    
    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;

    if (mainVcChannel && ghostVc) {
      const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
      
      const execText = `投票の結果、${executedName}さんが処刑されます。最後に遺言をお願いします。`;
      if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${execText}`, gameId);
      const executionAudio = await TTSService.generateAudio(execText, gameId, `exec_${executedUserId}`);
      await VoiceService.broadcastAudio([gmConnection, assistantConnection], executionAudio, gameId);
    }

    actionQueue.add(async () => {
      try {
        const member = await guild.members.fetch(executedUserId);
        if (member.voice.channelId) await member.voice.setMute(false);
      } catch (e) {}
    }, `unmute-lastword-${executedUserId}`);
    await actionQueue.waitForEmpty();

    await new Promise(resolve => setTimeout(resolve, sysTimeMs.LAST_WORD));

    if (mainVcChannel && ghostVc) {
      const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
      const introAudio = await TTSService.generateAudio(`${executedName}さんが処刑され、夜が・・・`, gameId, `night_intro_${state.day}`);
      await VoiceService.broadcastAudio([gmConnection, assistantConnection], introAudio, gameId);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    const winningTeam = this.checkWinCondition(stateManager.getState());

    if (winningTeam) {
      if (mainVcChannel && ghostVc) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
        const endAudio = await TTSService.generateAudio(`やってきません！${winningTeam}の勝利です！`, gameId, `night_end_win_${state.day}`);
        await VoiceService.broadcastAudio([gmConnection, assistantConnection], endAudio, gameId);
      }
      stateManager.nextPhase('finished');
      await this.finishGame(gmClient, assistantClient, gameId, winningTeam, true);
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

    // 🚨 スナップショットから設定を取得
    const settings = state.settingsSnapshot;
    const actionTimeoutMs = settings.actionTimeoutMin * 60 * 1000;
    
    let nightBonusMs = 0;

    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    if (mainVcChannel) {
      const connection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      
      let nightText = "・・・やってきます。これより皆様を個別待機部屋へ移動します。";
      
      if (state.isResumedBonus) {
          nightText = "・・・やってきます。なお、中断からの再開となりますので、お詫びとして夜の行動時間を1分延長します。これより個別待機部屋へ移動します。";
          nightBonusMs = 60 * 1000; 
          state.isResumedBonus = false;
          stateManager.updateState(state);
      }
      
      if (state.isDebug) Logger.info('Debug', `[発話] GMが全体議論VCで発言: ${nightText}`, gameId);
      const nightAudio = await TTSService.generateAudio(nightText, gameId, `night_arrive_${state.day}`);
      await VoiceService.playAudio(connection, nightAudio, gameId);
    }

    await this.syncLedgerAndMove(guild, gameId, 'night');
    stateManager.updateState({ nightActions: {} });

    const alivePlayers = state.players.filter((p: Player) => p.isAlive);
    const aliveWolves = alivePlayers.filter((p: Player) => p.role === '人狼');
    const wolfTargets = alivePlayers.filter((p: Player) => p.role !== '人狼');

    for (const wolf of aliveWolves) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(wolf.userId);
          if (member.voice.channelId) await member.voice.setMute(false);
        } catch (e) {}
      }, `unmute-wolf-${wolf.userId}`);
    }
    await actionQueue.waitForEmpty();

    const voiceHoppingQueue = ActionQueue.getInstance();

    voiceHoppingQueue.add(async () => {
      const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
      const wolfVc = await assistantGuild.channels.fetch(state.wolfVcId) as VoiceBasedChannel;
      if (wolfVc) {
        const connection = await VoiceService.connectWithClient(assistantClient, wolfVc, gameId, 'ghost_wolf');
        const promptText = '人狼の皆様、作戦会議の時間です。襲撃先が決まりましたら、DMのメニューから選択してください。';
        const audio = await TTSService.generateAudio(promptText, gameId, 'wolf_prompt');
        await VoiceService.playAudio(connection, audio, gameId);
      }
    }, 'assist-wolf');

    const medium = alivePlayers.find((p: Player) => p.role === '霊媒師');
    const executedUserId = state.currentVotes ? (Object.values(state.currentVotes)[0] as string | undefined) : null; 
    
    if (medium && executedUserId) {
      voiceHoppingQueue.add(async () => {
        const mediumVc = await guild.channels.fetch(medium.waitVcId) as VoiceBasedChannel;
        if (mediumVc) {
          const isWolf = stateManager.getState().players.find((p: Player) => p.userId === executedUserId)?.role === '人狼';
          const executedMember = await guild.members.fetch(executedUserId as string).catch(()=>null);
          const executedName = executedMember?.displayName || '不明なプレイヤー';
          
          const connection = await VoiceService.connectWithClient(gmClient, mediumVc, gameId, 'main_medium');
          const resText = `霊媒師の方、本日の霊媒結果をお伝えします。本日処刑された${executedName}さんは、${isWolf ? '人狼でした' : '人狼ではありませんでした'}。`;
          const audio = await TTSService.generateAudio(resText, gameId, 'medium_res');
          await VoiceService.playAudio(connection, audio, gameId);
        }
      }, 'gm-medium');
    }

    const seer = alivePlayers.find((p: Player) => p.role === '占い師');
    if (seer) {
      voiceHoppingQueue.add(async () => {
        if (!stateManager.getState().nightActions.seerTargetId) {
          const seerVc = await guild.channels.fetch(seer.waitVcId) as VoiceBasedChannel;
          if (seerVc) {
            const connection = await VoiceService.connectWithClient(gmClient, seerVc, gameId, 'main_seer');
            const promptText = '占い師の方、今夜占う対象をDMから選択してください。';
            const audio = await TTSService.generateAudio(promptText, gameId, 'seer_prompt');
            await VoiceService.playAudio(connection, audio, gameId);
          }
        }
      }, 'gm-seer');
    }

    const knight = alivePlayers.find((p: Player) => p.role === '騎士');
    if (knight) {
      voiceHoppingQueue.add(async () => {
        if (!stateManager.getState().nightActions.knightTargetId) {
          const knightVc = await guild.channels.fetch(knight.waitVcId) as VoiceBasedChannel;
          if (knightVc) {
            const connection = await VoiceService.connectWithClient(gmClient, knightVc, gameId, 'main_knight');
            const promptText = '騎士の方、今夜護衛する対象をDMから選択してください。';
            const audio = await TTSService.generateAudio(promptText, gameId, 'knight_prompt');
            await VoiceService.playAudio(connection, audio, gameId);
          }
        }
      }, 'gm-knight');
    }

    const wolfVotePromises = aliveWolves.map(async (wolf: Player) => {
      try {
        const wolfMember = await guild.members.fetch(wolf.userId).catch(()=>null);
        if (!wolfMember) return;

        const selectMenu = new StringSelectMenuBuilder().setCustomId('w').setPlaceholder('襲撃先を選択');
        for (const t of wolfTargets) {
          const u = await guild.members.fetch(t.userId).catch(()=>null);
          if(u) selectMenu.addOptions({ label: u.displayName, value: t.userId });
        }
        const msg = await wolfMember.send({ content: '【人狼】襲撃先を選んでください。', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] });
        const res = await msg.awaitMessageComponent({ filter: i => i.customId === 'w' && i.user.id === wolf.userId, componentType: ComponentType.StringSelect, 
          time: actionTimeoutMs + nightBonusMs 
        }).catch(() => null);
        
        if (res) {
          await res.deferUpdate();
          if (!stateManager.getState().nightActions.wolfTargetId) {
            const targetId = res.values[0];
            stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, wolfTargetId: targetId } });
            const targetMember = await guild.members.fetch(targetId).catch(()=>null);
            const targetName = targetMember?.displayName || '不明';
            
            for (const otherWolf of aliveWolves) {
              if (otherWolf.userId !== wolf.userId) {
                try {
                  const otherMember = await guild.members.fetch(otherWolf.userId).catch(()=>null);
                  if (otherMember) await otherMember.send(`🐺 **仲間の人狼（${wolfMember.displayName}）が、襲撃先を「${targetName}」さんに決定しました。**`);
                } catch(e) {}
              }
            }

            await res.editReply({ content: `✅ 襲撃先を「**${targetName}**」さんに確定しました。`, components: [] });
            
            voiceHoppingQueue.add(async () => {
              const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
              const wolfVc = await assistantGuild.channels.fetch(state.wolfVcId) as VoiceBasedChannel;
              if (wolfVc) {
                const connection = await VoiceService.connectWithClient(assistantClient, wolfVc, gameId, 'ghost_wolf');
                const resText = `襲撃先は、${targetName}さんで承りました。`;
                const audio = await TTSService.generateAudio(resText, gameId, 'wolf_res');
                await VoiceService.playAudio(connection, audio, gameId);
              }
            }, 'assist-wolf-res');
          } else {
            await res.editReply({ content: `⚠️ 既に他の方が決定しました。`, components: [] });
          }
        }
      } catch(e) {}
    });

    const seerPromise = (async () => {
      if (!seer) return;
      try {
        const seerMember = await guild.members.fetch(seer.userId).catch(()=>null);
        if (!seerMember) return;

        const targets = alivePlayers.filter((p: Player) => p.userId !== seer.userId);
        const sel = new StringSelectMenuBuilder().setCustomId('s').setPlaceholder('占う対象を選択');
        for(const t of targets) {
          const u = await guild.members.fetch(t.userId).catch(()=>null);
          if(u) sel.addOptions({label:u.displayName, value:t.userId});
        }
        const msg = await seerMember.send({ content: '【占い師】今夜占う対象を選んでください。', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)] });
        const res = await msg.awaitMessageComponent({ filter: i => i.customId === 's' && i.user.id === seer.userId, componentType: ComponentType.StringSelect, 
          time: actionTimeoutMs + nightBonusMs 
        }).catch(() => null);
        
        if (res) {
          await res.deferUpdate();
          const tId = res.values[0];
          const tP = state.players.find((p: Player) => p.userId === tId)!;
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, seerTargetId: tId } });
          const targetMember = await guild.members.fetch(tId).catch(()=>null);
          const targetName = targetMember?.displayName || '不明';
          
          await res.editReply({ content: `✅ 今夜は「**${targetName}**」さんを占います。占い結果をお伝えします。`, components: [] });

          voiceHoppingQueue.add(async () => {
            const seerVc = await guild.channels.fetch(seer.waitVcId) as VoiceBasedChannel;
            if (seerVc) {
              const connection = await VoiceService.connectWithClient(gmClient, seerVc, gameId, 'main_seer');
              const resText = `占い先は${targetName}さんで承りました。結果は、${tP.role === '人狼' ? '人狼でした' : '人狼ではありませんでした'}。`;
              const audio = await TTSService.generateAudio(resText, gameId, 'seer_res');
              await VoiceService.playAudio(connection, audio, gameId);
            }
          }, 'gm-seer-res');
        }
      } catch(e) {}
    })();

    const knightPromise = (async () => {
      if (!knight) return;
      try {
        const knightMember = await guild.members.fetch(knight.userId).catch(()=>null);
        if (!knightMember) return;

        const targets = alivePlayers.filter((p: Player) => p.userId !== knight.userId && p.userId !== state.lastGuardedUserId);
        const sel = new StringSelectMenuBuilder().setCustomId('k').setPlaceholder('護衛対象を選択');
        for(const t of targets) {
          const u = await guild.members.fetch(t.userId).catch(()=>null);
          if(u) sel.addOptions({label:u.displayName, value:t.userId});
        }
        const msg = await knightMember.send({ content: '【騎士】今夜護衛する対象を選んでください。', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)] });
        const res = await msg.awaitMessageComponent({ filter: i => i.customId === 'k' && i.user.id === knight.userId, componentType: ComponentType.StringSelect, 
          time: actionTimeoutMs + nightBonusMs 
        }).catch(() => null);
        
        if (res) {
          await res.deferUpdate();
          const tId = res.values[0];
          stateManager.updateState({ nightActions: { ...stateManager.getState().nightActions, knightTargetId: tId }, lastGuardedUserId: tId });
          const targetMember = await guild.members.fetch(tId).catch(()=>null);
          const targetName = targetMember?.displayName || '不明';
          
          await res.editReply({ content: `✅ 今夜は「**${targetName}**」さんを護衛します。`, components: [] });

          voiceHoppingQueue.add(async () => {
            const knightVc = await guild.channels.fetch(knight.waitVcId) as VoiceBasedChannel;
            if (knightVc) {
              const connection = await VoiceService.connectWithClient(gmClient, knightVc, gameId, 'main_knight');
              const resText = `護衛先は、${targetName}さんですね。承りました。`;
              const audio = await TTSService.generateAudio(resText, gameId, 'knight_res');
              await VoiceService.playAudio(connection, audio, gameId);
            }
          }, 'gm-knight-res');
        }
      } catch(e) {}
    })();

    await Promise.all([...wolfVotePromises, seerPromise, knightPromise]);
    await voiceHoppingQueue.waitForEmpty();

    for (const wolf of aliveWolves) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(wolf.userId);
          if (member.voice.channelId) await member.voice.setMute(true);
        } catch (e) {}
      }, `mute-wolf-${wolf.userId}`);
    }
    await actionQueue.waitForEmpty();
    await new Promise(resolve => setTimeout(resolve, 1500)); 

    const postNightExpected: Record<string, string> = {};
    for (const player of stateManager.getState().players) {
        postNightExpected[player.userId] = player.isAlive ? player.waitVcId : state.ghostVcId;
    }
    stateManager.updateState({ expectedVcIds: postNightExpected });
    await this.syncLedgerAndMove(guild, gameId, 'night');

    await this.returnToHomePositions(gmClient, assistantClient, gameId);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    let finalWolfTargetId = stateManager.getState().nightActions.wolfTargetId;
    if (aliveWolves.length > 0 && !finalWolfTargetId) {
       finalWolfTargetId = wolfTargets[Math.floor(Math.random() * wolfTargets.length)].userId;
    }

    let killedUserId: string | null = null;
    const finalKnightTargetId = stateManager.getState().nightActions.knightTargetId;

    if (finalWolfTargetId && finalWolfTargetId !== finalKnightTargetId) {
      killedUserId = finalWolfTargetId;
      const updatedPlayers = stateManager.getState().players.map((p: Player) => p.userId === killedUserId ? { ...p, isAlive: false } : p);
      stateManager.updateState({ players: updatedPlayers });
    }

    stateManager.updateState({ day: state.day + 1 });
    const winningTeam = this.checkWinCondition(stateManager.getState());

    if (winningTeam) {
      stateManager.nextPhase('finished');
      await this.finishGame(gmClient, assistantClient, gameId, winningTeam, false);
    } else {
      const killedMember = killedUserId ? await guild.members.fetch(killedUserId).catch(()=>null) : null;
      const killedName = killedMember ? killedMember.displayName : '不明';

      const morningText = killedUserId 
        ? `朝になりました。昨晩の犠牲者は、${killedName}さんでした。`
        : `朝になりました。昨晩は犠牲者が出ませんでした。`;
      
      const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
      await voteChannel.send(`☀️ **【第${state.day}日 朝】**\n${morningText}`);
      
      await this.syncLedgerAndMove(guild, gameId, 'day');

      if (killedUserId) {
        try {
          const member = await guild.members.fetch(killedUserId);
          if (member.voice.channelId) await member.voice.setMute(false);
        } catch (e) {}
      }
      
      const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
      const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
      if (mainVcChannel) {
        const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
        let broadcastConns = [gmConnection];
        if (ghostVc) {
           const astConn = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
           broadcastConns.push(astConn);
        }
        if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${morningText}`, gameId);
        const morningAudio = await TTSService.generateAudio(morningText, gameId, `morning_${state.day}`);
        await VoiceService.broadcastAudio(broadcastConns, morningAudio, gameId);
      }

      stateManager.nextPhase('day_discussion');
      await this.startDayDiscussion(gmClient, assistantClient, gameId); 
    }
  }

  public static async finishGame(gmClient: Client, assistantClient: Client, gameId: string, winningTeam: string, skipIntroAnnounce: boolean = false): Promise<void> {
    Logger.info('PhaseHandler', `🎊 終了フェーズを開始します。`, gameId);
    const stateManager = StateManager.getInstance();
    const actionQueue = ActionQueue.getInstance();
    const state = stateManager.getState();
    const guild = await gmClient.guilds.fetch(state.serverId);
    const voteChannel = await guild.channels.fetch(state.voteChannelId) as TextChannel;
    
    const sysTimeMs = this.getSysTimeMs(state.isDebug);

    await this.syncLedgerAndMove(guild, gameId, 'finish'); 
    for (const player of state.players) {
      actionQueue.add(async () => {
        try {
          const member = await guild.members.fetch(player.userId);
          if (member.voice.channelId) await member.voice.setMute(false);
        } catch (error) {}
      }, `finish-gather-${player.userId}`);
    }
    await actionQueue.waitForEmpty();

    let resultText = `🎉 **ゲーム終了！ ${winningTeam} の勝利です！** 🎉\n\n【役職内訳】\n`;
    for (const p of state.players) {
      const member = await guild.members.fetch(p.userId).catch(()=>null);
      const name = member ? member.displayName : '不明';
      resultText += `- ${name}: **${p.role}** (${p.isAlive ? '生存' : '死亡'})\n`;
    }
    await voteChannel.send(resultText);

    await DiscordService.archiveGameChannel(guild, state.voteChannelId, gameId);

    const mainVcChannel = await guild.channels.fetch(state.mainVcId) as VoiceBasedChannel;
    const assistantGuild = await assistantClient.guilds.fetch(state.serverId);
    const ghostVc = await assistantGuild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;

    if (mainVcChannel && ghostVc) {
      const gmConnection = await VoiceService.connectWithClient(gmClient, mainVcChannel, gameId, 'main');
      const assistantConnection = await VoiceService.connectWithClient(assistantClient, ghostVc, gameId, 'ghost');
      const broadcastConns = [gmConnection, assistantConnection];

      if (!skipIntroAnnounce) {
          const winText = `ゲーム終了です。${winningTeam}の勝利です。おめでとうございます。`;
          const winAudio = await TTSService.generateAudio(winText, gameId, 'win_announce');
          await VoiceService.broadcastAudio(broadcastConns, winAudio, gameId);
      }
      
      const nextText = `役職の内訳はテキストチャンネルをご確認ください。これより、AIによる音声解析を用いて、本日のMVPの選出を行います。少々お待ちください。`;
      const nextAudio = await TTSService.generateAudio(nextText, gameId, 'win_announce_next');
      await VoiceService.broadcastAudio(broadcastConns, nextAudio, gameId);
      
      await voteChannel.send('🤖 全プレイヤーの録音データをGemini APIに送信し、MVPを解析中...');
      
      try {
        const playerNameMap: Record<string, string> = {};
        for (const p of state.players) {
            const member = await guild.members.fetch(p.userId).catch(()=>null);
            playerNameMap[p.userId] = member ? member.displayName : '不明';
        }

        const mvpText = await AIService.analyzeMVP(gameId, state.speechLogs, playerNameMap);
        await voteChannel.send(`🏆 **【MVP発表・AI講評】**\n${mvpText}`);
        
        const mvpPlayerName = mvpText.split('\n')[0].trim();
        const mvpAnnounceText = `お待たせいたしました。本日のMVPは、${mvpPlayerName} さんです！総評や分析については、テキストチャンネルをご確認ください。皆様、本当にお疲れ様でした。これより隔離環境を自動消去し、皆様をロビーへお戻しします。`;
        
        if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${mvpAnnounceText}`, gameId);
        const mvpAudio = await TTSService.generateAudio(mvpAnnounceText, gameId, 'mvp_announce');
        await VoiceService.broadcastAudio(broadcastConns, mvpAudio, gameId);
        
        stateManager.deleteSaveFile(gameId);
      } catch (error) {
        await voteChannel.send(`❌ MVPのAI解析に一時的なエラーが発生しました。セーブデータは保持されています。後ほど \`/再解析 ゲームid:${gameId}\` を実行して再トライしてください。`);
        const fallbackText = `申し訳ありません。AIによるMVP解析に失敗しました。データは保存されていますので、後ほど再解析が可能です。これより隔離環境を自動消去し、皆様をロビーへお戻しします。`;
        if (state.isDebug) Logger.info('Debug', `[発話] ブロードキャスト: ${fallbackText}`, gameId);
        const fallbackAudio = await TTSService.generateAudio(fallbackText, gameId, 'mvp_fallback');
        await VoiceService.broadcastAudio(broadcastConns, fallbackAudio, gameId);
      }
    }

    Logger.info('PhaseHandler', `🧹 隔離環境のクリーンアップを開始します...`, gameId);
    await new Promise(resolve => setTimeout(resolve, sysTimeMs.CLEANUP_DELAY));
    VoiceService.disconnectAll(gameId);
    VCWatcher.getInstance().stop();

    await this.syncLedgerAndMove(guild, gameId, 'lobby');

    const deleteIds = [state.mainVcId, state.wolfVcId, state.ghostVcId];
    state.players.forEach((p: Player) => deleteIds.push(p.waitVcId));

    for (const id of deleteIds) {
      actionQueue.add(async () => {
        try { const ch = await guild.channels.fetch(id); if (ch) await ch.delete(); } catch (e) {}
      }, `cleanup-channel-${id}`);
    }

    for (const player of state.players) {
      actionQueue.add(async () => {
        try { const role = await guild.roles.fetch(player.personalRoleId); if (role) await role.delete(); } catch (e) {}
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
    if (voteChannel) await voteChannel.send(`🔄 **システム復旧**\nフェーズ \`${state.phase}\` から再開します。`);

    switch (state.phase) {
      case 'setup': await this.startRoleDistribution(gmClient, assistantClient, gameId); break;
      case 'day_discussion': await this.startDayDiscussion(gmClient, assistantClient, gameId); break;
      case 'voting': await this.startVotingPhase(gmClient, assistantClient, gameId); break;
      case 'execution': await this.handleExecutionPhase(gmClient, assistantClient, gameId); break;
      case 'night': await this.startNightPhase(gmClient, assistantClient, gameId); break;
    }
  }
}
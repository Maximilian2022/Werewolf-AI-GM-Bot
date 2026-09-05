/**
 * src/handlers/CommandHandler.ts
 * コマンドの実装を担当するクラス
 * - ゲームの開始、フェーズ移行、設定管理など、ユーザーからのコマンドに対する処理を実装
 * - コマンドの内容によっては、StateManagerやDiscordService、PhaseHandlerなどの他のクラスと連携して処理を行う
 * - コマンドの実装は、ユーザーの操作に対して適切なフィードバックを返すことを重視し、エラーハンドリングも行う
*/
import { 
  ChatInputCommandInteraction, GuildMember, PermissionsBitField, Client, TextChannel, VoiceBasedChannel,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ButtonInteraction, ModalSubmitInteraction, StringSelectMenuBuilder, StringSelectMenuInteraction, MessageFlags
} from 'discord.js';
import { StateManager } from '../state/StateManager.js';
import { DiscordService } from '../services/DiscordService.js';
import { PhaseHandler } from './PhaseHandler.js';
import { WorkerManager } from '../managers/WorkerManager.js';
import { VoiceService } from '../services/VoiceService.js';
import { VCWatcher } from '../managers/VCWatcher.js';
import { AIService } from '../services/AIService.js';
import { SettingsManager, GameSettings } from '../managers/SettingsManager.js';
import { Logger } from '../utils/logger.js';
import { GameState } from '../types.js';
import { createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import { Readable } from 'node:stream';
import { TTSService } from '../services/TTSService.js';
import { MSG } from '../messages.js';

export class CommandHandler {
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

  // ===============================================
  // ⚙️ 設定画面のUI生成ヘルパー（リアルタイム更新用）
  // ===============================================
  private static async generateSettingsPayload() {
    const settingsMgr = SettingsManager.getInstance();
    const normal = settingsMgr.get(false), debug = settingsMgr.get(true), sys = settingsMgr.getSystem();
    const aiModels = await AIService.getAvailableModels();

    const embed = new EmbedBuilder()
      .setTitle('⚙️ ゲーム設定マネージャー')
      .setDescription('下のプルダウンから変更したい項目を選択してください。\n設定が完了すると、この画面は自動で最新の状態に更新されます。')
      .setColor('#2b2d31')
      .addFields(
        { name: '🟢 通常モード(時間)', value: `議論: ${normal.day1DiscussionMin}分 / ${normal.day2DiscussionMin}分 (短縮${normal.dayDecreaseMin}分)\n内通: ${normal.wolfMeetingMin}分\n行動: ${normal.actionTimeoutMin}分\n発言: ${normal.speechMin}分 / 遺言: ${normal.lastWordMin}分\n決選弁明: ${normal.runoffDefenseMin}分 / 決選投票: ${normal.runoffVoteTimeoutMin}分\n挙手待ち: ${normal.handRaiseTimeoutSec}秒`, inline: true },
        { name: '🐛 デバッグ(時間)', value: `議論: ${debug.day1DiscussionMin}分 / ${debug.day2DiscussionMin}分 (短縮${debug.dayDecreaseMin}分)\n内通: ${debug.wolfMeetingMin}分\n行動: ${debug.actionTimeoutMin}分\n発言: ${debug.speechMin}分 / 遺言: ${debug.lastWordMin}分\n決選弁明: ${debug.runoffDefenseMin}分 / 決選投票: ${debug.runoffVoteTimeoutMin}分\n挙手待ち: ${debug.handRaiseTimeoutSec}秒`, inline: true },
        { name: '🎙️ システム・演出設定', value: `データ保持: ${normal.dataDeletionDays}日 / 終了ディレイ: ${normal.cleanupDelayMin}分\nGMの声: **${sys.gmVoice}**\nAIモデル: **${sys.aiModel}**\nMVPモード: **${sys.mvpMode}**\nAIトーン: **${sys.aiTone}**`, inline: false }
      );

    // ボタンを廃止し、カテゴリ選択のプルダウンに統合（5項目の上限回避）
    const rowCategory = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings_category_select')
        .setPlaceholder('⏱️ 制限時間・システム保持を変更...')
        .addOptions([
          { label: '☀️ 昼・夜フェーズ (通常)', value: 'edit_normal_day_night' },
          { label: '🗳️ 投票・処刑フェーズ (通常)', value: 'edit_normal_vote_exec' },
          { label: '⚖️ 決選投票フェーズ (通常)', value: 'edit_normal_runoff' },
          { label: '⚙️ 演出・データ保持 (通常)', value: 'edit_normal_system_delay' },
          { label: '🐛 昼・夜フェーズ (デバッグ)', value: 'edit_debug_day_night' },
          { label: '🐛 投票・処刑フェーズ (デバッグ)', value: 'edit_debug_vote_exec' },
          { label: '🐛 決選投票フェーズ (デバッグ)', value: 'edit_debug_runoff' },
          { label: '🐛 演出・データ保持 (デバッグ)', value: 'edit_debug_system_delay' },
          { label: '⚠️ 全ての設定を初期化 (リセット)', value: 'reset_all' }
        ])
    );

    const rowVoice = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings_voice_select')
        .setPlaceholder('🎙️ GMの音声モデルを変更')
        .addOptions([
          { label: '男性・低音 (Neural2-D) ※デフォルト', value: 'ja-JP-Neural2-D', default: sys.gmVoice === 'ja-JP-Neural2-D' },
          { label: '男性・高音 (Neural2-C)', value: 'ja-JP-Neural2-C', default: sys.gmVoice === 'ja-JP-Neural2-C' },
          { label: '女性・落ち着いた声 (Neural2-B)', value: 'ja-JP-Neural2-B', default: sys.gmVoice === 'ja-JP-Neural2-B' },
          { label: '女性・明るい声 (Neural2-A)', value: 'ja-JP-Neural2-A', default: sys.gmVoice === 'ja-JP-Neural2-A' }
        ])
    );

    const rowMvpMode = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings_mvpmode_select')
        .setPlaceholder('⚖️ MVP評価モードを変更')
        .addOptions([
          { label: '議論重視モード (従来通り)', value: 'discussion', default: sys.mvpMode === 'discussion' },
          { label: '勝利貢献度重視モード (役職や勝敗を加味)', value: 'contribution', default: sys.mvpMode === 'contribution' },
          { label: '比較モード (両方のAI講評を出力)', value: 'compare', default: sys.mvpMode === 'compare' }
        ])
    );

    const rowAiModel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings_aimodel_select')
        .setPlaceholder('🧠 AIモデルを変更')
        .addOptions(aiModels.map(m => ({ label: m.label, value: m.value, default: sys.aiModel === m.value })))
    );

    const rowAiTone = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings_aitone_select')
        .setPlaceholder('🎭 AI講評の難易度（毒舌度）を変更')
        .addOptions([
          { label: '🟢 優しめ (初心者向けサポート)', value: 'gentle', default: sys.aiTone === 'gentle' },
          { label: '🔵 普通 (プロの解説者)', value: 'normal', default: sys.aiTone === 'normal' },
          { label: '🔴 辛口 (妥協なき鬼コーチ)', value: 'spicy', default: sys.aiTone === 'spicy' },
          { label: '🔥 激辛 (的確に刺す煽り毒舌GM)', value: 'extreme', default: sys.aiTone === 'extreme' }
        ])
    );

    return { embeds: [embed], components: [rowCategory, rowVoice, rowMvpMode, rowAiModel, rowAiTone] };
  }

  // ===============================================
  // 中断・再開コマンド
  // ===============================================
  public static async handlePause(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();

    if (!state || state.phase === 'finished' || state.phase === 'setup') {
      return interaction.editReply('❌ 一時停止できる進行中のゲームがありません。');
    }
    if (state.isPaused) {
      return interaction.editReply('⚠️ 既に一時停止中です。');
    }

    const isAdmin = (interaction.member as GuildMember).permissions.has(PermissionsBitField.Flags.Administrator);
    const isPlayer = state.players.some(p => p.userId === interaction.user.id);
    if (!isAdmin && !isPlayer) {
      return interaction.editReply('❌ 一時停止を行う権限がありません。');
    }

    state.isPaused = true;
    stateManager.updateState(state);

    const guild = interaction.guild!;
    const voteChannel = await guild.channels.fetch(state.voteChannelId).catch(()=>null) as TextChannel;
    if (voteChannel) {
      await voteChannel.send(`⏸️ **【ゲーム一時停止】**\n<@${interaction.user.id}> さんの操作により、進行を一時停止しました。\n離席者が戻られたら \`/中断解除\` を実行してください。\n*(※人狼の作戦会議のみ、時間を止めずに進行します)*`);
    }
    await interaction.editReply('✅ ゲームを一時停止しました。');
  }

  public static async handleUnpause(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();

    if (!state || state.phase === 'finished' || state.phase === 'setup') {
      return interaction.editReply('❌ 再開できるゲームがありません。');
    }
    if (!state.isPaused) {
      return interaction.editReply('⚠️ ゲームは一時停止されていません。');
    }

    const isAdmin = (interaction.member as GuildMember).permissions.has(PermissionsBitField.Flags.Administrator);
    const isPlayer = state.players.some(p => p.userId === interaction.user.id);
    if (!isAdmin && !isPlayer) {
      return interaction.editReply('❌ 再開を行う権限がありません。');
    }

    state.isPaused = false;
    stateManager.updateState(state);

    const guild = interaction.guild!;
    const voteChannel = await guild.channels.fetch(state.voteChannelId).catch(()=>null) as TextChannel;
    if (voteChannel) {
      await voteChannel.send(`▶️ **【進行再開】**\n全員揃ったため、タイマーと進行を再開します！`);
    }
    await interaction.editReply('✅ ゲームを再開しました。');
  }

  public static async handleStart(interaction: ChatInputCommandInteraction, gmClient: Client, assistantClient: Client) {
    await interaction.deferReply();
    const guild = interaction.guild!;
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;
    const gameId = Math.random().toString(36).substring(2, 8);

    if (!voiceChannel) {
      await interaction.editReply('❌ エラー: ボイスチャンネルに参加してから実行してください。');
      return;
    }

    const isDebug = interaction.options.getBoolean('debug') ?? false;
    const targetCount = interaction.options.getInteger('人数');
    const allMembers = Array.from(voiceChannel.members.values()).filter((m: any) => !m.user.bot);
    const spectators = allMembers.filter((m: any) => m.displayName.startsWith('[観戦]'));
    const humanParticipants = allMembers.filter((m: any) => !m.displayName.startsWith('[観戦]'));

    let participants: GuildMember[] = [...humanParticipants];

    if (isDebug && targetCount) {
      const neededCount = targetCount - participants.length;
      if (neededCount > 0) {
        Logger.info('CommandHandler', `不足分 ${neededCount} 名のバイトを召喚します...`, gameId);
        const workers = WorkerManager.getInstance().getWorkers();
        const summonPromises: Promise<GuildMember | null>[] = [];

        for (let i = 0; i < neededCount; i++) {
          const workerClient = workers[i];
          if (workerClient) {
            summonPromises.push((async () => {
              try {
                const workerGuild = await workerClient.guilds.fetch(guild.id);
                const workerMember = await workerGuild.members.fetch(workerClient.user!.id);
                const workerChannel = await workerGuild.channels.fetch(voiceChannel.id);
                
                if (workerChannel && workerChannel.isVoiceBased()) {
                  await VoiceService.connectWithClient(workerClient, workerChannel, gameId, `worker-${i}`);
                  return workerMember;
                }
                return null;
              } catch (error: any) { return null; }
            })());
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        const summonedResults = await Promise.all(summonPromises);
        const summonedWorkers = summonedResults.filter((w: any): w is GuildMember => w !== null);
        participants.push(...summonedWorkers);
      }
    }

    if (participants.length !== 11 && participants.length !== 13) {
      await interaction.editReply(`❌ エラー: プレイヤーの参加人数が ${participants.length} 人です（観戦者除く）。11人または13人にしてください。`);
      return;
    }

    const hasAdmin = participants.some((p: any) => p.permissions.has(PermissionsBitField.Flags.Administrator));
    if (hasAdmin && !isDebug) {
      await interaction.editReply('❌ エラー: プレイヤーに管理者権限を持つユーザーが含まれています。');
      return;
    }

    try { await interaction.editReply(`隔離環境を構築します (GameID: ${gameId})`); } catch {}

    try {
      await DiscordService.cleanupAllLegacyResources(guild);

      // 環境構築が途中でフリーズしても /廃村 できるよう、先に最小限のStateファイルを作ってしまう
      const preState: any = {
        gameId,
        serverId: guild.id,
        phase: 'setup',
        players: participants.map(p => ({ userId: p.id, role: null, isAlive: true, waitVcId: '', personalRoleId: '', personalTextChannelId: '' })),
        eventLogs: ['[セットアップ開始] 環境リソース構築準備中']
      };
      // この時点で data/games/[gameId].json が非同期で即座に生成されます
      StateManager.getInstance().initState(preState);

      // 🚨 setupGameEnvironment の呼び出しに、進捗更新用の関数を渡す
      const env = await DiscordService.setupGameEnvironment(
        guild, gameId, participants, spectators, gmClient.user!.id, assistantClient.user!.id,
        async (current, total) => {
          // 10秒ごとにこの処理が呼ばれ、メッセージが更新される
          await interaction.editReply(`🏗️ 隔離環境を構築しています... (${current}/${total}人完了)\n※Discordの制限回避のため、完了まで約20秒ほどお待ちください。`).catch(() => {});
        }
      );
      
      Logger.info('CommandHandler', `🏗️ [環境リソースID一覧]
        - Category : ${env.categoryId}
        - Main VC  : ${env.mainVcId}
        - Wolf VC  : ${env.wolfVcId}
        - Ghost VC : ${env.ghostVcId}
        - Vote CH  : ${env.voteChannelId}
        - Wolf CH  : ${env.wolfTextChannelId}`, gameId);

      // initState ではなく「updateState」を使い、完成した完全な環境情報を上書き保存する
      const finalState: GameState = {
        gameId, serverId: guild.id, categoryId: env.categoryId, originalVcId: voiceChannel.id,
        waitVcId: env.mainVcId, mainVcId: env.mainVcId, wolfVcId: env.wolfVcId, ghostVcId: env.ghostVcId, 
        voteChannelId: env.voteChannelId, wolfTextChannelId: env.wolfTextChannelId,
        isDebug, phase: 'setup', day: 0,
        players: participants.map((p: any) => {
          const pEnv = env.playerEnvs.find((e: any) => e.userId === p.id)!;
          return { userId: p.id, role: null, isAlive: true, waitVcId: pEnv.waitVcId, personalRoleId: pEnv.personalRoleId, personalTextChannelId: pEnv.personalTextChannelId };
        }),
        lastGuardedUserId: null, currentVotes: {}, nightActions: {}, speechLogs: [], expectedVcIds: {}, awayPlayerIds: [],
        settingsSnapshot: SettingsManager.getInstance().get(isDebug),
        eventLogs: [...preState.eventLogs, '[セットアップ完了] 全てのリソースの構築に成功'],
        isPaused: false
      };
      StateManager.getInstance().initState(finalState);
      
      const voteChannel = await guild.channels.fetch(env.voteChannelId) as TextChannel;
      if (voteChannel) {
        await voteChannel.send(`🐺 **人狼村が開村しました**\n【GameID: \`${gameId}\`】\n※トラブル等で中断・廃村する場合はこのIDを使用してください。`);
        if (spectators.length > 0) {
            await voteChannel.send(`👁️ **観戦モード:** ${spectators.length}名の方は霊界にアクセスできます。`);
        }
      }

      try { await interaction.editReply(`🐺 セットアップ完了。役職配布フェーズへ移行します。`); } catch {}
      VCWatcher.getInstance().start(gmClient, assistantClient);
      await PhaseHandler.startRoleDistribution(gmClient, assistantClient, gameId);

    } catch (error: any) {
      Logger.error('CommandHandler', '環境構築エラー', error, gameId);
      try { await interaction.editReply('❌ 環境構築中にエラーが発生しました。'); } catch {}
    }
  }

  public static async handleResume(interaction: ChatInputCommandInteraction, gmClient: Client, assistantClient: Client) {
    await interaction.deferReply();
    const gameId = interaction.options.getString('ゲームid');
    const stateManager = StateManager.getInstance();

    if (!gameId || !stateManager.loadFromFile(gameId)) {
      await interaction.editReply(`❌ エラー: ゲームID [${gameId}] のセーブデータが見つかりません。`);
      return;
    }
    const state = stateManager.getState() as any;
    state.isResumedBonus = true;
    stateManager.updateState(state);
    VCWatcher.getInstance().start(gmClient, assistantClient);
    await interaction.editReply(`✅ ゲーム [${gameId}] の復元に成功しました。進行を再開します。`);
    await PhaseHandler.resumeGame(gmClient, assistantClient, gameId);
  }

  public static async handleAbandon(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const gameId = interaction.options.getString('ゲームid');
    const guild = interaction.guild!;

    if (!gameId) {
      await interaction.editReply('❌ エラー: ゲームIDが指定されていません。');
      return;
    }

    const stateManager = StateManager.getInstance();
    if (!stateManager.loadFromFile(gameId)) {
      await interaction.editReply(`❌ エラー: ゲームID [\`${gameId}\`] のセーブデータが見つかりません。`);
      return;
    }

    const state = stateManager.getState();

    try {
      VCWatcher.getInstance().stop();
      
      if (state.originalVcId) {
        await interaction.editReply(`⏳ プレイヤーをロビーへ送還中...`);
        const movePromises = state.players.map(async p => {
          try {
            const m = await guild.members.fetch(p.userId).catch(() => null);
            if (m && m.voice.channelId) {
              if (m.user.bot) {
                await m.voice.disconnect().catch(() => {});
                return;
              }
              const currentChannel = await guild.channels.fetch(m.voice.channelId).catch(() => null);
              if (currentChannel && currentChannel.parentId === state.categoryId) {
                await m.voice.setChannel(state.originalVcId).catch(() => {});
              }
            }
          } catch (e) {}
        });
        await Promise.all(movePromises);
      }

      const workers = WorkerManager.getInstance().getWorkers();
      await Promise.all(workers.map(async (worker, index) => {
        try {
          const wGuild = await worker.guilds.fetch(state.serverId).catch(() => null);
          if (wGuild && wGuild.members.me) {
            const isMic = wGuild.members.me.nickname?.includes('マイク');
            const isInMyVillage = wGuild.members.me.voice.channelId === state.mainVcId;

            if (isMic && isInMyVillage) {
              const num = String(index + 1).padStart(2, '0');
              await wGuild.members.me.setNickname(`人狼ゲームスタッフ${num}`).catch(() => {});
            }
            if (wGuild.members.me.voice.channelId) {
              await wGuild.members.me.voice.disconnect().catch(() => {});
            }
          }
        } catch (e) {}
      }));

      try {
        const gmMember = await guild.members.fetch(interaction.client.user!.id);
        if (gmMember && gmMember.voice.channelId) await gmMember.voice.disconnect().catch(() => {});
      } catch (e) {}
      
      // アシスタントBotの切断（VCWatcher経由でClientを取得するか、IDが分かれば切断）
      try {
        // stateに記録がないため、DiscordAPIから「同じサーバーにいるボット」を探して切断するなどの対応も可能ですが、
        // DiscordService.abandonGameEnvironment でチャンネルが消されるため、基本的には切断されます。
        // ここでは安全のため自分（GM）とワーカーを確実に切断します。
      } catch (e) {}

      VoiceService.disconnectAll(gameId);
      await DiscordService.abandonGameEnvironment(guild, gameId);
      stateManager.deleteSaveFile(gameId);

      await interaction.editReply(`✅ GameID [\`${gameId}\`] の廃村処理が完了し、環境とセーブデータを完全に削除しました。`);
    } catch (error) {
      Logger.error('CommandHandler', '廃村処理中にエラーが発生しました', error, gameId);
      await interaction.editReply(`❌ 廃村処理中にエラーが発生しました。一部のカテゴリーやチャンネルが残っている可能性があります。`);
    }
  }
  
  public static async handleEmergencyUnmute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      await interaction.editReply('❌ エラー: ミュート解除したい人がいるボイスチャンネルに参加してから実行してください。');
      return;
    }

    let count = 0;
    try {
      for (const targetMember of voiceChannel.members.values()) {
        if (targetMember.voice.serverMute && !targetMember.user.bot) {
          try {
            await targetMember.voice.setMute(false);
            count++;
          } catch (e) {}
        }
      }
      await interaction.editReply(`✅ 現在のボイスチャンネル（${voiceChannel.name}）にいる ${count} 名のサーバーミュートを強制解除しました。`);
    } catch (error) {
      Logger.error('CommandHandler', '緊急ミュート解除中にエラーが発生しました', error);
      await interaction.editReply('❌ ミュート解除処理中にエラーが発生しました。');
    }
  }

  /**
   * src/handlers/CommandHandler.ts
   * 一部抜粋（handleReanalyze 関数の部分のみ上書きしてください）
   */

  public static async handleReanalyze(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const gameId = interaction.options.getString('ゲームid');
    const stateManager = StateManager.getInstance();

    if (!gameId || !stateManager.loadFromFile(gameId)) return interaction.editReply(`❌ エラー: ゲームIDが見つかりません。すでに保存期間が経過して削除された可能性があります。`);
    const state = stateManager.getState();
    if (!state.speechLogs || state.speechLogs.length === 0) return interaction.editReply(`❌ エラー: 録音データがありません。`);

    try {
      const sys = SettingsManager.getInstance().getSystem();
      await interaction.editReply(`🧠 再解析中... [モデル: \`${sys.aiModel}\` / モード: \`${sys.mvpMode}\`]\n※TPM保護機能により、他の解析が実行中の場合は順番待ちが発生します。`);
      
      const playerNameMap: Record<string, string> = {};
      for (const p of state.players) {
          try {
              const member = interaction.guild!.members.cache.get(p.userId) || await interaction.guild!.members.fetch(p.userId);
              playerNameMap[p.userId] = member.displayName;
          } catch (e) {
              playerNameMap[p.userId] = '不明なプレイヤー';
          }
      }

      const mvpData = await AIService.analyzeMVP(gameId, state.speechLogs, playerNameMap, state.eventLogs || []);
      
      let resultText = '';
      if (sys.mvpMode === 'compare') {
          resultText = MSG.CHAT.MVP_RESULT_DOUBLE(mvpData.discussionMvpName || '不明', mvpData.contributionMvpName || '不明', mvpData.text);
      } else {
          const title = sys.mvpMode === 'discussion' ? '議論MVP' : '勝利貢献MVP';
          resultText = MSG.CHAT.MVP_RESULT_SINGLE(title, mvpData.mvpName, mvpData.text);
      }

      // 🚨 再解析コマンド実行時のインテリジェント・フォールバック対応
      if (mvpData.wasForcedFallback) {
          const warningMsg = `⚠️ **【システム通知】**\n設定されていたAIモデルで制限エラーを検知したため、安全な無料枠モデル（自動フォールバック）へ切り替えて再解析を実行しました。\n今後の遅延を防ぐため、サーバーの全体設定を **「自動フォールバック」** に自動更新しました。\n\n---\n\n`;
          resultText = warningMsg + resultText;
          SettingsManager.getInstance().updateSystem({ aiModel: 'fallback' });
      }

      const chunks = this.splitMessage(`🏆 **【MVP再解析結果: \`${gameId}\`】**\n\n${resultText}`);
      for (const chunk of chunks) await interaction.followUp(chunk);

      await interaction.followUp(`✅ 再解析が完了しました。（データは設定された日数分保持されるため、設定を変更して何度でも再解析可能です）`);
    } catch (error) {
      await interaction.followUp(`❌ 再解析に失敗しました。（キューのタイムアウト、またはAPI制限の可能性があります）`);
    }
  }

  public static async handleSpectate(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stateManager = StateManager.getInstance();
    
    let state;
    try { state = stateManager.getState(); } catch (e) {
      return interaction.editReply('❌ 現在進行中のゲームが見つかりません。');
    }

    if (!state || state.phase === 'finished' || state.phase === 'setup') {
      return interaction.editReply('❌ 観戦可能な進行中のゲームが見つかりません。');
    }

    const guild = interaction.guild!;
    const member = interaction.member as GuildMember;

    if (!member.displayName.startsWith('[観戦]')) {
      try { await member.setNickname(`[観戦]${member.displayName.substring(0, 28)}`); } catch (e) {Logger.warn('CommandHandler', `ニックネーム変更権限なし (スキップ): ${member.user.tag}`);}
    }

    try {
      const ghostVc = await guild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
      if (ghostVc) {
        await ghostVc.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true, Speak: true });
        await interaction.editReply(`✅ 観戦モードとして途中参加しました！\n人狼村カテゴリ内の **「霊界」** チャンネルに接続してください。`);
      }else {
        await interaction.editReply('❌ 霊界チャンネルが見つかりませんでした。');
      }
    } catch (e) {
      await interaction.editReply('❌ 権限の付与に失敗しました。');
    }
  }

  // ===============================================
  // ⚙️ 設定コマンドとプルダウン処理
  // ===============================================
  public static async handleSettings(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const payload = await this.generateSettingsPayload();
    await interaction.editReply(payload);  
  }

  public static async handleSettingsSelect(interaction: StringSelectMenuInteraction) {
    const customId = interaction.customId;
    const value = interaction.values[0];

    // 1. システム設定（音声、モデル、モード等）の変更
    if (customId === 'settings_voice_select') {
       SettingsManager.getInstance().updateSystem({ gmVoice: value });
    } else if (customId === 'settings_mvpmode_select') {
       SettingsManager.getInstance().updateSystem({ mvpMode: value as any });
    } else if (customId === 'settings_aimodel_select') {
       SettingsManager.getInstance().updateSystem({ aiModel: value });
    } else if (customId === 'settings_aitone_select') {
       SettingsManager.getInstance().updateSystem({ aiTone: value as any });
    } 
    // 2. 時間設定のカテゴリ選択（Modalを開く）
    else if (customId === 'settings_category_select') {
      if (value === 'reset_all') {
         SettingsManager.getInstance().reset();
         const payload = await this.generateSettingsPayload();
         await interaction.update(payload);
         await interaction.followUp({ content: '✅ 全ての設定を初期値にリセットしました。', flags: MessageFlags.Ephemeral });
         return;
      }

      const isDebug = value.includes('debug');
      const current = SettingsManager.getInstance().get(isDebug);
      const modal = new ModalBuilder().setCustomId(`modal_${value}`); // e.g. modal_edit_normal_day_night

      if (value.endsWith('day_night')) {
        modal.setTitle(`☀️ 昼・夜フェーズ (${isDebug ? 'デバッグ' : '通常'})`);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('day1').setLabel('初日議論時間 (分)').setStyle(TextInputStyle.Short).setValue(current.day1DiscussionMin.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('day2').setLabel('2日目以降議論時間 (分)').setStyle(TextInputStyle.Short).setValue(current.day2DiscussionMin.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('decrease').setLabel('毎日の短縮時間 (分)').setStyle(TextInputStyle.Short).setValue(current.dayDecreaseMin.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('wolf').setLabel('人狼内通時間 (分)').setStyle(TextInputStyle.Short).setValue(current.wolfMeetingMin.toString()))
        );
      } else if (value.endsWith('vote_exec')) {
        modal.setTitle(`🗳️ 投票・処刑フェーズ (${isDebug ? 'デバッグ' : '通常'})`);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('timeout').setLabel('夜・投票アクション制限時間 (分)').setStyle(TextInputStyle.Short).setValue(current.actionTimeoutMin.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('handraise').setLabel('挙手待ちタイムアウト (秒)').setStyle(TextInputStyle.Short).setValue(current.handRaiseTimeoutSec.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('speech').setLabel('個人の発言時間 (分)').setStyle(TextInputStyle.Short).setValue(current.speechMin.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('lastword').setLabel('遺言の時間 (分)').setStyle(TextInputStyle.Short).setValue(current.lastWordMin.toString()))
        );
      } else if (value.endsWith('runoff')) {
        modal.setTitle(`⚖️ 決選投票フェーズ (${isDebug ? 'デバッグ' : '通常'})`);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('runoff_defense').setLabel('決選弁明時間 (分)').setStyle(TextInputStyle.Short).setValue(current.runoffDefenseMin.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('runoff_vote').setLabel('決選投票時間 (分)').setStyle(TextInputStyle.Short).setValue(current.runoffVoteTimeoutMin.toString()))
        );
      } else if (value.endsWith('system_delay')) {
        modal.setTitle(`⚙️ 演出・システム保持 (${isDebug ? 'デバッグ' : '通常'})`);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('cleanup_delay').setLabel('終了時の演出ディレイ (分)').setStyle(TextInputStyle.Short).setValue(current.cleanupDelayMin.toString())),
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('delete_days').setLabel('データ保存日数 (日)').setStyle(TextInputStyle.Short).setValue(current.dataDeletionDays.toString()))
        );
      }
      
      await interaction.showModal(modal);
      return; // Modalを表示した場合はここで終了（interaction.updateは呼ばない）
    }

    // システム設定を変更した場合は画面を即座に更新する
    const payload = await this.generateSettingsPayload();
    await interaction.update(payload);
    await interaction.followUp({ content: `✅ 設定を変更しました！`, flags: MessageFlags.Ephemeral });
  }

  // 古いボタンが押された時のための後方互換性（クラッシュ防止）
  public static async handleSettingsButton(interaction: ButtonInteraction) {
    await interaction.reply({ content: '⚠️ この設定メニューは古いため無効です。再度 `/設定` コマンドを実行してください。', flags: MessageFlags.Ephemeral });
  }


  // ===============================================
  // ⚙️ Modal送信後の設定保存処理
  // ===============================================
  public static async handleSettingsModal(interaction: ModalSubmitInteraction) {
    try {
      const customId = interaction.customId; // e.g. modal_edit_normal_day_night
      const isDebug = customId.includes('debug');
      const newSettings: Partial<GameSettings> = {};

      // 🚨 安全に数値を取り出すヘルパー関数（全角数字や空白にも対応）
      const parseField = (id: string) => {
        let val = interaction.fields.getTextInputValue(id).trim();
        // 全角数字を半角に変換するおもてなし処理
        val = val.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
        const parsed = parseFloat(val);
        if (Number.isNaN(parsed)) throw new Error(`Invalid Number: ${id}`);
        return parsed;
      };

      if (customId.endsWith('day_night')) {
        newSettings.day1DiscussionMin = parseField('day1');
        newSettings.day2DiscussionMin = parseField('day2');
        newSettings.dayDecreaseMin = parseField('decrease');
        newSettings.wolfMeetingMin = parseField('wolf');
      } else if (customId.endsWith('vote_exec')) {
        newSettings.actionTimeoutMin = parseField('timeout');
        newSettings.handRaiseTimeoutSec = parseField('handraise');
        newSettings.speechMin = parseField('speech');
        newSettings.lastWordMin = parseField('lastword');
      } else if (customId.endsWith('runoff')) {
        newSettings.runoffDefenseMin = parseField('runoff_defense');
        newSettings.runoffVoteTimeoutMin = parseField('runoff_vote');
      } else if (customId.endsWith('system_delay')) {
        newSettings.cleanupDelayMin = parseField('cleanup_delay');
        newSettings.dataDeletionDays = parseField('delete_days');
      }

      SettingsManager.getInstance().update(isDebug, newSettings);
      
      const payload = await CommandHandler.generateSettingsPayload();
      
      // ビルドエラーを回避しつつ、安全に元の画面を更新する
      if (interaction.isFromMessage()) {
        // メッセージから開かれたモーダルの場合、これで更新と応答が同時に完了する
        await interaction.update(payload);
        await interaction.followUp({ 
          content: `✅ ${isDebug ? 'デバッグ' : '通常'}設定を保存しました！`, 
          flags: MessageFlags.Ephemeral 
        });
      } else {
        // 万が一それ以外のルートだった場合のフォールバック
        await interaction.reply({ 
          content: `✅ ${isDebug ? 'デバッグ' : '通常'}設定を保存しました！`, 
          flags: MessageFlags.Ephemeral 
        });
      }
      
    } catch (e) {
      Logger.error('CommandHandler', '設定保存エラー', e);
      const errorContent = '❌ 入力値が不正です。時間は半角または全角の数値で入力してください。';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorContent, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errorContent, flags: MessageFlags.Ephemeral });
      }
    }
  }

}
/**
 * src/handlers/CommandHandler.ts
 * サーバーニックネーム対応版
 */
import { 
  ChatInputCommandInteraction, GuildMember, PermissionsBitField, Client, TextChannel, VoiceBasedChannel,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ButtonInteraction, ModalSubmitInteraction
} from 'discord.js';
import { StateManager } from '../state/StateManager';
import { DiscordService } from '../services/DiscordService';
import { PhaseHandler } from './PhaseHandler';
import { WorkerManager } from '../managers/WorkerManager';
import { VoiceService } from '../services/VoiceService';
import { VCWatcher } from '../managers/VCWatcher';
import { AIService } from '../services/AIService';
import { SettingsManager } from '../managers/SettingsManager';
import { Logger } from '../utils/logger';
import { GameState } from '../types';

export class CommandHandler {
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
      const env = await DiscordService.setupGameEnvironment(guild, gameId, participants, spectators, gmClient.user!.id, assistantClient.user!.id);

      const initialState: GameState = {
        gameId, serverId: guild.id, categoryId: env.categoryId, originalVcId: voiceChannel.id,
        waitVcId: env.mainVcId, mainVcId: env.mainVcId, wolfVcId: env.wolfVcId, ghostVcId: env.ghostVcId, voteChannelId: env.voteChannelId,
        isDebug, phase: 'setup', day: 0,
        players: participants.map((p: any) => {
          const pEnv = env.playerEnvs.find((e: any) => e.userId === p.id)!;
          return { userId: p.id, role: null, isAlive: true, waitVcId: pEnv.waitVcId, personalRoleId: pEnv.personalRoleId };
        }),
        lastGuardedUserId: null, currentVotes: {}, nightActions: {}, speechLogs: [], expectedVcIds: {} ,
        // 🚨 その時点の設定をスナップショットとして固定
        settingsSnapshot: SettingsManager.getInstance().get(isDebug)
      };

      StateManager.getInstance().initState(initialState);
      
      const voteChannel = await guild.channels.fetch(env.voteChannelId) as TextChannel;
      if (voteChannel) {
        await voteChannel.send(`🐺 **人狼村が開村しました**\n【GameID: \`${gameId}\`】\n※トラブル等で中断・廃村する場合はこのIDを使用してください。`);
        if (spectators.length > 0) {
            await voteChannel.send(`👁️ **観戦モード:** ${spectators.length}名の方は霊界にアクセスできます。`);
        }
      }

      try { await interaction.editReply(`🐺 セットアップ完了。役職配布フェーズへ移行します。`); } catch {}
      VCWatcher.getInstance().start(gmClient);
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

    VCWatcher.getInstance().start(gmClient);
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
    if (stateManager.loadFromFile(gameId)) {
      const state = stateManager.getState();
      if (state.originalVcId) {
        await interaction.editReply(`⏳ プレイヤーをロビーへ送還中...`);
        const promises = state.players.map(async p => {
          try {
            const m = await guild.members.fetch(p.userId).catch(()=>null);
            if (m && m.voice.channelId) await m.voice.setChannel(state.originalVcId).catch(()=>{});
          } catch(e) {}
        });
        await Promise.all(promises);
      }
    }

    try {
      await DiscordService.abandonGameEnvironment(guild, gameId);
      StateManager.getInstance().deleteSaveFile(gameId);
      VCWatcher.getInstance().stop();
      await interaction.editReply(`✅ GameID [\`${gameId}\`] の廃村処理が完了し、環境とセーブデータを完全に削除しました。`);
    } catch (error) {
      await interaction.editReply(`❌ 廃村処理中にエラーが発生しました。一部のチャンネルが残っている可能性があります。`);
    }
  }

  public static async handleEmergencyUnmute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild!;
    const state = StateManager.getInstance().getState();
    let count = 0;

    if (state?.players) {
       for (const p of state.players) {
          try {
             const member = await guild.members.fetch(p.userId);
             if (member.voice.channelId) { await member.voice.setMute(false); count++; }
          } catch { }
       }
    }
    await interaction.editReply(`✅ 接続中の ${count} 名のサーバーミュートを強制解除しました。`);
  }

  public static async handleReanalyze(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const gameId = interaction.options.getString('ゲームid');
    const stateManager = StateManager.getInstance();

    if (!gameId || !stateManager.loadFromFile(gameId)) {
      await interaction.editReply(`❌ エラー: ゲームIDが見つかりません。`);
      return;
    }

    const state = stateManager.getState();
    if (!state.speechLogs || state.speechLogs.length === 0) {
      await interaction.editReply(`❌ エラー: 録音データがありません。`);
      return;
    }

    try {
      await interaction.editReply(`🧠 再解析中...`);
      const playerNameMap: Record<string, string> = {};
      for (const p of state.players) {
          try {
              // 🚨 修正: GuildMember から displayName (ニックネーム) を取得
              const member = await interaction.guild!.members.fetch(p.userId);
              playerNameMap[p.userId] = member.displayName;
          } catch (e) {
              playerNameMap[p.userId] = '不明なプレイヤー';
          }
      }

      const mvpText = await AIService.analyzeMVP(gameId, state.speechLogs, playerNameMap);
      await interaction.followUp(`🏆 **【MVP再解析結果: ${gameId}】**\n${mvpText}`);
      stateManager.deleteSaveFile(gameId);
      await interaction.followUp(`✅ セーブデータを削除しました。`);
    } catch (error) {
      await interaction.followUp(`❌ 再解析に失敗しました。`);
    }
  }

  public static async handleSpectate(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const stateManager = StateManager.getInstance();
    
    let state;
    try { state = stateManager.getState(); } catch (e) {
      await interaction.editReply('❌ 現在進行中のゲームが見つかりません。');
      return;
    }

    if (!state || state.phase === 'finished' || state.phase === 'setup') {
      await interaction.editReply('❌ 観戦可能な進行中のゲームが見つかりません。');
      return;
    }

    const guild = interaction.guild!;
    const member = interaction.member as GuildMember;

    if (!member.displayName.startsWith('[観戦]')) {
      try { await member.setNickname(`[観戦]${member.displayName.substring(0, 28)}`); } 
      catch (e) { Logger.warn('CommandHandler', `ニックネーム変更権限なし (スキップ): ${member.user.tag}`); }
    }

    try {
      const ghostVc = await guild.channels.fetch(state.ghostVcId) as VoiceBasedChannel;
      if (ghostVc) {
        await ghostVc.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true, Speak: true });
        await interaction.editReply(`✅ 観戦モードとして途中参加しました！\n人狼村カテゴリ内の **「霊界」** チャンネルに接続してください。`);
      } else {
        await interaction.editReply('❌ 霊界チャンネルが見つかりませんでした。');
      }
    } catch (e) {
      await interaction.editReply('❌ 権限の付与に失敗しました。');
    }
  }

  public static async handleSettings(interaction: ChatInputCommandInteraction) {
    const settingsMgr = SettingsManager.getInstance();
    const normal = settingsMgr.get(false);
    const debug = settingsMgr.get(true);
    const sys = settingsMgr.getSystem();

    const embed = new EmbedBuilder()
      .setTitle('⚙️ ゲーム設定マネージャー')
      .setColor('#2b2d31')
      .addFields(
        { name: '🟢 通常モード(時間)', value: `初日議論: ${normal.day1DiscussionMin}分\n2日目以降: ${normal.day2DiscussionMin}分\n毎日の短縮: ${normal.dayDecreaseMin}分\n人狼内通: ${normal.wolfMeetingMin}分\n行動猶予: ${normal.actionTimeoutMin}分`, inline: true },
        { name: '🐛 デバッグモード(時間)', value: `初日議論: ${debug.day1DiscussionMin}分\n2日目以降: ${debug.day2DiscussionMin}分\n毎日の短縮: ${debug.dayDecreaseMin}分\n人狼内通: ${debug.wolfMeetingMin}分\n行動猶予: ${debug.actionTimeoutMin}分`, inline: true },
        { name: '🖥️ システム設定', value: `GMの声: ${sys.gmVoice === 'female' ? '女性 (高橋ヨスガ風)' : '男性 (デフォルト)'}`, inline: false }
      );

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('settings_edit_normal').setLabel('通常時間を変更').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('settings_edit_debug').setLabel('デバッグ時間を変更').setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('settings_edit_system').setLabel('システム設定を変更').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('settings_reset').setLabel('全てリセット').setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
  }

  public static async handleSettingsButton(interaction: ButtonInteraction) {
    if (interaction.customId === 'settings_reset') {
      SettingsManager.getInstance().reset();
      await interaction.update({ content: '✅ 全ての設定を初期値にリセットしました。再度 `/設定` を実行して確認してください。', embeds: [], components: [] });
      return;
    }

    if (interaction.customId === 'settings_edit_system') {
      const sys = SettingsManager.getInstance().getSystem();
      const modal = new ModalBuilder().setCustomId('modal_settings_system').setTitle('🖥️ システム設定を変更');
      const input = new TextInputBuilder().setCustomId('voice').setLabel('GMの声 (male または female と入力)').setStyle(TextInputStyle.Short).setValue(sys.gmVoice);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    const isDebug = interaction.customId === 'settings_edit_debug';
    const current = SettingsManager.getInstance().get(isDebug);
    const modal = new ModalBuilder()
      .setCustomId(`modal_settings_${isDebug ? 'debug' : 'normal'}`)
      .setTitle(`⏱️ ${isDebug ? 'デバッグ' : '通常'}時間を変更`);

    const inputs = [
      new TextInputBuilder().setCustomId('day1').setLabel('初日議論時間 (分)').setStyle(TextInputStyle.Short).setValue(current.day1DiscussionMin.toString()),
      new TextInputBuilder().setCustomId('day2').setLabel('2日目以降議論時間 (分)').setStyle(TextInputStyle.Short).setValue(current.day2DiscussionMin.toString()),
      new TextInputBuilder().setCustomId('decrease').setLabel('毎日の短縮時間 (分)').setStyle(TextInputStyle.Short).setValue(current.dayDecreaseMin.toString()),
      new TextInputBuilder().setCustomId('wolf').setLabel('人狼内通時間 (分)').setStyle(TextInputStyle.Short).setValue(current.wolfMeetingMin.toString()),
      new TextInputBuilder().setCustomId('timeout').setLabel('投票・夜の行動猶予時間 (分)').setStyle(TextInputStyle.Short).setValue(current.actionTimeoutMin.toString())
    ];

    modal.addComponents(inputs.map(input => new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
    await interaction.showModal(modal);
  }

  public static async handleSettingsModal(interaction: ModalSubmitInteraction) {
    try {
      if (interaction.customId === 'modal_settings_system') {
        const voice = interaction.fields.getTextInputValue('voice').toLowerCase();
        if (voice !== 'male' && voice !== 'female') throw new Error('Invalid Voice');
        SettingsManager.getInstance().updateSystem({ gmVoice: voice });
        await interaction.reply({ content: `✅ システム設定を保存しました！`, ephemeral: true });
        return;
      }

      const isDebug = interaction.customId === 'modal_settings_debug';
      const newSettings = {
        day1DiscussionMin: parseFloat(interaction.fields.getTextInputValue('day1')),
        day2DiscussionMin: parseFloat(interaction.fields.getTextInputValue('day2')),
        dayDecreaseMin: parseFloat(interaction.fields.getTextInputValue('decrease')),
        wolfMeetingMin: parseFloat(interaction.fields.getTextInputValue('wolf')),
        actionTimeoutMin: parseFloat(interaction.fields.getTextInputValue('timeout'))
      };

      if (Object.values(newSettings).some(isNaN)) throw new Error('Invalid Number');

      SettingsManager.getInstance().update(isDebug, newSettings);
      await interaction.reply({ content: `✅ ${isDebug ? 'デバッグ' : '通常'}設定を保存しました！\n(※次回開始・再開されるフェーズから適用されます)`, ephemeral: true });
    } catch (e) {
      await interaction.reply({ content: '❌ 入力値が不正です。時間は半角数値で、声は male または female と入力してください。', ephemeral: true });
    }
  }
}
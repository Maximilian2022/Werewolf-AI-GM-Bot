// @ts-nocheck
/**
 * src/services/DiscordService.ts
 * Discord関連のユーティリティクラス
 * - ゲーム環境のセットアップとクリーンアップ、チャンネルのアーカイブ化など、Discordサーバー上でのゲーム運営に必要な機能を提供
 * - ゲームごとに専用のカテゴリーとチャンネルを作成し、適切な権限設定を行うことで、プレイヤーのプライバシーとゲームの円滑な進行をサポート
 * - 廃村処理では、ゲームに関連する全てのチャンネルとロールを削除してクリーンな状態に戻す機能を提供
 */

import { ChannelType, Guild, GuildMember, PermissionsBitField, OverwriteType, TextChannel, CategoryChannel } from 'discord.js';
import { Logger } from '../utils/logger.js';
import { GameEnvironment } from '../types.js';
import { WorkerManager } from '../managers/WorkerManager.js';

export class DiscordService {
  // ゲーム環境のセットアップ関数。ゲームID、参加メンバー、GMとアシスタントのBot IDを受け取り、必要なカテゴリーとチャンネルを作成して適切な権限を設定する
  public static async cleanupAllLegacyResources(guild: Guild): Promise<void> {
    Logger.info('DiscordService', '自動クリーンアップはセキュリティ上スキップ。');
  }
  // 廃村処理関数。指定されたゲームIDに関連する全てのチャンネルとロールを削除して、サーバーをクリーンな状態に戻す
  public static async abandonGameEnvironment(guild: Guild, gameId: string): Promise<void> {
    Logger.warn('DiscordService', `🚮 [${gameId}] 廃村処理を実行...`);
    const category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes(`[${gameId}]`)) as CategoryChannel;
    if (category) {
        const children = guild.channels.cache.filter(c => c.parentId === category.id);
        for (const child of children.values()) {
            await child.delete().catch(() => {});
        }
        await category.delete().catch(() => {});
    }
    const roles = guild.roles.cache.filter(r => r.name.includes(gameId));
    for (const role of roles.values()) {
        await role.delete().catch(() => {});
    }
    Logger.success('DiscordService', `✅ [${gameId}] 抹消完了。`);
  }
  // ゲーム終了後のチャンネルアーカイブ関数。指定されたチャンネルを「試合結果アーカイブ」カテゴリーに移動し、全員が閲覧できるように権限を設定する
  public static async archiveGameChannel(guild: Guild, channelId: string, gameId: string): Promise<void> {
    try {
        const channel = await guild.channels.fetch(channelId).catch(() => null) as TextChannel;
        if (!channel) return;

        let archiveCategory = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '📂 試合結果アーカイブ') as CategoryChannel;
        if (!archiveCategory) {
            archiveCategory = await guild.channels.create({ name: '📂 試合結果アーカイブ', type: ChannelType.GuildCategory });
        }

        const date = new Date().toLocaleDateString('ja-JP').replace(/\//g, '-');
        await channel.setName(`試合結果-${gameId}-${date}`);
        await channel.setParent(archiveCategory.id, { lockPermissions: false });
        
        await channel.permissionOverwrites.set([
          {
            id: guild.roles.everyone.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
            deny: [PermissionsBitField.Flags.SendMessages]
          }
        ]);
        
        Logger.info('DiscordService', `📦 [${gameId}] をアーカイブ化し、全員に公開しました。`);
    } catch (e) {
        Logger.error('DiscordService', 'アーカイブ化エラー', e);
    }
  }
  // ゲーム環境のセットアップ関数。ゲームID、参加メンバー、GMとアシスタントのBot IDを受け取り、必要なカテゴリーとチャンネルを作成して適切な権限を設定する
  public static async setupGameEnvironment(
    guild: Guild, gameId: string, members: GuildMember[], spectators: GuildMember[], 
    gmBotId: string, assistantBotId: string,
    onProgress?: (current: number, total: number) => Promise<void> // 👈 これを追加
  ): Promise<GameEnvironment> {
    const env: GameEnvironment = { commonRoleId: '', categoryId: '', mainVcId: '', wolfVcId: '', ghostVcId: '', voteChannelId: '', wolfTextChannelId: '', playerEnvs: [] };
    const workerManager = WorkerManager.getInstance();
    const workerIds = workerManager.getWorkers().map(w => w.user?.id).filter(id => id);

    const role = await guild.roles.create({ name: `GM-COMMON-${gameId}` });
    env.commonRoleId = role.id;
    
    const baseOverwrites = [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      { id: role.id, type: OverwriteType.Role, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      { id: gmBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
      { id: assistantBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
      ...workerIds.map(id => ({ id, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }))
    ];

    const wolfOnlyOverwrites = [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      { id: gmBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
      { id: assistantBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
      ...workerIds.map(id => ({ id, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }))
    ];

    const category = await guild.channels.create({ name: `🐺 人狼村 [${gameId}]`, type: ChannelType.GuildCategory, permissionOverwrites: baseOverwrites });
    env.categoryId = category.id;

    // 🚨 修正：チャンネル名にGameIDを付与
    const wolfTextCh = await guild.channels.create({
      name: `人狼内通ログ-${gameId}`,
      type: ChannelType.GuildText,
      parent: env.categoryId,
      permissionOverwrites: wolfOnlyOverwrites 
    });
    env.wolfTextChannelId = wolfTextCh.id;

    const spectatorOverwrites = spectators.map(s => ({
        id: s.id, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak]
    }));

    const commonPromises = [
      { name: '全体議論', type: ChannelType.GuildVoice, key: 'mainVcId', isGhost: false, isWolf: false },
      { name: '人狼内通', type: ChannelType.GuildVoice, key: 'wolfVcId', isGhost: false, isWolf: true },
      { name: '霊界', type: ChannelType.GuildVoice, key: 'ghostVcId', isGhost: true, isWolf: false },
      { name: '投票所', type: ChannelType.GuildText, key: 'voteChannelId', isGhost: false, isWolf: false }
    ].map(async (ch) => {
      let channelOverwrites = baseOverwrites;
      if (ch.isGhost) channelOverwrites = [...baseOverwrites, ...spectatorOverwrites];
      if (ch.isWolf) channelOverwrites = wolfOnlyOverwrites; 

      if (ch.key === 'voteChannelId') {
        channelOverwrites = [
          { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: role.id, type: OverwriteType.Role, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: gmBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: assistantBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ];
      }

      const created = await guild.channels.create({ 
          name: ch.name, type: ch.type, parent: env.categoryId, permissionOverwrites: channelOverwrites 
      });
      (env as any)[ch.key] = created.id;
    });
    await Promise.all(commonPromises);

    let lastUpdateTime = Date.now(); // ⏱️ 時間計測用
    // 1人ずつ順番に作成（レートリミット回避＆個人ロール廃止）
    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      const playerNum = index + 1;

      // 🚨 Discord APIを怒らせないため、待機時間を300msから「1秒」に引き上げ
      await new Promise(resolve => setTimeout(resolve, 1000));

      // ⏱️ もし前回の更新から 10,000ミリ秒（10秒）以上経過していたら進捗を報告
      if (onProgress && Date.now() - lastUpdateTime >= 10000) {
        await onProgress(playerNum, members.length).catch(() => {});
        lastUpdateTime = Date.now(); // 最終更新時間をリセット
      }
      
      const pVc = await guild.channels.create({
        name: `待機用VC${playerNum}`, type: ChannelType.GuildVoice, parent: env.categoryId,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
          { id: member.id, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] } // 🚨 個人ロールではなくユーザーIDを直接指定
        ]
      });

      const pText = await guild.channels.create({
        name: `📝-${member.displayName}-${gameId}`, 
        type: ChannelType.GuildText, 
        parent: env.categoryId,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: member.id, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: gmBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: assistantBotId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ]
      });

      // 🚨 共通ロールのみ付与する
      await member.roles.add(env.commonRoleId);

      env.playerEnvs.push({ 
        userId: member.id, 
        waitVcId: pVc.id, 
        personalRoleId: '', // 🚨 空文字にしておく（廃村処理でもエラーにならず後方互換性を保ちます）
        personalTextChannelId: pText.id 
      });
    }
    return env;
  }
}
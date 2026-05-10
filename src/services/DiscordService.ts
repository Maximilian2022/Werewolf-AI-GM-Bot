// @ts-nocheck
/**
 * src/services/DiscordService.ts
 * 観戦者権限対応版
 */
import { ChannelType, Guild, GuildMember, PermissionsBitField, OverwriteType, TextChannel, CategoryChannel } from 'discord.js';
import { Logger } from '../utils/logger';
import { GameEnvironment } from '../types';
import { WorkerManager } from '../managers/WorkerManager';

export class DiscordService {
  public static async cleanupAllLegacyResources(guild: Guild): Promise<void> {
    Logger.info('DiscordService', '自動クリーンアップはセキュリティ上スキップ。');
  }

  public static async abandonGameEnvironment(guild: Guild, gameId: string): Promise<void> {
    Logger.warn('DiscordService', `🚮 [${gameId}] 廃村処理を実行...`);
    const category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes(`[${gameId}]`)) as CategoryChannel;
    if (category) {
        const children = guild.channels.cache.filter(c => c.parentId === category.id);
        for (const child of children.values()) await child.delete().catch(() => {});
        await category.delete().catch(() => {});
    }
    const roles = guild.roles.cache.filter(r => r.name.includes(gameId));
    for (const role of roles.values()) await role.delete().catch(() => {});
    Logger.success('DiscordService', `✅ [${gameId}] 抹消完了。`);
  }

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
        
        Logger.info('DiscordService', `📦 [${gameId}] をアーカイブ化しました。`);
    } catch (e) {
        Logger.error('DiscordService', 'アーカイブ化エラー', e);
    }
  }

  /**
   * 🚨 修正: spectators（観戦者配列）を受け取り、霊界へのアクセス権を付与する
   */
  public static async setupGameEnvironment(
    guild: Guild, gameId: string, members: GuildMember[], spectators: GuildMember[], gmBotId: string, assistantBotId: string 
  ): Promise<GameEnvironment> {
    const env: GameEnvironment = { commonRoleId: '', categoryId: '', mainVcId: '', wolfVcId: '', ghostVcId: '', voteChannelId: '', playerEnvs: [] };
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

    const category = await guild.channels.create({ name: `🐺 人狼村 [${gameId}]`, type: ChannelType.GuildCategory, permissionOverwrites: baseOverwrites });
    env.categoryId = category.id;

    // 観戦者用の「表示・接続・発言」許可権限オブジェクト
    const spectatorOverwrites = spectators.map(s => ({
        id: s.id, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak]
    }));

    const commonPromises = [
      { name: '全体議論', type: ChannelType.GuildVoice, key: 'mainVcId', isGhost: false },
      { name: '人狼内通', type: ChannelType.GuildVoice, key: 'wolfVcId', isGhost: false },
      { name: '霊界', type: ChannelType.GuildVoice, key: 'ghostVcId', isGhost: true },
      { name: '投票所', type: ChannelType.GuildText, key: 'voteChannelId', isGhost: false }
    ].map(async (ch) => {
      // 霊界のみ、観戦者の権限設定を合体させる
      const channelOverwrites = ch.isGhost ? [...baseOverwrites, ...spectatorOverwrites] : undefined;
      const created = await guild.channels.create({ 
          name: ch.name, type: ch.type, parent: env.categoryId, permissionOverwrites: channelOverwrites 
      });
      env[ch.key] = created.id;
    });
    await Promise.all(commonPromises);

    const playerSetupPromises = members.map(async (member, index) => {
      const playerNum = index + 1;
      const pRole = await guild.roles.create({ name: `${gameId}-${playerNum}` });
      const pVc = await guild.channels.create({
        name: `待機用VC${playerNum}`, type: ChannelType.GuildVoice, parent: env.categoryId,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
          { id: pRole.id, type: OverwriteType.Role, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] }
        ]
      });
      await member.roles.add([env.commonRoleId, pRole.id]);
      env.playerEnvs.push({ userId: member.id, waitVcId: pVc.id, personalRoleId: pRole.id });
    });
    await Promise.all(playerSetupPromises);
    return env;
  }
}
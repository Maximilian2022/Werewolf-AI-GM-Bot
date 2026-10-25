/**
 * src/regulations/RegulationManager.ts
 * レギュレーション（プリセット＆カスタム）を管理・永続化するシングルトン
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Regulation } from './types.js';
import { PRESET_REGULATIONS } from './presets.js';
import { RoleRegistry } from '../roles/RoleRegistry.js';
import { Logger } from '../utils/logger.js';

export class RegulationManager {
  private static instance: RegulationManager;
  private readonly filePath = path.join(process.cwd(), 'data', 'regulations.json');
  private customRegulations: Regulation[] = [];

  private constructor() {
    this.load();
  }

  public static getInstance(): RegulationManager {
    if (!RegulationManager.instance) {
      RegulationManager.instance = new RegulationManager();
    }
    return RegulationManager.instance;
  }

  public load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.customRegulations = JSON.parse(raw);
      } else {
        this.customRegulations = [];
      }
    } catch (e: any) {
      Logger.error('RegulationManager', 'カスタムレギュレーションの読み込みに失敗しました', e);
      this.customRegulations = [];
    }
  }

  public save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.customRegulations, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (e: any) {
      Logger.error('RegulationManager', 'カスタムレギュレーションの保存に失敗しました', e);
    }
  }

  public getAll(): Regulation[] {
    return [...PRESET_REGULATIONS, ...this.customRegulations];
  }

  public get(id: string): Regulation | undefined {
    return this.getAll().find(r => r.id === id);
  }

  public getByName(name: string): Regulation | undefined {
    return this.getAll().find(r => r.name === name);
  }

  public getByPlayerCount(count: number): Regulation[] {
    return this.getAll().filter(r => r.playerCount === count);
  }

  /**
   * カスタムレギュレーションのバリデーション
   */
  public validate(regulation: Partial<Regulation>): { valid: boolean; error?: string } {
    if (!regulation.name || regulation.name.trim().length === 0) {
      return { valid: false, error: 'レギュレーション名を入力してください。' };
    }
    if (!regulation.roles || Object.keys(regulation.roles).length === 0) {
      return { valid: false, error: '役職を1つ以上設定してください。' };
    }

    const roleRegistry = RoleRegistry.getInstance();
    let totalCount = 0;
    let wolfCount = 0;

    for (const [roleId, count] of Object.entries(regulation.roles)) {
      if (count < 0) return { valid: false, error: `役職人数は0以上である必要があります: ${roleId}` };
      const role = roleRegistry.get(roleId);
      if (!role) {
        return { valid: false, error: `無効な役職が含まれています: ${roleId}` };
      }
      totalCount += count;
      if (role.team === 'werewolf') {
        wolfCount += count;
      }
    }

    if (totalCount < 4) {
      return { valid: false, error: 'プレイヤー人数は最低4人以上必要です。' };
    }
    if (wolfCount === 0) {
      return { valid: false, error: '人狼陣営の役職が最低1人必要です。' };
    }
    if (wolfCount >= totalCount / 2) {
      return { valid: false, error: '人狼の人数が多すぎます（参加者の半数未満にしてください）。' };
    }

    return { valid: true };
  }

  /**
   * カスタムレギュレーションの追加・更新
   */
  public saveCustom(regulation: Regulation): { success: boolean; error?: string } {
    const check = this.validate(regulation);
    if (!check.valid) return { success: false, error: check.error };

    const existingIndex = this.customRegulations.findIndex(r => r.id === regulation.id);
    if (existingIndex >= 0) {
      this.customRegulations[existingIndex] = { ...regulation, isPreset: false };
    } else {
      this.customRegulations.push({ ...regulation, isPreset: false });
    }
    this.save();
    return { success: true };
  }

  /**
   * カスタムレギュレーションの削除
   */
  public deleteCustom(id: string): boolean {
    const prevLen = this.customRegulations.length;
    this.customRegulations = this.customRegulations.filter(r => r.id !== id);
    if (this.customRegulations.length !== prevLen) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * レギュレーションの役職マップを展開し、シャッフル用の役職名リストを生成する
   */
  public expandRoleList(regulation: Regulation): string[] {
    const roleRegistry = RoleRegistry.getInstance();
    const result: string[] = [];

    for (const [roleKey, count] of Object.entries(regulation.roles)) {
      const role = roleRegistry.get(roleKey);
      if (role) {
        for (let i = 0; i < count; i++) {
          result.push(role.name);
        }
      }
    }
    return result;
  }

  /**
   * レギュレーションとプレイヤー情報からAI総評向けの要約テキストを生成する
   */
  public formatSummary(reg?: Regulation, players?: { role?: string | null }[]): string {
    const lines: string[] = [];
    if (reg) {
      lines.push(`・レギュレーション名: ${reg.name}`);
      lines.push(`・参加人数: ${reg.playerCount}人`);
      if (reg.rules) {
        const divinationMap: Record<string, string> = { 
          white_npc: '初日白通知（お告げあり）', 
          free: '初日自由占い', 
          none: 'なし' 
        };
        lines.push(`・初日占い: ${divinationMap[reg.rules.firstNightDivination] || reg.rules.firstNightDivination}`);
        lines.push(`・騎士の連続護衛: ${reg.rules.consecutiveGuard ? 'あり（可能）' : 'なし（不可）'}`);
        lines.push(`・決選同票時の処刑: ${reg.rules.runoffTieBreaker === 'random_execution' ? 'ランダム処刑' : '処刑なし（引き分け）'}`);
        lines.push(`・霊媒結果の発表: ${reg.rules.hasMediumResult ? 'あり' : 'なし'}`);
        lines.push(`・夜の人狼VC会話: ${reg.rules.wolfVoiceChat ? 'あり' : 'なし'}`);
      }
    }

    if (players && players.length > 0) {
      const counts: Record<string, number> = {};
      for (const p of players) {
        if (!p.role) continue;
        const roleDef = RoleRegistry.getInstance().get(p.role as any);
        const roleName = roleDef ? roleDef.name : p.role;
        counts[roleName] = (counts[roleName] || 0) + 1;
      }
      const breakdown = Object.entries(counts)
        .map(([name, count]) => `${name} ${count}名`)
        .join('、');
      lines.push(`・実際の役職内訳: ${breakdown}`);
    } else if (reg && reg.roles) {
      const breakdown = Object.entries(reg.roles)
        .filter(([_, count]) => count > 0)
        .map(([roleId, count]) => {
          const roleDef = RoleRegistry.getInstance().get(roleId as any);
          return `${roleDef ? roleDef.name : roleId} ${count}名`;
        })
        .join('、');
      lines.push(`・想定役職内訳: ${breakdown}`);
    }

    return lines.length > 0 ? lines.join('\n') : '標準的なレギュレーション構成';
  }
}


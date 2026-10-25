/**
 * src/roles/RoleRegistry.ts
 * 全役職の登録・検索・管理を行うシングルトンレジストリ
 */
import { IRole, RoleId } from './types.js';
import { 
  VillagerRole, WerewolfRole, SeerRole, MediumRole, KnightRole, MadmanRole 
} from './definitions/StandardRoles.js';
import { 
  ApprenticeSeerRole, RecklessSeerRole, FoxPossessedRole, UndertakerRole 
} from './definitions/SpecialRoles.js';
import { 
  FoxRole, FanaticRole, MasonRole, NekomataRole, BakerRole, FoolRole 
} from './definitions/ExtendedRoles.js';
import {
  HunterRole, DictatorRole, ToughGuyRole, TrapperRole, CounselorRole,
  LoneWolfRole, LoversRole, GodRole, SpyRole, InformantRole,
  WolfCubRole, ApprenticeDivinerRole, TargetedCivilianRole, BlackCatRole,
  CupidRole, FemmeFataleRole, QueenRole, LivingSpiritRole,
  WolfMinionRole, BerserkWolfRole
} from './definitions/NewRoles.js';

export class RoleRegistry {
  private static instance: RoleRegistry;
  private roles: Map<string, IRole> = new Map();

  private constructor() {
    this.registerDefaults();
  }

  public static getInstance(): RoleRegistry {
    if (!RoleRegistry.instance) {
      RoleRegistry.instance = new RoleRegistry();
    }
    return RoleRegistry.instance;
  }

  private registerDefaults() {
    const defaultRoles: IRole[] = [
      VillagerRole,
      WerewolfRole,
      SeerRole,
      MediumRole,
      KnightRole,
      MadmanRole,
      ApprenticeSeerRole,
      RecklessSeerRole,
      FoxPossessedRole,
      UndertakerRole,
      FoxRole,
      FanaticRole,
      MasonRole,
      NekomataRole,
      BakerRole,
      FoolRole,
      // 新規役職
      HunterRole,
      DictatorRole,
      ToughGuyRole,
      TrapperRole,
      CounselorRole,
      LoneWolfRole,
      LoversRole,
      GodRole,
      SpyRole,
      InformantRole,
      WolfCubRole,
      ApprenticeDivinerRole,
      TargetedCivilianRole,
      BlackCatRole,
      CupidRole,
      FemmeFataleRole,
      QueenRole,
      LivingSpiritRole,
      WolfMinionRole,
      BerserkWolfRole
    ];

    for (const role of defaultRoles) {
      this.register(role);
    }
  }

  public register(role: IRole) {
    this.roles.set(role.id, role);
    this.roles.set(role.name, role); // 日本語名でも引けるように登録
  }

  public get(idOrName: string): IRole | undefined {
    return this.roles.get(idOrName);
  }

  public getOrThrow(idOrName: string): IRole {
    const role = this.get(idOrName);
    if (!role) {
      throw new Error(`未知の役職が指定されました: ${idOrName}`);
    }
    return role;
  }

  public getAll(): IRole[] {
    // 重複（IDと日本語名）を排除してユニークな役職一覧を返す
    const unique = new Map<RoleId, IRole>();
    for (const role of this.roles.values()) {
      unique.set(role.id, role);
    }
    return Array.from(unique.values());
  }

  public isValid(idOrName: string): boolean {
    return this.roles.has(idOrName);
  }
}

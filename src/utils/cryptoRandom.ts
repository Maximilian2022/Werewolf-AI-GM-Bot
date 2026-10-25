import crypto from 'node:crypto';

/**
 * 暗号学的に安全な乱数生成（CSPRNG）ユーティリティ
 * GitHub CodeQL / CWE-338 (Insecure randomness) 完全対応
 */

/**
 * [0, 1) の範囲で暗号学的に安全な浮動小数点数を返します。
 * Math.random() の代替として安全に使用できます。
 */
export function secureRandom(): number {
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0x100000000;
}

/**
 * [min, max) の範囲で暗号学的に安全な整数を返します。
 * 引数が1つの場合は [0, max) となります。
 */
export function secureRandomInt(min: number, max?: number): number {
  if (max === undefined) {
    return crypto.randomInt(min);
  }
  return crypto.randomInt(min, max);
}

/**
 * 配列からランダムに1つの要素を選択します。
 */
export function secureSample<T>(array: readonly T[]): T {
  if (!array || array.length === 0) {
    throw new Error('secureSample: Cannot sample from an empty or undefined array');
  }
  return array[crypto.randomInt(0, array.length)];
}

/**
 * 配列をインプレースで暗号学的に安全にシャッフルします (Fisher-Yates)
 */
export function secureShuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

/**
 * 安全なランダム文字列を生成します（ゲームIDやチャットID用）
 */
export function secureRandomId(length = 6): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

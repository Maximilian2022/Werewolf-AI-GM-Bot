/**
 * src/services/TTSService.ts
 * Google Cloud Text-to-Speech APIを利用して、テキストから音声ファイルを生成するサービスクラス
 * - 音声生成のリクエストとレスポンスの管理、生成された音声ファイルのキャッシュ機能を提供
 * - キャッシュはテキストと使用する音声の組み合わせに基づいてMD5ハッシュを生成し、同じテキストと音声のリクエストがあった場合はAPI呼び出しをスキップしてキャッシュからファイルを提供
 * - 音声ファイルはMP3形式で保存し、Discordの再生互換性を確保
 * - API呼び出しに失敗した場合は、一定回数のリトライを行い、それでも失敗する場合はエラーログを出力して空のファイルパスを返す（再生をスキップして進行するため）
 */
import textToSpeech from '@google-cloud/text-to-speech';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import * as crypto from 'node:crypto';
import { Logger } from '../utils/logger.js';
import { SettingsManager } from '../managers/SettingsManager.js';

export class TTSService {
  // Google Cloud TTSクライアントのインスタンス（シングルトン）
  private static client = new textToSpeech.TextToSpeechClient();
  // キャッシュディレクトリのパス
  private static readonly CACHE_DIR = path.join(process.cwd(), 'data', 'tts_cache');
  // 初期化：キャッシュディレクトリの作成
  public static init() {
    if (!fs.existsSync(this.CACHE_DIR)) fs.mkdirSync(this.CACHE_DIR, { recursive: true });
    // 起動時に静的セリフをプリフェッチ
    this.prefetchStaticAudios();
  }
  // API呼び出しのリトライを行うユーティリティ関数
  private static async fetchAudioWithRetry(request: any, gameId: string, retryCount = 0): Promise<Uint8Array> {
    const MAX_RETRIES = 3;
    try {
      const [response] = await this.client.synthesizeSpeech(request, { timeout: 15000 });
      return response.audioContent as Uint8Array;
    } catch (error: any) {
      if (retryCount < MAX_RETRIES) {
        Logger.warn('TTSService', `⚠️ TTS APIが応答しません(タイムアウト等)。再試行します... (${retryCount + 1}/${MAX_RETRIES})`, gameId);
        await new Promise(r => setTimeout(r, 2000));
        return this.fetchAudioWithRetry(request, gameId, retryCount + 1);
      }
      throw error;
    }
  }
  // 非同期で音声をプリフェッチする（awaitで待たないことでUIを止めない）
  public static async prefetchAudio(text: string): Promise<void> {
    try {
      const sysSettings = SettingsManager.getInstance().getSystem();
      const voiceName = sysSettings.gmVoice || 'ja-JP-Neural2-D';
      const hash = crypto.createHash('md5').update(text + voiceName + 'MP3').digest('hex');
      const cachedFilePath = path.join(this.CACHE_DIR, `${hash}.mp3`);
      
      if (fs.existsSync(cachedFilePath)) return;

      await this.generateAudio(text, 'prefetch', 'prefetch_cache');
    } catch (e) {
      Logger.error('TTSService', 'プリフェッチ失敗', e, 'prefetch');
    }
  }

  // モデル変更時や起動時に静的なセリフを一括でプリフェッチする
  public static prefetchStaticAudios() {
    (async () => {
      try {
        const { MSG } = await import('../messages.js');
        const normalSet = SettingsManager.getInstance().get(false);
        const debugSet = SettingsManager.getInstance().get(true);
        
        const texts = [
          MSG.VOICE.GREETING,
          MSG.VOICE.WOLF_MEET_END,
          MSG.VOICE.DAY_END,
          MSG.VOICE.VOTE_END,
          MSG.VOICE.RUNOFF_START,
          MSG.VOICE.RUNOFF_DEFENSE_END,
          MSG.VOICE.NIGHT_ARRIVE,
          MSG.VOICE.NIGHT_ARRIVE_RESUMED,
          MSG.VOICE.PROMPT_WOLF,
          MSG.VOICE.PROMPT_SEER,
          MSG.VOICE.PROMPT_KNIGHT,
          MSG.VOICE.MORNING_PEACE,
          MSG.VOICE.WIN_EXECUTION_VILLAGER,
          MSG.VOICE.WIN_EXECUTION_WOLF,
          MSG.VOICE.WIN_BITE_WOLF,
          MSG.VOICE.MVP_NEXT,
          ...MSG.VOICE.WORKER_PHRASES,
          
          MSG.VOICE.WOLF_MEET(normalSet.wolfMeetingMin),
          MSG.VOICE.DAY_START(1, normalSet.day1DiscussionMin),
          MSG.VOICE.DAY_START(2, normalSet.day2DiscussionMin),
          MSG.VOICE.WOLF_MEET(debugSet.wolfMeetingMin),
          MSG.VOICE.DAY_START(1, debugSet.day1DiscussionMin),
          MSG.VOICE.DAY_START(2, debugSet.day2DiscussionMin)
        ];

        Logger.info('TTSService', `🔄 静的音声のプリフェッチを開始します (${texts.length}件)...`, 'system');
        for (const text of texts) {
          await this.prefetchAudio(text);
          await new Promise(r => setTimeout(r, 500)); // API制限回避
        }
        Logger.success('TTSService', `✅ 静的音声のプリフェッチが完了しました`, 'system');
      } catch (e) {
        Logger.error('TTSService', '静的音声プリフェッチ全体エラー', e, 'system');
      }
    })();
  }

  // ゲーム開始時にプレイヤー名に依存するセリフを一括でプリフェッチする
  public static prefetchDynamicAudios(playerNames: string[], normalSet: any, debugSet: any) {
    (async () => {
      try {
        const { MSG } = await import('../messages.js');
        const texts: string[] = [];
        
        for (const name of playerNames) {
          texts.push(
            MSG.VOICE.SEER_FIRST(name),
            MSG.VOICE.EXEC_START(name),
            MSG.VOICE.NIGHT_INTRO(name),
            MSG.VOICE.WOLF_TARGET_SET(name),
            MSG.VOICE.KNIGHT_TARGET_SET(name),
            MSG.VOICE.MEDIUM_RESULT(name, true),
            MSG.VOICE.MEDIUM_RESULT(name, false),
            MSG.VOICE.MORNING_KILLED(name),
            MSG.VOICE.MVP_ANNOUNCE_SINGLE('議論MVP', name),
            MSG.VOICE.MVP_ANNOUNCE_SINGLE('勝利貢献MVP', name)
          );
          
          const normalSpeechMinStr = normalSet.speechMin >= 1 ? `${Math.floor(normalSet.speechMin)}分` : `${Math.round(normalSet.speechMin * 60)}秒`;
          const debugSpeechMinStr = debugSet.speechMin >= 1 ? `${Math.floor(debugSet.speechMin)}分` : `${Math.round(debugSet.speechMin * 60)}秒`;
          
          texts.push(
            MSG.VOICE.VOTE_START(name, normalSpeechMinStr),
            MSG.VOICE.VOTE_START(name, debugSpeechMinStr),
            MSG.VOICE.RUNOFF_DEFENSE_START(name, '1分') // 固定で1分としている箇所
          );
        }

        Logger.info('TTSService', `🔄 動的音声のプリフェッチを開始します (${texts.length}件)...`, 'system');
        for (const text of texts) {
          await this.prefetchAudio(text);
          await new Promise(r => setTimeout(r, 300));
        }
        Logger.success('TTSService', `✅ 動的音声のプリフェッチが完了しました`, 'system');
      } catch (e) {
        Logger.error('TTSService', '動的音声プリフェッチ全体エラー', e, 'system');
      }
    })();
  }

  // テキストとゲームIDを受け取り、対応する音声ファイルのパスを返すメイン関数
  public static async generateAudio(text: string, gameId: string, identifier: string): Promise<string> {
    const sysSettings = SettingsManager.getInstance().getSystem();
    const voiceName = sysSettings.gmVoice || 'ja-JP-Neural2-D';

    // 🚨 修正1: ハッシュに 'MP3' を混ぜて過去のOGGキャッシュを完全無視する
    const hash = crypto.createHash('md5').update(text + voiceName + 'MP3').digest('hex');

    // 🚨 修正2: 保存する拡張子を .mp3 に変更
    const cachedFilePath = path.join(this.CACHE_DIR, `${hash}.mp3`);

    if (fs.existsSync(cachedFilePath)) {
      Logger.info('TTSService', `⚡ キャッシュヒット(MP3): [${identifier}]`, gameId);
      return cachedFilePath;
    }

    Logger.info('TTSService', `🌐 APIリクエスト生成(MP3): [${identifier}]`, gameId);

    const request = {
      input: { text: text },
      voice: { languageCode: 'ja-JP', name: voiceName },
      audioConfig: {
        // 🚨 修正3: OGG_OPUS をやめて、Discordが誤解しない MP3 を要求する
        audioEncoding: 'MP3' as const
        // ※MP3ならFFmpegが自動で最適化してくれるため、sampleRateHertz の指定も不要になります
      },
    };

    try {
      const audioContent = await this.fetchAudioWithRetry(request, gameId);
      const writeFile = util.promisify(fs.writeFile);
      await writeFile(cachedFilePath, audioContent, 'binary');
      Logger.success('TTSService', `✅ 新規音声保存完了: ${hash}.mp3`, gameId);
      return cachedFilePath;
    } catch (error) {
      Logger.error('TTSService', '❌ ❌ TTS生成に完全に失敗しました。進行を継続するため再生をスキップします。', error, gameId);
      return '';
    }
  }

}
TTSService.init();
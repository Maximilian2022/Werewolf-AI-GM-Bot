/**
 * src/messages.ts
 * 決選投票アナウンス強化版
 */
export const MSG = {
  // ==========================================
  // テキストチャット用メッセージ
  // ==========================================
  CHAT: {
    SYS_RECOVER: (phase: string) => `🔄 **システム復旧**\nフェーズ \`${phase}\` から再開します。`,
    SYS_START_ROLE: `🎲 役職の配布を開始します。各自、DMを確認してください。`,
    SYS_VOTE_START: (day: number) => `🗳️ **第${day}日 投票フェーズ**\n✋ スタンプを押して発言順を決めてください。`,
    SYS_RUNOFF_START: `⚖️ **【同票発生】決選投票を行います**\n以下のプレイヤーは順に弁明を行ってください。`, 
    SYS_RUNOFF_VOTE_START: (unixTime: number) => `⚖️ **決選投票の受付を開始します**\n対象者以外の方は、<t:${unixTime}:T> までに投票を行ってください。\n⚠️ **制限時間を過ぎた場合、システムが対象者の中からランダムで強制投票します。**`, // 🚨 新規追加
    SYS_EXECUTION: (name: string) => `💀 <@${name}> さんが処刑されました。遺言をどうぞ。`,
    SYS_WIN: (team: string) => `🎉 **${team} の勝利！** 🎉\n\n【役職】\n`,
    
    DM_ROLE_HEADER: `🐺 **【人狼ゲーム進行】**\n`,
    DM_ROLE_YOUR_ROLE: (role: string) => `あなたの役職は **「${role}」** です。\n`,
    DM_ROLE_WOLF_GUIDE: `人狼の内通チャンネルを確認してください。仲間と合流し作戦会議を行ってください。\n`,
    DM_ROLE_SEER_FIRST: (name: string) => `【初日のお告げ】\n**${name}** さんは村人陣営です。\n`,
    DM_ROLE_WAIT: `夜が明けるまで、この部屋でお待ちください。`,
    
    DM_WOLF_PROMPT: `襲撃対象を選択してください。`,
    DM_SEER_PROMPT: `占い対象を選択してください。`,
    DM_KNIGHT_PROMPT: `護衛対象を選択してください。`,
    DM_VOTE_PROMPT: `処刑対象を選択してください。`,
    DM_RUNOFF_VOTE_PROMPT: `決選投票の対象者を選択してください。`, 
    
    DM_WOLF_TARGET_SET: (name: string) => `✅ 襲撃先「**${name}**」でシステムに送信しました。`,
    DM_SEER_RESULT: (isWolf: boolean) => `✅ 結果: **${isWolf ? '人狼陣営でした' : '村人陣営でした'}**`,
    DM_KNIGHT_TARGET_SET: (name: string) => `✅ 「**${name}**」さんを護衛します。`,
    DM_MEDIUM_RESULT: (name: string, isWolf: boolean) => `🔮 霊媒結果: **${name}** さんは **${isWolf ? '人狼陣営でした' : '村人陣営でした'}**`,
    DM_VOTED: (name: string) => `✅ **${name}** さんに投票しました。`,

    DM_TIMEOUT_WOLF: (name: string) => `⚠️ **時間切れ**\nランダムで「**${name}**」を襲撃先に指定しました。`,
    DM_TIMEOUT_VOTE: (name: string) => `⚠️ **時間切れ**\nランダムで「**${name}**」に投票しました。`,
    DM_TIMEOUT_SEER: (name: string, isWolf: boolean) => `⚠️ **時間切れ**\nランダムで「**${name}**」を占いました。\n🔮 占い結果: **${name}** さんは **${isWolf ? '人狼陣営でした' : '村人陣営でした'}**`,
    DM_TIMEOUT_KNIGHT: (name: string) => `⚠️ **時間切れ**\nランダムで「**${name}**」を護衛しました。`,

    DAY_TIMER_START: (day: number, unixTime: number) => `☀️ **第${day}日 昼の議論フェーズ**\n終了時刻: <t:${unixTime}:T> (<t:${unixTime}:R>)\n[████████████████████]`,
    DAY_TIMER_PAUSED: (day: number) => `☀️ **第${day}日 昼の議論フェーズ**\n⏸️ **【一時停止中】**\n進行が再開されるまでタイマーはストップしています。`,
    DAY_TIMER_UPDATE: (day: number, timeText: string, bar: string, m: number, s: string) => `☀️ **第${day}日 昼の議論フェーズ**\n終了時刻: ${timeText}\n[${bar}] (残り ${m}分${s}秒)`,
    DAY_REMAIN_1M: `⚠️ **残り1分です。**`,
    VOICE_STATUS_DISCUSSING: (m: number, s: string) => `🗣️ 議論中 (残り ${m}:${s})`,

    // 人狼内通タイマーUI
    NIGHT_WOLF_TIMER_START: (unixTime: number) => `🐺 **人狼内通フェーズ**\n終了時刻: <t:${unixTime}:T> (<t:${unixTime}:R>)\n[████████████████████]`,
    NIGHT_WOLF_TIMER_UPDATE: (timeText: string, bar: string, m: number, s: string) => `🐺 **人狼内通フェーズ**\n終了時刻: ${timeText}\n[${bar}] (残り ${m}分${s}秒)`,

    // 投票フェーズUI
    VOTE_BUTTON_PROMPT: "👇 以下のボタンを押して発言順を予約してください！",
    VOTE_LOADING: `読み込み中...`,
    VOTE_RESERVE_SUCCESS: `✅ 順番待ちリストに登録しました！あなたの番が来るまでお待ちください。`,
    VOTE_RESERVE_DUPLICATE: `⚠️ 既に順番待ちリストに入っているか、現在あなたの発言ターンです。`,
    VOTE_RESERVE_INVALID: `❌ 既に投票が完了しているか、現在投票できる対象ではありません。`,
    VOTE_UI_HEADER: `### 🗣️ 発言・投票順\n`,
    VOTE_UI_PAUSED: `⏸️ **【一時停止中】**\n進行が再開されるまでお待ちください。`,
    VOTE_UI_DONE: (name: string) => `✅ **${name}** (投票完了)\n`,
    VOTE_UI_NOW: (name: string, note: string, timeText: string) => `▶️ **${name}** (現在発表中 [${note}]・終了まで ${timeText})\n`,
    VOTE_UI_WAITING: (name: string) => `⏳ **${name}** (順番待ち)\n`,
    VOTE_UI_PENDING: (name: string) => `💨 **${name}** (待機中)\n`,
    VOTE_UI_RESULT_HEADER: `\n---\n### 📊 現在の投票状況\n`,
    VOTE_UI_RESULT_FINAL_HEADER: `\n---\n### 📊 最終投票結果\n`,
    VOTE_UI_NO_VOTES: `(まだ投票はありません)\n`,
    VOTE_UI_VOTE_ITEM: (name: string, count: number, voters: string) => `・**${name}** (${count}票): ${voters}\n`,

    // 決選投票 弁明UI
    RUNOFF_DEFENSE_START: (name: string, unixTime: number) => `🗣️ **${name}さんの弁明タイム**（終了まで <t:${unixTime}:R>）`,
    RUNOFF_DEFENSE_PAUSED: (name: string) => `🗣️ **${name}さんの弁明タイム**\n⏸️ **【一時停止中】**`,
    RUNOFF_DEFENSE_UPDATE: (name: string, timeText: string) => `🗣️ **${name}さんの弁明タイム**${timeText}`,
    
    // 🚨 新規追加：決選投票 開票UI
    RUNOFF_UI_RESULT_FINAL_HEADER: `\n---\n### ⚖️ 決選投票 最終開票結果\n`,

    // 遺言UI
    EXEC_LAST_WORD_START: (name: string, unixTime: number) => `💀 **${name}さんの遺言タイム**（終了まで <t:${unixTime}:R>）`,
    EXEC_LAST_WORD_PAUSED: (name: string) => `💀 **${name}さんの遺言タイム**\n⏸️ **【一時停止中】**`,
    EXEC_LAST_WORD_UPDATE: (name: string, timeText: string) => `💀 **${name}さんの遺言タイム**${timeText}`,
    EXEC_LAST_WORD_END: (name: string) => `💀 **${name}さんの遺言終了**`,

    // 朝・終了UI
    MORNING_ANNOUNCE: (day: number, text: string) => `☀️ **【第${day}日 朝】**\n${text}`,
    MVP_ANALYZING: `🤖 録音データを解析中...`,
    MVP_RESULT: (name: string, text: string) => `🏆 **【本日のMVP】 ${name} さん** 🏆\n\n**【AI講評】**\n${text}`,
    MVP_ERROR: (gameId: string) => `❌ MVP解析にエラーが発生しました。後ほど \`/再解析 ゲームid:${gameId}\` を実行してください。`,
  },

  // ==========================================
  // 音声読み上げ(TTS)用セリフ
  // ==========================================
  VOICE: {
    GREETING: `これより、人狼ゲームを開始します。各自の待機部屋へこちらで移動させたのち、役職配布を開始いたします。それでは、いってらっしゃいませ！`,
    SEER_FIRST: (name: string) => `初日のお告げです。${name}さんは、村人陣営です。`,
    WOLF_MEET: (min: number) => `人狼の皆様、${min}分間の作戦会議です。スタート。`,
    DAY_START: (day: number, min: number) => `第${day}日目の議論時間は、${min}分間です。それでは、議論を開始してください。`,
    DAY_END: `議論終了です。投票フェーズへ移行します。`,
    VOTE_START: (name: string, timeStr: string) => `${name}さんの発言時間です。${timeStr}間です、どうぞ。`,
    VOTE_END: `全員の投票が完了しました。これより、開票を行います。`,
    
    // 決選投票用のセリフ
    RUNOFF_START: `最多得票者が複数いらっしゃるため、これより決選投票を行います。対象者をランダムで選定し、1分間ずつ弁明をしていただきます。`,
    RUNOFF_DEFENSE_START: (name: string, timeStr: string) => `${name}さんの弁明時間です。時間は${timeStr}です、どうぞ。`, // 🚨 引数拡張
    RUNOFF_DEFENSE_END: `終了です。`,
    RUNOFF_VOTE_PROMPT: (timeStr: string) => `それでは、対象者以外の方は、${timeStr}以内に投票を行ってください。時間を過ぎますと、システムが対象者の中からランダムで強制投票を行います。`, // 🚨 警告文面を統合

    EXEC_START: (name: string) => `${name}さんが処刑されます。遺言をどうぞ。`,
    NIGHT_INTRO: (name: string) => `${name}さんが処刑され、夜が・・・`,
    NIGHT_ARRIVE: `やってきます。個別部屋へ移動します。`,
    NIGHT_ARRIVE_RESUMED: `中断再開のため1分延長します。`,
    
    PROMPT_WOLF: `内通時間終了です。人狼の皆様、今夜襲撃する対象を選択してください。`,
    PROMPT_SEER: `占い師の方、今夜占う対象を選択してください。`,
    PROMPT_KNIGHT: `騎士の方、今夜護衛する対象を選択してください。`,

    WOLF_TARGET_SET: (name: string) => `襲撃先は、${name}さんですね。`,
    SEER_RESULT: (isWolf: boolean) => `結果は、${isWolf ? '人狼陣営でした' : '村人陣営でした'}。`,
    KNIGHT_TARGET_SET: (name: string) => `${name}さんを護衛します。`,
    MEDIUM_RESULT: (name: string, isWolf: boolean) => `霊媒結果をお伝えします。処刑された${name}さんは、${isWolf ? '人狼陣営でした' : '村人陣営でした'}。`,
    
    MORNING_KILLED: (name: string) => `おはようございます。昨晩の犠牲者は・・・${name}さんでした。`,
    MORNING_PEACE: `おはようございます。昨晩の犠牲者は・・・いませんでした。`,
    
    WIN_EXECUTION_VILLAGER: `やってきません。人狼陣営がいなくなったため、村人陣営の勝利です。`,
    WIN_EXECUTION_WOLF: `やってきません。人狼陣営と村人陣営の数が同数となったため、人狼陣営の勝利です。`,
    WIN_BITE_WOLF: `昼議論はありません。現在、人狼陣営と村人陣営の数が同数となったため、人狼陣営の勝利です！`,
    
    MVP_NEXT: `それではこれより、Gemini AIによるMVP選出を行います。少々お待ちください。`,
    MVP_ANNOUNCE: (name: string) => `本日のMVPは${name}さんです！お疲れ様でした。`,
    
    WORKER_PHRASES: [
      "なるほど、そう来ましたか。",
      "確かに、その推理は一理ありますね。",
      "うーん、なんか怪しい気がしてきました。",
      "僕はただの村人ですよ、信じてください！",
      "それって本当ですか？証拠はありますか？",
      "もう少し議論を深めましょう。",
      "誰に投票するか、すごく迷いますね。",
      "何か役職の方、そろそろ出てきませんか？",
      "今の発言、ちょっと気になりますね。",
      "皆さん、騙されないように気を付けてください！"
    ]
  }
};
/**
 * src/messages.ts
 * ゲーム内で使用されるすべてのテキストメッセージを一元管理するファイル
 */
export const MSG = {
  // ==========================================
  // テキストチャット用メッセージ
  // ==========================================
  CHAT: {
    SYS_RECOVER: (phase: string) => `🔄 **システム復旧**\nフェーズ \`${phase}\` から再開します。`,
    SYS_START_ROLE: `🎲 役職の配布を開始します。各自の専用テキストチャンネルを確認してください。`,
    SYS_VOTE_START: (day: number) => `🗳️ **第${day}日 投票フェーズ**\n✋ スタンプを押して発言順を決めてください。`,
    SYS_RUNOFF_START: `⚖️ **【同票発生】決選投票を行います**\n以下のプレイヤーは順に弁明を行ってください。`, 
    SYS_RUNOFF_VOTE_START: (unixTime: number) => `⚖️ **決選投票の受付を開始します**\n対象者以外の方は、<t:${unixTime}:T> までに投票を行ってください。\n⚠️ **制限時間を過ぎた場合、システムが対象者の中からランダムで強制投票します。**`, // 🚨 新規追加
    SYS_EXECUTION: (name: string) => `💀 <@${name}> さんが処刑されました。遺言をどうぞ。`,
    SYS_EXECUTION_NONE: `⚖️ 投票の結果、全員が0票だったため、本日の処刑は行われませんでした。`,
    SYS_WIN: (team: string) => `🎉 **${team} の勝利！** 🎉\n\n【役職】\n`,
    
    DM_ROLE_HEADER: `🐺 **【人狼ゲーム進行】**\n`,
    DM_ROLE_YOUR_ROLE: (role: string) => `あなたの役職は **「${role}」** です。\n`,
    DM_ROLE_WOLF_GUIDE: `人狼の内通チャンネルを確認してください。仲間と合流し作戦会議を行ってください。\n`,
    DM_ROLE_SEER_FIRST: (name: string) => `【初日のお告げ】\n**${name}** さんは村人陣営です。\n`,
    DM_ROLE_WAIT: `夜が明けるまで、この部屋でお待ちください。`,
    
    DM_WOLF_PROMPT: `襲撃対象を選択してください。`,
    WOLF_PROMPT: `🐺 **襲撃先決定**\n今夜襲撃する対象を選択してください。`,
    DM_SEER_PROMPT: `占い対象を選択してください。`,
    DM_KNIGHT_PROMPT: `護衛対象を選択してください。`,
    DM_VOTE_PROMPT: `処刑対象を選択してください。`,
    DM_RUNOFF_VOTE_PROMPT: `決選投票の対象者を選択してください。`, 
    
    DM_WOLF_TARGET_SET: (name: string) => `✅ 襲撃先「**${name}**」でシステムに送信しました。`,
    WOLF_TARGET_SET: (voterId: string, name: string) => `🎯 <@${voterId}> さんが襲撃先に「**${name}**」を選択しました。`,
    DM_SEER_RESULT: (isWolf: boolean) => `✅ 結果: **${isWolf ? '人狼でした' : '人狼ではありませんでした'}**`,
    DM_KNIGHT_TARGET_SET: (name: string) => `✅ 「**${name}**」さんを護衛します。`,
    DM_MEDIUM_RESULT: (name: string, isWolf: boolean) => `🔮 霊媒結果: **${name}** さんは **${isWolf ? '人狼でした' : '人狼ではありませんでした'}**`,
    DM_VOTED: (name: string) => `✅ **${name}** さんに投票しました。`,

    DM_TIMEOUT_WOLF: (name: string) => `⚠️ **時間切れ**\nランダムで「**${name}**」を襲撃先に指定しました。`,
    DM_TIMEOUT_VOTE: (name: string) => `⚠️ **時間切れ**\nランダムで「**${name}**」に投票しました。`,
    DM_TIMEOUT_SEER: (name: string, isWolf: boolean) => `⚠️ **時間切れ**\nランダムで「**${name}**」を占いました。\n🔮 占い結果: **${name}** さんは **${isWolf ? '人狼でした' : '人狼ではありませんでした'}**`,
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
    VOTE_BUTTON_PROMPT: "👇 以下のボタンから発言順の予約、または投票を行ってください！",
    VOTE_LOADING: `読み込み中...`,
    VOTE_RESERVE_SUCCESS: `✅ 順番待ちリストに登録しました！あなたの番が来るまでお待ちください。`,
    VOTE_RESERVE_CANCEL: `✅ 順番待ちリストから登録を解除しました。`,
    VOTE_RESERVE_DUPLICATE: `⚠️ 既に順番待ちリストに入っているか、現在あなたの発言ターンです。`,
    VOTE_RESERVE_NOT_FOUND: `⚠️ あなたは順番待ちリストに登録されていません。`,
    VOTE_RESERVE_INVALID: `❌ 既に投票が完了しているか、現在投票できる対象ではありません。`,
    VOTE_END_TURN_SUCCESS: `✅ 発言ターンを終了しました。`,
    VOTE_NOT_YOUR_TURN: `❌ 現在はあなたの発言ターンではありません。`,
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
    MVP_RESULT_SINGLE: (title: string, name: string, text: string) => `🏆 **【${title}】 ${name} さん** 🏆\n\n**【AI講評】**\n${text}`,
    MVP_RESULT_DOUBLE: (name1: string, name2: string, text: string) => `🏆 **【議論MVP】 ${name1} さん** 🏆\n🏆 **【勝利貢献MVP】 ${name2} さん** 🏆\n\n**【AI講評】**\n${text}`,
    MVP_ERROR: (gameId: string) => `❌ MVP解析にエラーが発生しました。後ほど \`/再解析 ゲームid:${gameId}\` を実行してください。`,

    // 退席・帰還UI
    NIGHT_AWAY_PROMPT: `☕ トイレ等で離席される場合は、下のボタンを押してください。全員が帰還するまで夜は明けません。`,
    NIGHT_AWAY_SUCCESS: `☕ 退席中として記録しました。1分ごとにDMにリマインドを送ります。`,
    NIGHT_AWAY_RETURN_SUCCESS: `🏠 お帰りなさい！帰還として記録しました。`,
    NIGHT_AWAY_NOT_AWAY: `❌ あなたは退席中ではありません。`,
    // 新規役職用DM・通知
    DM_TRAPPER_PROMPT: `🪤 罠を仕掛ける対象を選択してください。`,
    DM_COUNSELOR_PROMPT: `🩺 カウンセリングを行う対象を選択してください。`,
    DM_SPY_PROMPT: `🕵️ 能力を妨害する対象を選択してください（役職ごとにゲーム中1回のみ）。`,
    DM_HUNTER_PROMPT: `🏹 万一今夜襲撃された場合に道連れにする対象を選択してください。`,
    DM_CUPID_PROMPT: `💘 恋人にする2名を選択してください。`,
    DM_FEMME_FATALE_PROMPT: `💋 本命1名と手玉を選択してください。`,
    DM_LIVING_SPIRIT_PROMPT: `👻 憑依する対象を1名選択してください。`,
    DM_GOD_INFO: (rolesList: string) => `👁️ **【全知全能のお告げ】**\n村の全役職の内訳は以下の通りです:\n${rolesList}`,
    DM_QUEEN_INFO: (queenName: string) => `👑 この村の女王は **${queenName}** さんです。命に代えてもお守りください。`,
    DM_MASON_INFO: (partnerName: string) => `🤝 あなたの共有者パートナーは **${partnerName}** さんです。`,
    DM_LOVERS_INFO: (partnerName: string) => `💕 あなたと **${partnerName}** さんは恋人になりました。どちらかが死亡すると後を追って死亡します。2人で生き残りを目指してください。`,
    DM_SPY_BLOCKED: `⚠️ 何者かの妨害により、今夜は能力を発動できませんでした。`,
    DM_TOUGH_GUY_ATTACKED: `🩸 あなたは人狼に襲撃されましたが、強靭な肉体で耐え抜きました。しかし毒が回り、今夜の個別部屋で息絶えます。`,
    DM_TARGETED_CIVILIAN_INFECTED: `🐺 あなたは人狼の襲撃を受けましたが、人狼の血に目覚め人狼化しました！今夜から人狼VCに参加できます。`,
    DM_COUNSELOR_REFORMED: `✨ あなたのカウンセリングにより、裏切り者の心が浄化され「村人」に更生しました！`,
    DM_COUNSELOR_TARGET_REFORMED: `🕊️ あなたはカウンセラーによって更生され、村人陣営の「村人」になりました！`,
    DM_LIVING_SPIRIT_INHERITED: (roleName: string) => `👻 憑依対象が死亡したため、あなたは「**${roleName}**」の役職・能力を引き継ぎました！`,
    DICTATOR_BUTTON_LABEL: `👑 独裁者CO（即時処刑）`,
    DICTATOR_CO_ANNOUNCE: (name: string) => `👑 <@${name}> さんが **独裁者CO** を行いました！議論を強制終了し、独断で即時処刑者を決定します。`,
    HUNTER_EXEC_PROMPT: `🏹 道連れにする対象を選択してください。`
  },

  // ==========================================
  // 音声読み上げ(TTS)用セリフ
  // ==========================================
  VOICE: {
    GREETING: `これより、人狼ゲームを開始します。各自の待機部屋へこちらで移動させたのち、役職配布を開始いたします。それでは、いってらっしゃいませ！`,
    REGULATION_ANNOUNCE: (params: { playerCount: number; rolesSummary: string; rulesSummary?: string; day1DiscussionMin: number; }) => {
      let text = `これより、人狼ゲームを開始します。本日のレギュレーションを発表します。`;
      text += `参加人数は、${params.playerCount}名。`;
      text += `役職構成は、${params.rolesSummary}です。`;
      if (params.rulesSummary) {
        text += `${params.rulesSummary}。`;
      }
      text += `第1日目の昼の議論時間は、${params.day1DiscussionMin}分間です。`;
      text += `各自の待機部屋へこちらで移動させたのち、役職配布を開始いたします。それでは、いってらっしゃいませ！`;
      return text;
    },
    SEER_FIRST: (name: string) => `初日のお告げです。${name}さんは、村人陣営です。`,
    WOLF_MEET: (min: number) => `人狼の皆様、${min}分間の作戦会議です。スタート。`,
    WOLF_MEET_END: `内通時間終了です。夜が明けるまでしばらくお待ちください。`,
    DAY_START: (day: number, min: number) => `第${day}日目の議論時間は、${min}分間です。それでは、議論を開始してください。`,
    DAY_END: `議論終了です。投票フェーズへ移行します。`,
    VOTE_START: (name: string, timeStr: string) => `${name}さんの発言時間です。${timeStr}間です、どうぞ。`,
    VOTE_END: `全員の投票が完了しました。これより、開票を行います。`,
    HAND_RAISE_WARNING: `この音声が終了するまでに挙手がなかった場合、ランダムに選出されます。`,
    VOTE_TIMEOUT_WARNING: `この音声が終了するまでに投票がなかった場合、ランダムに選択されます。`,
    
    // 決選投票用のセリフ
    RUNOFF_START: `最多得票者が複数いらっしゃるため、これより決選投票を行います。対象者をランダムで選定し、1分間ずつ弁明をしていただきます。`,
    RUNOFF_DEFENSE_START: (name: string, timeStr: string) => `${name}さんの弁明時間です。時間は${timeStr}です、どうぞ。`, // 🚨 引数拡張
    RUNOFF_DEFENSE_END: `終了です。`,
    RUNOFF_VOTE_PROMPT: (timeStr: string) => `それでは、対象者以外の方は、${timeStr}以内に投票を行ってください。時間を過ぎますと、システムが対象者の中からランダムで強制投票を行います。`, // 🚨 警告文面を統合

    EXEC_NONE: `投票の結果、全員0票だったため、本日の処刑はありませんでした。`,
    EXEC_START: (name: string) => `${name}さんが処刑されます。遺言をどうぞ。`,
    NIGHT_INTRO_NONE: `処刑は行われず、夜が・・・`,
    NIGHT_INTRO: (name: string) => `${name}さんが処刑され、夜が・・・`,
    NIGHT_ARRIVE: `やってきます。個別部屋へ移動します。`,
    NIGHT_ARRIVE_RESUMED: `中断再開のため1分延長します。`,
    
    PROMPT_WOLF: `内通時間終了です。人狼の皆様、今夜襲撃する対象を選択してください。`,
    PROMPT_WOLF_DOUBLE: `今夜は2回襲撃が可能です。襲撃する対象を2名選択してください。`,
    PROMPT_SEER: `占い師の方、今夜占う対象を選択してください。`,
    PROMPT_KNIGHT: `騎士の方、今夜護衛する対象を選択してください。`,
    PROMPT_APPRENTICE_SEER: `未熟な占い師の方、今夜占う対象と予想を選択してください。`,
    PROMPT_RECKLESS_SEER: `無謀な占い師の方、今夜占う対象を選択してください。`,
    PROMPT_FOX_POSSESSED: `狐憑きの方、今夜加護を与える対象を選択してください。`,
    PROMPT_UNDERTAKER: `棺桶屋の方、明日処刑される人物を予想してください。`,
    PROMPT_TRAPPER: `罠師の方、今夜罠を仕掛ける対象を選択してください。`,
    PROMPT_COUNSELOR: `カウンセラーの方、今夜更生を試みる対象を選択してください。`,
    PROMPT_SPY: `スパイの方、今夜能力を妨害する対象を選択してください。`,
    PROMPT_HUNTER: `ハンターの方、万一の際に道連れにする対象を事前選択してください。`,
    PROMPT_CUPID: `キューピットの方、運命の赤い糸で結ぶ2名を選択してください。`,
    PROMPT_FEMME_FATALE: `悪女の方、本命1名と手玉を選択してください。`,
    PROMPT_LIVING_SPIRIT: `生霊の方、憑依する対象を1名選択してください。`,

    PROMPT_APPRENTICE_DIVINER_AWAKENED: `師匠の占い師が死亡したため、占いの力が覚醒しました。今夜占う対象を選択してください。`,

    WOLF_TARGET_SET: (name: string) => `襲撃先は、${name}さんですね。`,
    WOLF_TARGET_SET_DOUBLE: (name1: string, name2: string) => `襲撃先は、${name1}さんと、${name2}さんですね。`,
    SEER_RESULT: (isWolf: boolean) => `結果は、${isWolf ? '人狼でした' : '人狼ではありませんでした'}。`,
    APPRENTICE_SEER_RESULT: (isWolf: boolean, isCorrect: boolean) => `結果は、${isWolf ? '人狼でした' : '人狼ではありませんでした'}。予想は、${isCorrect ? '的中しました' : '外れてしまいました'}。`,
    KNIGHT_TARGET_SET: (name: string) => `${name}さんを護衛します。`,
    FOX_PROTECT_SET: (name: string) => `${name}さんに狐の加護を与えます。`,
    UNDERTAKER_TARGET_SET: (name: string) => `明日処刑される人物を、${name}さんと予想しました。`,
    TRAPPER_TARGET_SET: (name: string) => `${name}さんに罠を仕掛けました。`,
    COUNSELOR_TARGET_SET: (name: string) => `${name}さんにカウンセリングを行います。`,
    SPY_TARGET_SET: (name: string) => `${name}さんの能力を妨害します。`,
    HUNTER_TARGET_SET: (name: string) => `万一の道連れ先として、${name}さんを指定しました。`,
    CUPID_TARGET_SET: (name1: string, name2: string) => `${name1}さんと${name2}さんを恋人として結びつけました。`,
    FEMME_FATALE_TARGET_SET: (name: string) => `${name}さんを本命として選びました。`,
    LIVING_SPIRIT_TARGET_SET: (name: string) => `${name}さんに憑依しました。`,
    MEDIUM_RESULT: (name: string, isWolf: boolean) => `霊媒結果をお伝えします。処刑された${name}さんは、${isWolf ? '人狼でした' : '人狼ではありませんでした'}。`,
    
    // 独裁者・特殊能力発動セリフ
    DICTATOR_CO: `独裁者が名乗り出ました。独裁者による即時処刑が行われます。`,
    DICTATOR_EXEC: (name: string) => `独裁者の命により、${name}さんが処刑されます。遺言をどうぞ。`,
    HUNTER_SHOOT: (name: string) => `銃声が響き渡りました。ハンターの道連れにより、${name}さんが息絶えました。`,
    BLACK_CAT_REVENGE: (name: string) => `黒猫の呪いにより、${name}さんが道連れになりました。`,
    QUEEN_DIED: `女王が崩御されました。市民陣営は深い悲しみにより全滅しました。`,
    QUEEN_INHERITED: (name: string) => `生霊が女王の遺志を継ぎ、新たな女王となりました。市民の全滅は免れました。`,
    WOLF_CUB_ENRAGED: `人狼の子どもの死により、狼たちが激怒しています。今夜の襲撃は2回となります。`,
    LOVERS_FOLLOW: (name: string) => `愛する者の死に絶望し、恋人の${name}さんが後を追って息絶えました。`,

    MORNING_KILLED: (name: string) => `おはようございます。昨晩の犠牲者は・・・${name}さんでした。`,
    MORNING_PEACE: `おはようございます。昨晩の犠牲者は・・・いませんでした。`,
    
    WIN_EXECUTION_VILLAGER: `やってきません。人狼陣営がいなくなったため、村人陣営の勝利です。`,
    WIN_EXECUTION_WOLF: `やってきません。人狼陣営と村人陣営の数が同数となったため、人狼陣営の勝利です。`,
    WIN_BITE_WOLF: `昼議論はありません。現在、人狼陣営と村人陣営の数が同数となったため、人狼陣営の勝利です！`,
    WIN_LOVERS: `愛はすべてを超越しました。恋人陣営の勝利です！`,
    WIN_LONE_WOLF: `群れを離れし孤高の狼、一匹狼の単独勝利です！`,
    WIN_GOD: `全知全能の傍観者、神様の単独勝利です！`,
    WIN_FOOL: `てるてる坊主が処刑されました。てるてる坊主の単独勝利です！`,
    WIN_UNDERTAKER: `棺桶が二つ売れました。棺桶屋の単独勝利です！`,
    WIN_FOX: `人狼と人間の争いの果てに、妖狐が生き残りました。妖狐陣営の勝利です！`,
    
    MVP_NEXT: `それではこれより、Gemini AIによるMVP選出を行います。少々お待ちください。`,
    MVP_ANNOUNCE_SINGLE: (title: string, name: string) => `本日の${title}は、${name}さんです！お疲れ様でした。`,
    MVP_ANNOUNCE_DOUBLE: (name1: string, name2: string) => `本日の議論MVPは${name1}さん、勝利貢献MVPは${name2}さんです！お疲れ様でした。`,

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
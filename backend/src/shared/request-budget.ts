/**
 * **リクエスト予算の唯一の出典**。backend のリトライ梯子と、frontend の
 * クライアント側デッドラインを 1 箇所で結び付ける。
 *
 * ── なぜこのファイルが要るのか ──
 * v1.1.0 で「非ストリーミング経路にクライアント締め切りを入れる」ことをしたが、
 * 締め切りの値は backend の梯子を数えずに手で置いた定数だった。結果として
 * **クライアントの方が先に諦める**組み合わせが 4 つ生まれていた:
 *
 *   /api/chat         : クライアント 120 秒 / backend 最悪 240 秒
 *   /api/chat/enrich  : クライアント  90 秒 / backend 最悪 120 秒
 *   /api/extract-facts: クライアント  90 秒 / backend 最悪 120 秒
 *   /api/chat(日本語入力): クライアント 120 秒 / backend 最悪 120 秒(同値 = 競走)
 *
 * この状態だと「**遅いだけで健全なターン**」がクライアント側で打ち切られ、
 * ApiError(504, TIMEOUT) として通信エラー扱いになる。会話ループは連続失敗を
 * 数えていて 3 回で会話を止めるので、8GB 機のコールドロードが重なった日は
 * 「3 ターンで勝手に会話が終わる」ことになる。**クライアントの締め切りは
 * backend が自分で諦めるより必ず後に来なければならない**。
 *
 * したがって締め切りは**数えて導く**。ここで
 *   1) Ollama 1 回あたりの予算
 *   2) 各ルートが何回まで Ollama を呼ぶか(= 梯子)
 * を宣言し、そこから最悪値とクライアント締め切りを**計算**する。
 * リトライ回数や first-token 予算を触る人は、ここを直せば両側が揃う。
 * ズレは `request-budget.test.ts` が落として教える。
 *
 * **このファイルは node/DOM の API を一切使わないこと**(backend と frontend の
 * 両方から読むため。llm-models.ts と同じ制約)。
 */

/**
 * Ollama 1 回の呼び出しに与える first-token 予算。
 *
 * 非ストリーミング(`stream:false`)では最初のトークンを観測できないので、
 * 実質「その 1 回の呼び出し全体のデッドライン」として効く
 * (`services/ollama.ts` の deadlineMs を参照)。
 */
export const OLLAMA_BUDGET_MS = {
  /** /api/chat 本体。640 トークンの一括生成 + コールドロードを見込む。 */
  chat: 90_000,
  /** /api/chat/opening。セッション最初の呼び出しで必ずコールドロードを踏む。 */
  opening: 90_000,
  /** ストリーミングの first-token(生成開始後は stall 予算 15 秒が見る)。 */
  chatStream: 60_000,
  /** ストリーミングの opening は非ストリーミング同様コールドロード込み。 */
  openingStream: 90_000,
  /** 翻訳(ja→en / en→ja)。numPredict 300 の単発。 */
  translation: 60_000,
  /** enrich(日本語訳 + 添削 + 単語の JSON)。 */
  enrich: 60_000,
  /** 要約。 */
  summarize: 60_000,
  /** 事実抽出。 */
  extractFacts: 60_000,
} as const

/**
 * 各ルートが Ollama を最大何回叩くか。
 *
 * ⚠️ ここは「リトライ梯子の長さ」であって「失敗時に何回やり直すか」ではない。
 * TIMEOUT はその場で 503 になり梯子を降りないが、**JSON が壊れた**ときは
 * もう 1 本フル生成する。よって最悪値は「全部の attempt が予算いっぱい使う」。
 */
export const OLLAMA_ATTEMPTS = {
  /** routes/chat.ts chatAttempts(): 初回 + 保守的リトライ。 */
  chat: 2,
  /** routes/chat.ts openingAttempts(): 同上。 */
  opening: 2,
  /** services/translation.ts translateToNaturalEnglish(): 温度を下げて 1 回だけ再試行。 */
  translation: 2,
  /** services/translation.ts translateEnglishToJapanese(): リトライ無し。 */
  translationEnToJa: 1,
  /** routes/extract-facts.ts EXTRACT_FACTS_ATTEMPTS: 2 回目は予算を広げる。 */
  extractFacts: 2,
  /** routes/summarize.ts: 単発。 */
  summarize: 1,
  /** chat-stream.ts buildEnrichment(): JSON 生成は 1 回。 */
  enrich: 1,
} as const

/**
 * backend が 1 リクエストで費やしうる**最悪時間**(ms)。
 * 「全部の attempt が予算いっぱい使い、さらに後追いの補完も予算いっぱい使う」場合。
 */
export const BACKEND_WORST_CASE_MS = {
  /**
   * POST /api/chat(通常ターン)。
   * 会話 LLM を最大 2 回 + `reply_ja` が空だったときの en→ja 補完 1 回。
   * = 90 × 2 + 60 = 240 秒。
   */
  chat: OLLAMA_BUDGET_MS.chat * OLLAMA_ATTEMPTS.chat + OLLAMA_BUDGET_MS.translation,
  /**
   * POST /api/chat(mode = japanese_help / mixed)。
   * 会話経路には入らず翻訳経路だけを通る = 60 × 2 = 120 秒。
   * ⚠️ **同じ URL** なのでクライアント側は区別できない。/api/chat の
   * クライアント締め切りは下の chatRoute(両者の最大)から導く。
   */
  chatTranslate: OLLAMA_BUDGET_MS.translation * OLLAMA_ATTEMPTS.translation,
  /** POST /api/chat/opening。chat と同じ構成。 */
  opening: OLLAMA_BUDGET_MS.opening * OLLAMA_ATTEMPTS.opening + OLLAMA_BUDGET_MS.translation,
  /**
   * POST /api/chat/enrich。
   * enrich の JSON 生成 1 回 + 日本語訳が空だったときの en→ja 補完 1 回
   * (「日本語訳を必ず表示」は製品上の約束なので必ず後追いする)。
   * = 60 + 60 = 120 秒。**ユーザーに見える「日本語訳を再取得」ボタンがこの経路**。
   */
  enrich:
    OLLAMA_BUDGET_MS.enrich * OLLAMA_ATTEMPTS.enrich +
    OLLAMA_BUDGET_MS.translation * OLLAMA_ATTEMPTS.translationEnToJa,
  /** POST /api/summarize。単発 = 60 秒。 */
  summarize: OLLAMA_BUDGET_MS.summarize * OLLAMA_ATTEMPTS.summarize,
  /** POST /api/extract-facts。2 回 = 120 秒。 */
  extractFacts: OLLAMA_BUDGET_MS.extractFacts * OLLAMA_ATTEMPTS.extractFacts,
} as const

/** 同じ URL に複数のモードがあるルートの最悪値(クライアントはモードを区別できない)。 */
export const CHAT_ROUTE_WORST_CASE_MS = Math.max(
  BACKEND_WORST_CASE_MS.chat,
  BACKEND_WORST_CASE_MS.chatTranslate,
)

/**
 * 音声認識(POST /api/transcribe)に backend 側で与える予算。
 *
 * ここだけ Ollama ではなく whisper.cpp の子プロセスなので別立てにする。
 * 内訳(8GB / M1 の悲観値):
 *   ffmpeg で WAV 変換                        〜 5 秒
 *   1 パス目(language=auto)                  〜 50 秒
 *   ハングル誤判定の救済で最大 2 パス追加      〜 100 秒
 *   = 実測の悲観見積りで約 155 秒。3 倍近い余裕を見て 180 秒に切る。
 *
 * **短くしないこと**。転写は毎ターン必ず通る唯一の経路で、ここで健全な
 * 発話を打ち切ると会話が成立しなくなる。逆に無制限だと、whisper の子が
 * 詰まったときにマイクを閉じたまま永久に「認識中」になる(v1.1.0 の実態)。
 */
export const TRANSCRIBE_BUDGET_MS = 180_000

/**
 * クライアント締め切りに乗せる余裕。
 *
 * backend が自分の予算で諦めてから、503 / 502 を組み立てて localhost の
 * ソケットに書き終わるまでの時間を吸収する。実際には数ミリ秒だが、
 * **ここが 0 だと「backend が諦めた瞬間」と「クライアントが諦める瞬間」が
 * 同着になり、どちらが勝つかが運になる**(日本語入力経路が実際にその状態だった)。
 * 30 秒は「絶対に競走にならない」ことを目で確かめられる大きさとして選んだ値で、
 * ユーザー体験には影響しない(backend が生きていれば必ず先に返る)。
 */
export const CLIENT_DEADLINE_MARGIN_MS = 30_000

/**
 * frontend の `fetch` に張るデッドライン(ms)。**必ず backend の最悪値より長い**。
 *
 * これは「backend が生きていれば絶対に発火しない」保険であって、UX の
 * 待ち時間を決める値ではない。狙いは**半開きソケット**(スリープ復帰で TCP が
 * 切れたことに気づかず read が返らない)だけ。だから長くて構わない —
 * 短くすると健全なターンを殺し、連続失敗としてカウントされる。
 */
export const CLIENT_DEADLINE_MS = {
  /** POST /api/chat(通常 240 秒 / 日本語入力 120 秒の大きい方)+ 余裕 = 270 秒。 */
  chat: CHAT_ROUTE_WORST_CASE_MS + CLIENT_DEADLINE_MARGIN_MS,
  /** POST /api/chat/opening = 240 + 30 = 270 秒。 */
  opening: BACKEND_WORST_CASE_MS.opening + CLIENT_DEADLINE_MARGIN_MS,
  /** POST /api/chat/enrich = 120 + 30 = 150 秒。 */
  enrich: BACKEND_WORST_CASE_MS.enrich + CLIENT_DEADLINE_MARGIN_MS,
  /** POST /api/summarize = 60 + 30 = 90 秒。 */
  summarize: BACKEND_WORST_CASE_MS.summarize + CLIENT_DEADLINE_MARGIN_MS,
  /** POST /api/extract-facts = 120 + 30 = 150 秒。 */
  extractFacts: BACKEND_WORST_CASE_MS.extractFacts + CLIENT_DEADLINE_MARGIN_MS,
  /** POST /api/transcribe = 180 + 30 = 210 秒。 */
  transcribe: TRANSCRIBE_BUDGET_MS + CLIENT_DEADLINE_MARGIN_MS,
} as const

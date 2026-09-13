/**
 * 組み込みの会話トピック。**唯一の出典**(frontend の Home.vue もこれを読む)。
 *
 * frontend はトピックを **キー**(`daily` 等)のまま backend に送り、DB にもキーで
 * 保存している。v1.2.0 まではそのキーがそのままプロンプトに入っていたため、
 * 小型モデルが「"daily" について教えて」「daily は何日ですか」のように
 * **単語そのもの**について質問していた。プロンプトに入る直前で英語の説明へ
 * 置き換える。カスタムトピックはユーザーが言葉で書いたものなので素通しする。
 *
 * **このファイルは node/DOM の API を一切使わないこと**(backend と frontend の両方から読む)。
 */
export interface BuiltInTopic {
  /** 送信・保存に使うキー。変えると既存の会話履歴と噛み合わなくなるので変えないこと。 */
  key: string
  /** 画面表示ラベル。 */
  label: string
  /** プロンプトに入れる英語の説明。 */
  promptLabel: string
}

export const BUILT_IN_TOPICS: readonly BuiltInTopic[] = [
  { key: 'daily', label: '日常会話', promptLabel: 'daily life' },
  { key: 'business', label: 'ビジネス', promptLabel: 'work and business' },
  { key: 'travel', label: '旅行', promptLabel: 'travel' },
  { key: 'shopping', label: 'ショッピング', promptLabel: 'shopping' },
  { key: 'restaurant', label: 'レストラン', promptLabel: 'eating at restaurants' },
  { key: 'hobby', label: '趣味', promptLabel: 'hobbies' },
  { key: 'news', label: 'ニュース話題', promptLabel: 'recent news' },
]

/** キーなら英語の説明に、それ以外(カスタムトピック)はそのまま返す。 */
export function topicPromptLabel(topic: string): string {
  return BUILT_IN_TOPICS.find((t) => t.key === topic)?.promptLabel ?? topic
}

import { describe, expect, it } from 'vitest'
import type { Feedback } from '../db/types'
import { retryFeedbackPatch, storedFeedback } from './stored-feedback'

const TEMPLATE_A_NURSE = '数えられる名詞が 1 つのときは、「a nurse」のように前に「a」を付けます。'

describe('storedFeedback(履歴画面で保存済みの添削を検証し直す)', () => {
  it('組がフィルタを通る添削は、保存された説明ではなく今のテンプレートで作り直した説明を出す', () => {
    expect(
      storedFeedback({
        feedback: {
          userSaid: 'My sister is nurse.',
          corrected: 'My sister is a nurse.',
          // 以前のバージョンがモデルに書かせて保存した説明(英語)
          explanation: 'You need an article before "nurse".',
        },
      }),
    ).toEqual({
      userSaid: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: TEMPLATE_A_NURSE,
    })
  })

  it('前後の空白は落として判定する(grammar-check が保存した形と同じになる)', () => {
    expect(
      storedFeedback({
        feedback: {
          userSaid: '  My sister is nurse. ',
          corrected: 'My sister is a nurse.\n',
          explanation: '',
        },
      })?.explanation,
    ).toBe(TEMPLATE_A_NURSE)
  })

  it.each<[string, Feedback]>([
    [
      '言い換え(フィルタが拒否)',
      {
        userSaid: 'I like dogs very much.',
        corrected: 'I love dogs very much.',
        explanation: '“love” is more natural here.',
      },
    ],
    [
      '直しは正しいがテンプレートが無い(説明できない変更)',
      {
        userSaid: 'I play the tennis every Sunday.',
        corrected: 'I play tennis every Sunday.',
        explanation: '运动名称前不用冠词。',
      },
    ],
    [
      '正しい文を「直した」ことにしている(変更なし)',
      {
        userSaid: 'I usually take the train to work.',
        corrected: 'I usually take the train to work.',
        explanation: 'Good job!',
      },
    ],
    [
      '日本語の発話(添削の対象外)',
      {
        userSaid: '私は学生です',
        corrected: 'I am a student.',
        explanation: '英語で言いましょう',
      },
    ],
    [
      '3 語未満',
      { userSaid: 'sounds good', corrected: 'That sounds good.', explanation: '主語を補う' },
    ],
    [
      '直した文に日本語が混ざる',
      {
        userSaid: 'My sister is nurse.',
        corrected: 'My sister is 看護師.',
        explanation: '看護師です',
      },
    ],
  ])('モデルが書いた添削で組が通らないものは出さない: %s', (_label, feedback) => {
    expect(storedFeedback({ feedback })).toBeNull()
  })

  it('添削が無い / 壊れた行(インポートしたデータ)は null', () => {
    expect(storedFeedback({ feedback: null })).toBeNull()
    expect(
      storedFeedback({
        feedback: { userSaid: 'My sister is nurse.' } as unknown as Feedback,
      }),
    ).toBeNull()
    expect(
      storedFeedback({
        feedback: { userSaid: 1, corrected: 2, explanation: 3 } as unknown as Feedback,
      }),
    ).toBeNull()
  })
})

describe('retryFeedbackPatch(日本語訳の再取得で添削をどう書き込むか)', () => {
  const checked = {
    user_said: 'My sister is nurse.',
    corrected: 'My sister is a nurse.',
    explanation: TEMPLATE_A_NURSE,
  }
  const modelWritten: Feedback = {
    userSaid: 'I like dogs very much.',
    corrected: 'I love dogs very much.',
    explanation: '“love” is more natural here.',
  }

  it('検証を通らない保存済みの添削は無いものとして扱い、検証済みの添削で置き換える', () => {
    expect(retryFeedbackPatch({ feedback: modelWritten }, checked)).toEqual({
      feedback: {
        userSaid: 'My sister is nurse.',
        corrected: 'My sister is a nurse.',
        explanation: TEMPLATE_A_NURSE,
      },
    })
  })

  it('添削が無い行には検証済みの添削を書き込む', () => {
    expect(retryFeedbackPatch({ feedback: null }, checked)).toEqual({
      feedback: {
        userSaid: checked.user_said,
        corrected: checked.corrected,
        explanation: checked.explanation,
      },
    })
  })

  it('検証を通る添削が既にある行は書き換えない(頼まれたのは日本語訳)', () => {
    const existing: Feedback = {
      userSaid: 'I went to shopping yesterday.',
      corrected: 'I went shopping yesterday.',
      explanation: 'どうせ作り直すので何でもよい',
    }
    expect(storedFeedback({ feedback: existing })).not.toBeNull()
    expect(retryFeedbackPatch({ feedback: existing }, checked)).toEqual({})
  })

  it('backend が添削を返さなければ何も書かない', () => {
    expect(retryFeedbackPatch({ feedback: modelWritten }, null)).toEqual({})
    expect(retryFeedbackPatch({ feedback: null }, undefined)).toEqual({})
  })
})

import { describe, expect, it } from 'vitest'
import type { Feedback, Message } from '../db/types'
import { displayFeedbackMap, retryFeedbackPatch, storedFeedback } from './stored-feedback'

const TEMPLATE_A_NURSE = '数えられる名詞が 1 つのときは、「a nurse」のように前に「a」を付けます。'

type Row = Pick<Message, 'id' | 'role' | 'userText' | 'feedback'>

function userRow(id: string, userText: string | null): Row {
  return { id, role: 'user', userText, feedback: null }
}

function aiRow(id: string, feedback: Feedback | null): Row {
  return { id, role: 'ai', userText: null, feedback }
}

describe('storedFeedback(履歴画面で保存済みの添削を検証し直す)', () => {
  it('組がフィルタを通る添削は、保存された説明ではなく今のテンプレートで作り直した説明を出す', () => {
    expect(
      storedFeedback(
        {
          feedback: {
            userSaid: 'My sister is nurse.',
            corrected: 'My sister is a nurse.',
            // 以前のバージョンがモデルに書かせて保存した説明(英語)
            explanation: 'You need an article before "nurse".',
          },
        },
        'My sister is nurse.',
      ),
    ).toEqual({
      userSaid: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: TEMPLATE_A_NURSE,
    })
  })

  it('前後の空白は落として判定する(grammar-check が保存した形と同じになる)', () => {
    const shown = storedFeedback(
      {
        feedback: {
          userSaid: '  My sister is nurse. ',
          corrected: 'My sister is a nurse.\n',
          explanation: '',
        },
      },
      ' My sister is nurse.\n',
    )
    expect(shown?.explanation).toBe(TEMPLATE_A_NURSE)
    expect(shown?.userSaid).toBe('My sister is nurse.')
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
    // 引用が実際の発話と一致していても、組がフィルタを通らなければ出さない
    expect(storedFeedback({ feedback }, feedback.userSaid)).toBeNull()
  })

  it('正しく言ったのにモデルが間違った引用を作った添削は出さない(言ってもいない間違いを出さない)', () => {
    const invented: Feedback = {
      userSaid: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: 'You need an article before "nurse".',
    }
    expect(storedFeedback({ feedback: invented }, 'My sister is a nurse.')).toBeNull()
  })

  it('長い発話の一部だけを引用した添削は出さない', () => {
    const partial: Feedback = {
      userSaid: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: '',
    }
    const longUtterance =
      'Last weekend I visited my family in Osaka and we talked a lot about work because my sister is nurse and she works at a big hospital near the station.'
    expect(storedFeedback({ feedback: partial }, longUtterance)).toBeNull()
  })

  it('直前のユーザー発話が無ければ出さない', () => {
    const feedback: Feedback = {
      userSaid: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: '',
    }
    expect(storedFeedback({ feedback }, null)).toBeNull()
    expect(storedFeedback({ feedback }, undefined)).toBeNull()
  })

  it('添削が無い / 壊れた行(インポートしたデータ)は null', () => {
    expect(storedFeedback({ feedback: null }, 'My sister is nurse.')).toBeNull()
    expect(
      storedFeedback(
        { feedback: { userSaid: 'My sister is nurse.' } as unknown as Feedback },
        'My sister is nurse.',
      ),
    ).toBeNull()
    expect(
      storedFeedback(
        { feedback: { userSaid: 1, corrected: 2, explanation: 3 } as unknown as Feedback },
        'My sister is nurse.',
      ),
    ).toBeNull()
  })
})

describe('displayFeedbackMap(履歴画面の添削を 1 回の走査で作る)', () => {
  it('grammar-check の経路が保存した添削(user_said = 発話を trim したもの)は今のテンプレートで出る', () => {
    const map = displayFeedbackMap([
      aiRow('a0', null),
      userRow('u1', '  My sister is nurse. '),
      aiRow('a1', {
        userSaid: 'My sister is nurse.',
        corrected: 'My sister is a nurse.',
        explanation: '古いテンプレートの文面',
      }),
    ])
    expect(map.get('a1')).toEqual({
      userSaid: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: TEMPLATE_A_NURSE,
    })
    expect(map.get('a0')).toBeNull()
    expect(map.get('u1')).toBeNull()
  })

  it('正しく言った発話にモデルが間違った引用を作った行は出さない', () => {
    const map = displayFeedbackMap([
      userRow('u1', 'My sister is a nurse.'),
      aiRow('a1', {
        userSaid: 'My sister is nurse.',
        corrected: 'My sister is a nurse.',
        explanation: 'You need an article before "nurse".',
      }),
    ])
    expect(map.get('a1')).toBeNull()
  })

  it('長い発話の一部だけを引用した行は出さない', () => {
    const map = displayFeedbackMap([
      userRow(
        'u1',
        'Last weekend I visited my family in Osaka and we talked a lot about work because my sister is nurse and she works at a big hospital near the station.',
      ),
      aiRow('a1', {
        userSaid: 'My sister is nurse.',
        corrected: 'My sister is a nurse.',
        explanation: '',
      }),
    ])
    expect(map.get('a1')).toBeNull()
  })

  it('前にユーザー行が無い行は出さない', () => {
    const map = displayFeedbackMap([
      aiRow('a0', {
        userSaid: 'My sister is nurse.',
        corrected: 'My sister is a nurse.',
        explanation: '',
      }),
    ])
    expect(map.get('a0')).toBeNull()
  })

  it('各行はその行より前で最後のユーザー発話で判定する', () => {
    const feedback: Feedback = {
      userSaid: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: '',
    }
    const map = displayFeedbackMap([
      userRow('u1', 'My sister is nurse.'),
      aiRow('a1', feedback),
      userRow('u2', 'She works at a hospital.'),
      aiRow('a2', feedback),
    ])
    expect(map.get('a1')?.explanation).toBe(TEMPLATE_A_NURSE)
    expect(map.get('a2')).toBeNull()
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
    expect(
      retryFeedbackPatch({ feedback: modelWritten }, 'I like dogs very much.', checked),
    ).toEqual({
      feedback: {
        userSaid: 'My sister is nurse.',
        corrected: 'My sister is a nurse.',
        explanation: TEMPLATE_A_NURSE,
      },
    })
  })

  it('添削が無い行には検証済みの添削を書き込む', () => {
    expect(retryFeedbackPatch({ feedback: null }, 'My sister is nurse.', checked)).toEqual({
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
    const userText = 'I went to shopping yesterday.'
    expect(storedFeedback({ feedback: existing }, userText)).not.toBeNull()
    expect(retryFeedbackPatch({ feedback: existing }, userText, checked)).toEqual({})
  })

  it('引用が実際の発話と一致しない保存済みの添削は無いものとして扱い、置き換える', () => {
    const invented: Feedback = {
      userSaid: 'I went to shopping yesterday.',
      corrected: 'I went shopping yesterday.',
      explanation: '',
    }
    const actualChecked = {
      user_said: 'Yesterday I go shopping with my friend.',
      corrected: 'Yesterday I went shopping with my friend.',
      explanation: '過去の話',
    }
    expect(
      retryFeedbackPatch(
        { feedback: invented },
        'Yesterday I go shopping with my friend.',
        actualChecked,
      ),
    ).toEqual({
      feedback: {
        userSaid: actualChecked.user_said,
        corrected: actualChecked.corrected,
        explanation: actualChecked.explanation,
      },
    })
  })

  it('直前のユーザー発話が無い行の保存済みの添削も無いもの扱い', () => {
    const existing: Feedback = {
      userSaid: 'I went to shopping yesterday.',
      corrected: 'I went shopping yesterday.',
      explanation: '',
    }
    expect(retryFeedbackPatch({ feedback: existing }, null, checked)).toEqual({
      feedback: {
        userSaid: checked.user_said,
        corrected: checked.corrected,
        explanation: checked.explanation,
      },
    })
  })

  it('backend が添削を返さなければ何も書かない', () => {
    expect(retryFeedbackPatch({ feedback: modelWritten }, 'I like dogs very much.', null)).toEqual(
      {},
    )
    expect(retryFeedbackPatch({ feedback: null }, null, undefined)).toEqual({})
  })
})

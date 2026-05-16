import Dexie, { type Table } from 'dexie'
import type { Conversation, CustomTopic, Message, UserProfile, Vocabulary } from './types'

export class SpeakyDB extends Dexie {
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  vocabulary!: Table<Vocabulary, string>
  userProfile!: Table<UserProfile, 'main'>
  customTopics!: Table<CustomTopic, string>

  constructor() {
    super('SpeakyDB')
    this.version(1).stores({
      conversations: 'id, startedAt, endedAt, topic, level, expiresAt',
      messages: 'id, conversationId, timestamp, role',
      vocabulary: 'id, word, savedAt, partOfSpeech',
      userProfile: 'id',
      customTopics: 'id, name, createdAt',
    })
  }
}

export const db = new SpeakyDB()

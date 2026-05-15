import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { userProfileRepo } from '../db/repos/userProfile'
import type { UserProfile } from '../db/types'

export const useProfileStore = defineStore('profile', () => {
  const profile = ref<UserProfile | null>(null)
  const isLoaded = ref(false)

  const name = computed(() => profile.value?.name ?? null)
  const facts = computed(() => profile.value?.facts ?? [])

  async function load() {
    profile.value = await userProfileRepo.getOrCreate()
    isLoaded.value = true
  }

  async function setName(newName: string | null) {
    profile.value = await userProfileRepo.update({ name: newName })
  }

  async function addFact(input: {
    fact: string
    learnedFromConversationId: string | null
  }) {
    await userProfileRepo.addFact(input)
    profile.value = await userProfileRepo.getOrCreate()
  }

  async function removeFact(factId: string) {
    await userProfileRepo.removeFact(factId)
    profile.value = await userProfileRepo.getOrCreate()
  }

  async function updateFact(factId: string, fact: string) {
    await userProfileRepo.updateFact(factId, { fact })
    profile.value = await userProfileRepo.getOrCreate()
  }

  return {
    profile,
    isLoaded,
    name,
    facts,
    load,
    setName,
    addFact,
    removeFact,
    updateFact,
  }
})

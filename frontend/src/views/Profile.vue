<script setup lang="ts">
import { onMounted, ref } from 'vue'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import BaseInput from '../components/BaseInput.vue'
import { useProfileStore } from '../stores/profile'
import { useSettingsStore } from '../stores/settings'

const profile = useProfileStore()
const settings = useSettingsStore()

onMounted(() => profile.load())

const nameInput = ref('')
const editingName = ref(false)

function startEditName() {
  nameInput.value = profile.name ?? ''
  editingName.value = true
}

async function saveName() {
  await profile.setName(nameInput.value.trim() || null)
  editingName.value = false
}

async function removeFact(id: string) {
  if (!confirm('この項目を削除しますか?')) return
  await profile.removeFact(id)
}

const editingFactId = ref<string | null>(null)
const factEditInput = ref('')

function startEditFact(id: string, current: string) {
  editingFactId.value = id
  factEditInput.value = current
}

async function saveFact() {
  if (editingFactId.value && factEditInput.value.trim()) {
    await profile.updateFact(editingFactId.value, factEditInput.value.trim())
  }
  editingFactId.value = null
}

const aiNameInput = ref('')
const editingAiName = ref(false)

function startEditAiName() {
  aiNameInput.value = settings.settings.aiCharacter.name
  editingAiName.value = true
}

function saveAiName() {
  if (aiNameInput.value.trim()) {
    settings.update({
      aiCharacter: {
        name: aiNameInput.value.trim(),
        gender: settings.settings.aiCharacter.gender,
      },
    })
  }
  editingAiName.value = false
}

function setGender(g: 'female' | 'male') {
  settings.update({
    aiCharacter: {
      name: settings.settings.aiCharacter.name,
      gender: g,
    },
  })
}

function formatDate(d: Date): string {
  return new Date(d).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <h1 class="text-3xl font-bold">プロフィール</h1>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">あなたについて</div>
      <div class="mt-4">
        <div v-if="!editingName" class="flex items-center justify-between">
          <div>
            <div class="text-xs text-text-muted">名前</div>
            <div class="text-base">{{ profile.name || '(未設定)' }}</div>
          </div>
          <BaseButton variant="ghost" size="sm" @click="startEditName">
            編集
          </BaseButton>
        </div>
        <div v-else class="flex items-end gap-2">
          <div class="flex-1">
            <BaseInput v-model="nameInput" label="名前" />
          </div>
          <BaseButton size="sm" @click="saveName">保存</BaseButton>
          <BaseButton variant="ghost" size="sm" @click="editingName = false">
            キャンセル
          </BaseButton>
        </div>
      </div>

      <div class="mt-6">
        <div class="text-sm font-semibold">AIが学習したあなたのこと</div>
        <p class="mt-1 text-xs text-text-muted">
          会話の中からAIが自然に学習した情報。クリックで編集、削除できます。
        </p>
        <ul v-if="profile.facts.length > 0" class="mt-3 space-y-2">
          <li
            v-for="f in profile.facts"
            :key="f.id"
            class="rounded-lg bg-primary-light/40 px-3 py-2 text-sm"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1">
                <div v-if="editingFactId !== f.id">
                  <span>• {{ f.fact }}</span>
                  <div class="mt-1 text-[10px] text-text-muted">
                    {{ formatDate(f.learnedAt) }} の会話から学習
                  </div>
                </div>
                <input
                  v-else
                  v-model="factEditInput"
                  class="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                  @keyup.enter="saveFact"
                />
              </div>
              <div class="flex shrink-0 gap-2 text-xs">
                <template v-if="editingFactId === f.id">
                  <button
                    class="text-primary hover:underline"
                    @click="saveFact"
                  >
                    保存
                  </button>
                  <button
                    class="text-text-muted hover:underline"
                    @click="editingFactId = null"
                  >
                    キャンセル
                  </button>
                </template>
                <template v-else>
                  <button
                    class="text-primary hover:underline"
                    @click="startEditFact(f.id, f.fact)"
                  >
                    編集
                  </button>
                  <button
                    class="text-rose-500 hover:underline"
                    @click="removeFact(f.id)"
                  >
                    削除
                  </button>
                </template>
              </div>
            </div>
          </li>
        </ul>
        <p v-else class="mt-3 text-sm text-text-muted">
          まだ学習された情報はありません。会話を続けると自動的に蓄積されます。
        </p>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">AIキャラクター</div>
      <div class="mt-4 space-y-4">
        <div>
          <div v-if="!editingAiName" class="flex items-center justify-between">
            <div>
              <div class="text-xs text-text-muted">名前</div>
              <div class="text-base">
                {{ settings.settings.aiCharacter.name }}
              </div>
            </div>
            <BaseButton variant="ghost" size="sm" @click="startEditAiName">
              編集
            </BaseButton>
          </div>
          <div v-else class="flex items-end gap-2">
            <div class="flex-1">
              <BaseInput v-model="aiNameInput" label="名前" />
            </div>
            <BaseButton size="sm" @click="saveAiName">保存</BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              @click="editingAiName = false"
            >
              キャンセル
            </BaseButton>
          </div>
        </div>

        <div>
          <div class="text-xs text-text-muted">性別 / 声</div>
          <div class="mt-2 flex gap-2">
            <BaseButton
              :variant="
                settings.settings.aiCharacter.gender === 'female'
                  ? 'primary'
                  : 'secondary'
              "
              size="sm"
              @click="setGender('female')"
            >
              女性 (Samantha)
            </BaseButton>
            <BaseButton
              :variant="
                settings.settings.aiCharacter.gender === 'male'
                  ? 'primary'
                  : 'secondary'
              "
              size="sm"
              @click="setGender('male')"
            >
              男性 (Daniel)
            </BaseButton>
          </div>
        </div>
      </div>
    </BaseCard>
  </div>
</template>

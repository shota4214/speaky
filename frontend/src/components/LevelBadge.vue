<script setup lang="ts">
import { computed } from 'vue'

type Level = 'beginner' | 'intermediate' | 'advanced'

interface Props {
  level: Level
  size?: 'sm' | 'md' | 'lg'
  active?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  active: false,
})

const labelMap: Record<Level, { icon: string; ja: string }> = {
  beginner: { icon: '😊', ja: '初心者' },
  intermediate: { icon: '🙂', ja: '中級' },
  advanced: { icon: '😎', ja: '上級' },
}

const info = computed(() => labelMap[props.level])

const sizeClass = computed(() => {
  switch (props.size) {
    case 'sm':
      return 'px-2.5 py-1 text-xs'
    case 'md':
      return 'px-3 py-1.5 text-sm'
    case 'lg':
      return 'px-4 py-2 text-base'
    default:
      return ''
  }
})

const colorClass = computed(() =>
  props.active
    ? 'bg-primary text-white shadow-sm'
    : 'bg-primary-light text-primary-dark hover:bg-primary/30',
)
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full font-medium transition"
    :class="[sizeClass, colorClass]"
  >
    <span aria-hidden="true">{{ info.icon }}</span>
    <span>{{ info.ja }}</span>
  </span>
</template>
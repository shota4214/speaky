<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
  removable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  active: false,
  size: 'md',
  removable: false,
})

defineEmits<{
  (e: 'remove'): void
}>()

const sizeClass = computed(
  () => ({ sm: 'px-2.5 py-1 text-xs', md: 'px-3 py-1.5 text-sm' })[props.size],
)

const colorClass = computed(() =>
  props.active ? 'bg-accent text-white shadow-sm' : 'bg-accent/10 text-accent hover:bg-accent/20',
)
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full font-medium transition"
    :class="[sizeClass, colorClass]"
  >
    <span>#{{ label }}</span>
    <button
      v-if="removable"
      class="-mr-0.5 ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full opacity-60 hover:opacity-100"
      @click.stop="$emit('remove')"
    >
      ×
    </button>
  </span>
</template>

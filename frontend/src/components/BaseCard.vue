<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  padding?: 'none' | 'sm' | 'md' | 'lg'
  shadow?: 'none' | 'sm' | 'md' | 'lg'
  /** hover でほんのり浮く演出を有効にする */
  hoverable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  padding: 'md',
  shadow: 'md',
  hoverable: false,
})

const paddingClass = computed(() => ({ none: '', sm: 'p-3', md: 'p-6', lg: 'p-8' })[props.padding])
const shadowClass = computed(
  () => ({ none: '', sm: 'shadow-glow-sm', md: 'shadow-glow', lg: 'shadow-glow-lg' })[props.shadow],
)
const hoverClass = computed(() =>
  props.hoverable
    ? 'transition-all duration-200 ease-out hover:-translate-y-1 hover:shadow-glow-lg'
    : '',
)
</script>

<template>
  <div
    class="rounded-3xl bg-surface ring-1 ring-border"
    :class="[paddingClass, shadowClass, hoverClass]"
  >
    <slot />
  </div>
</template>

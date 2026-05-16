<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  padding?: 'none' | 'sm' | 'md' | 'lg'
  shadow?: 'none' | 'sm' | 'md' | 'lg'
}

const props = withDefaults(defineProps<Props>(), {
  padding: 'md',
  shadow: 'md',
})

const paddingClass = computed(() => ({ none: '', sm: 'p-3', md: 'p-6', lg: 'p-8' })[props.padding])
const shadowClass = computed(
  () => ({ none: '', sm: 'shadow-sm', md: 'shadow-md', lg: 'shadow-xl' })[props.shadow],
)
</script>

<template>
  <div class="rounded-2xl bg-surface ring-1 ring-border" :class="[paddingClass, shadowClass]">
    <slot />
  </div>
</template>

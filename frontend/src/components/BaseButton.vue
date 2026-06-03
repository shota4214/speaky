<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  disabled: false,
  type: 'button',
})

const variantClass = computed(() => {
  switch (props.variant) {
    case 'primary':
      return 'bg-primary hover:bg-primary-dark text-white shadow-glow hover:shadow-glow-lg'
    case 'secondary':
      return 'bg-primary-light hover:bg-primary/25 text-primary-dark shadow-glow-sm hover:shadow-glow'
    case 'ghost':
      return 'bg-transparent hover:bg-primary/10 text-text'
    case 'danger':
      return 'bg-rose-400 hover:bg-rose-500 text-white shadow-[0_8px_24px_-6px_rgba(244,63,94,0.4)]'
    default:
      return ''
  }
})

const sizeClass = computed(() => {
  switch (props.size) {
    case 'sm':
      return 'px-4 py-1.5 text-sm'
    case 'md':
      return 'px-5 py-2 text-sm'
    case 'lg':
      return 'px-7 py-3 text-base'
    default:
      return ''
  }
})
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition-all duration-150 ease-out hover:-translate-y-0.5 active:translate-y-0.5 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100"
    :class="[variantClass, sizeClass]"
  >
    <slot />
  </button>
</template>

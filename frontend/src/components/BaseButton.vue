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
      return 'bg-primary hover:bg-primary-dark text-white shadow-sm'
    case 'secondary':
      return 'bg-primary-light hover:bg-primary/20 text-primary-dark'
    case 'ghost':
      return 'bg-transparent hover:bg-primary/10 text-text'
    case 'danger':
      return 'bg-rose-500 hover:bg-rose-600 text-white shadow-sm'
    default:
      return ''
  }
})

const sizeClass = computed(() => {
  switch (props.size) {
    case 'sm':
      return 'px-3 py-1.5 text-sm rounded-lg'
    case 'md':
      return 'px-4 py-2 text-sm rounded-xl'
    case 'lg':
      return 'px-6 py-3 text-base rounded-xl'
    default:
      return ''
  }
})
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="inline-flex items-center justify-center gap-1.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
    :class="[variantClass, sizeClass]"
  >
    <slot />
  </button>
</template>

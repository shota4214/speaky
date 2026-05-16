<script setup lang="ts">
interface Props {
  modelValue?: string
  type?: string
  placeholder?: string
  disabled?: boolean
  label?: string
  hint?: string
  error?: string
}

withDefaults(defineProps<Props>(), {
  modelValue: '',
  type: 'text',
  placeholder: '',
  disabled: false,
  label: '',
  hint: '',
  error: '',
})

defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()
</script>

<template>
  <label class="block">
    <span v-if="label" class="text-sm font-medium text-text">{{ label }}</span>
    <input
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      class="mt-1 block w-full rounded-xl border-0 bg-surface px-3 py-2 text-text shadow-sm ring-1 ring-inset ring-border placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
      :class="error ? 'ring-rose-400 focus:ring-rose-500' : ''"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span v-if="error" class="mt-1 block text-xs text-rose-500">{{ error }}</span>
    <span v-else-if="hint" class="mt-1 block text-xs text-text-muted">{{ hint }}</span>
  </label>
</template>
